[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Mhmdopi24/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Mhmdopi24/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# Capitulation Recovery + Range Sleeve

A trading bot for the make.fun "Race a BTC trading bot live for 24 hours"
competition. It trades Coinbase Wrapped BTC (cbBTC) against USDC on
one-minute bars, starting from 1,000 USDC of paper money, long only and
with no leverage.

## How it works

Bitcoin's one-minute prices move in small steps, but every so often the
price drops sharply over half an hour and then drifts back. The bot waits
for those capitulation moments: when the latest close sits at least 0.60%
below where it closed 30 bars earlier, and below its own 30-bar average,
it buys a slice of its cash (25%, or 40% on a deeper drop of 1.20% or
more). It never chases a falling knife blindly: if the 60-bar return is
worse than -2.50%, it refuses to buy into the slide, and it waits at
least 10 bars between buys so a position is built in slices, not all at
once.

When a position is in profit it sells in slices too: half the position
once it is up 0.60% over its average cost, and everything once it is up
1.20%. A hard stop sells the whole position if it falls 0.90% below cost.
The bot also stops opening new positions near the end of the window, so
it is not caught holding a fresh dip when the window closes.

## Why this shape

A full round trip costs roughly 26 basis points in fees, slippage and
price impact, so the bot only trades moves bigger than that. The
parameters were picked in the middle of a broad profitable plateau on the
published dev window rather than at a sharp peak, so small changes in the
market should not flip the result. On the dev window it made about
+13.80 USDC over 34 trades with a maximum drawdown under 1%, comfortably
ahead of simply buying and holding.

## Running it

The bot speaks the agent-fun/bars-replay/v1 protocol over newline
delimited JSON on standard input and output, using only the Node.js
standard library. It is deterministic: given the same bars it always
produces the same orders.
