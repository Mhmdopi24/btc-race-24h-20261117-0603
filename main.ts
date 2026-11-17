// Capitulation Recovery + Range Sleeve — BTC dip-buying bot for
// agent-fun/bars-replay/v1. Long only, no leverage, deterministic.
// Strategy: buy sharp dips (price well below its 30-bar reference) in
// small slices, sell slices into recovery, hard stop-loss, and a
// trend filter that refuses to keep buying into a sustained slide.
// All decisions use only bar closes seen so far; no clock, no network.
import * as readline from "node:readline";

// ---- Tunable parameters (chosen from the dev window, mid-plateau) ----
const LOOKBACK = 30; // bars for the dip reference
const DIP_BPS = 60; // buy when close is >= 0.60% below the 30-bar-ago close
const DIP_DEEP_BPS = 120; // deeper dip: buy a bigger slice
const SLICE_BPS = 2500; // normal buy = 25% of cash
const DEEP_SLICE_BPS = 4000; // deep-dip buy = 40% of cash
const BUY_COOLDOWN = 10; // bars between buys
const TAKE_PROFIT_BPS = 60; // sell half when +0.60% above average cost
const TAKE_ALL_BPS = 120; // sell everything when +1.20% above cost
const STOP_LOSS_BPS = 90; // sell everything when -0.90% below cost
const TREND_BLOCK_BPS = -250; // skip buys if 60-bar return < -2.50%
const TREND_LOOKBACK = 60;
const WARMUP = 60; // bars of history before any trade
const NO_BUY_TAIL = 45; // do not open new positions in the last N bars
const MAX_SLIPPAGE_BPS = 200;
const MIN_NOTIONAL = 1000000; // 1 USDC in quote units (scale 6)

interface Bar {
  c: bigint;
}

let priceScale = 6;
let qtyScale = 8;
let quoteScale = 6;
let seed = "0";
let barCount = 0;
let totalBars = 1440;

const closes: bigint[] = [];
let lastBuyBar = -10000;
let orderSeq = 0;

// Average cost of the current position, tracked from fills.
let avgCost: bigint | null = null; // price units
let heldQty = 0n;

function pctDropBps(now: bigint, ref: bigint): number {
  // (now - ref) / ref in bps, integer math, ref > 0.
  return Number(((now - ref) * 10000n) / ref);
}

function updateCostFromFills(fills: any[]): void {
  for (const f of fills ?? []) {
    if (f.status !== "filled") continue;
    const qty = BigInt(f.qty ?? "0");
    const price = BigInt(f.price ?? "0");
    if (qty === 0n || price === 0n) continue;
    if (f.side === "buy") {
      if (avgCost === null || heldQty === 0n) {
        avgCost = price;
        heldQty = qty;
      } else {
        avgCost = (avgCost * heldQty + price * qty) / (heldQty + qty);
        heldQty += qty;
      }
    } else {
      heldQty -= qty;
      if (heldQty <= 0n) {
        heldQty = 0n;
        avgCost = null;
      }
    }
  }
}

function decideOrders(
  close: bigint,
  cash: bigint,
  posQty: bigint,
): any[] {
  const orders: any[] = [];
  const n = closes.length;
  if (n < WARMUP) return orders;
  if (barCount > totalBars - NO_BUY_TAIL && posQty === 0n) return orders;

  // --- Sells first: take profit in slices, hard stop-loss. ---
  // A sell must be worth at least 1 USDC at the latest close unless it
  // empties the position, so never send a dust half-sell: when the half
  // would be worth less than that, sell the whole remainder instead.
  // (Without this guard a rejected dust sell repeats every bar and the
  // bot never gets back to buying.)
  if (posQty > 0n && avgCost !== null) {
    const posValue = (posQty * close) / 10000000n; // micro-USDC
    const sellAll = (): any => ({
      side: "sell",
      client_id: `sellall-${barCount}`,
      symbol: "CBBTC",
      qty: posQty.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    const sellHalf = (): any | null => {
      const half = posQty / 2n;
      if (half <= 0n) return sellAll();
      const halfValue = (half * close) / 10000000n;
      if (halfValue < BigInt(MIN_NOTIONAL)) return sellAll();
      return {
        side: "sell",
        client_id: `takehalf-${barCount}`,
        symbol: "CBBTC",
        qty: half.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
    };
    const gainBps = pctDropBps(close, avgCost); // positive = profit
    if (gainBps <= -STOP_LOSS_BPS) {
      orders.push(sellAll());
      return orders;
    }
    if (gainBps >= TAKE_ALL_BPS) {
      orders.push(sellAll());
      return orders;
    }
    if (gainBps >= TAKE_PROFIT_BPS) {
      const o = sellHalf();
      if (o) orders.push(o);
      return orders;
    }
    // Dust cleanup: a leftover position too small to ever sell in
    // slices is exited whole once it is in profit at all.
    if (posValue < BigInt(MIN_NOTIONAL) * 2n && gainBps > 0) {
      orders.push(sellAll());
      return orders;
    }
  }

  // --- Buys: dip below the 30-bar-ago close, trend filter on. ---
  if (barCount > totalBars - NO_BUY_TAIL) return orders;
  if (barCount - lastBuyBar < BUY_COOLDOWN) return orders;
  if (cash < BigInt(MIN_NOTIONAL) * 2n) return orders;

  const ref = closes[n - LOOKBACK];
  const dipBps = -pctDropBps(close, ref); // positive when price fell
  if (dipBps < DIP_BPS) return orders;

  // Trend filter: do not buy into a sustained 60-bar slide.
  const ref60 = closes[n - TREND_LOOKBACK];
  const trendBps = pctDropBps(close, ref60);
  if (trendBps < TREND_BLOCK_BPS) return orders;

  // Also require the dip to be real versus the recent range, not just
  // a slow drift: price must sit below its 30-bar average.
  let sum = 0n;
  for (let i = n - LOOKBACK; i < n; i++) sum += closes[i];
  const mean30 = sum / BigInt(LOOKBACK);
  if (close >= mean30) return orders;

  const sliceBps = dipBps >= DIP_DEEP_BPS ? DEEP_SLICE_BPS : SLICE_BPS;
  let spend = (cash * BigInt(sliceBps)) / 10000n;
  if (spend < BigInt(MIN_NOTIONAL)) return orders;
  if (spend > cash) spend = cash;
  orderSeq += 1;
  lastBuyBar = barCount;
  orders.push({
    side: "buy",
    client_id: `dip-${barCount}-${orderSeq}`,
    symbol: "CBBTC",
    notional_quote_units: spend.toString(),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  });
  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      const sym = (msg.symbols ?? []).find((s: any) => s.symbol === "CBBTC");
      if (sym) {
        priceScale = sym.price_scale ?? 6;
        qtyScale = sym.qty_scale ?? 8;
      }
      quoteScale = msg.capital?.quote_scale ?? 6;
      seed = msg.seed ?? "0";
      void priceScale;
      void qtyScale;
      void quoteScale;
      void seed;
      continue;
    }
    if (msg.type === "done") {
      break;
    }
    if (msg.type !== "batch") continue;

    barCount += 1;
    updateCostFromFills(msg.fills ?? []);

    const bar = (msg.bars ?? []).find((b: any) => b.symbol === "CBBTC");
    const account = msg.account ?? {};
    const cash = BigInt(account.cash_quote_units ?? "0");
    const pos = (account.positions ?? []).find((p: any) => p.symbol === "CBBTC");
    const posQty = pos ? BigInt(pos.qty ?? "0") : 0n;
    // Re-sync held quantity with the account (fills already applied).
    heldQty = posQty;
    if (heldQty === 0n) avgCost = null;

    let orders: any[] = [];
    if (bar) {
      const close = BigInt(bar.c);
      closes.push(close);
      orders = decideOrders(close, cash, posQty);
    }
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
    );
  }
}

main().catch(() => process.exit(1));
