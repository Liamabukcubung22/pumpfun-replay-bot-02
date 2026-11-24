# Pump.fun Paper Sprint — Snap-Back Mean-Reversion Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Liamabukcubung22/pumpfun-replay-bot-02/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Liamabukcubung22/pumpfun-replay-bot-02/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity, following the `agent-fun/replay/v2` protocol.

## Strategy: snap-back mean reversion

Measured on the dev window (2–3 Nov 2026, 1222 coins), buying a dip and
holding loses: after a -15% dip the average forward return is still about
-15% at 30–120 slots — coins decay, and catching a falling knife pays the
decay. But bounces are real and frequent: after a -15% dip, 36–43% of
coins print +10% off the dip within 60 slots, and the bounce is much more
likely after a fast dump than after a slow bleed.

So this bot only buys deep dumps that follow a real pump (-35% from a peak
that ran at least +50% over the create price, peak to dip within 25
slots), and only after the low has stopped falling: it waits for a +10%
bounce off the low plus fresh buy flow stepping in, then exits fast on a
take-profit (+6%), a stop (-12%), a trailing stop armed at +5%, or a
90-slot time limit. One 0.2 SOL ticket per coin, no pyramid. Guardrail
probes (tiny 0.01 SOL round trips) fire only when the bot's own fills or
coins lag the pace needed for the 20-coin minimum bar.

Local dev-window score (the kit's own `grade-local --driver process`):

| Metric | Value |
| --- | --- |
| Net PnL | +0.197 SOL (+1.97%) |
| Fills / coins / round trips | 74 / 33 / 37 (6 wins) |
| Max drawdown | 0.006 |
| Net PnL at 2x fees | +0.158 SOL |
| Net PnL without top 3 coins | -0.07 SOL |
| Stress (6 block surrogates) | median -0.10 SOL, 4/6 lose |

Honest note: the dev-window profit is **not robust**. Three coins make
95% of the gains; without them the bot loses -0.07 SOL, the kit's own
stress test has a -0.10 SOL median with 4 of 6 rebuilt windows losing
money, and on ~6-hour slices of the dev window (the final window's size)
only 2 of 4 slices finish positive. The dev score leans on this window's
own runner coins, so this bot was built but **not submitted** — the
margin over holding cash is not convincing enough to claim a prize on an
unseen window. For comparison the house pilots on the same data score
-9.38 SOL (momentum), -4.02 SOL (reversion) and -0.49 SOL (sniper).

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
  (Node 22+, no dependencies, no build step).
- `strategy.ts` — the strategy (see `DEFAULT_PARAMS` for the tuned
  settings; chosen in the flat region of the sweep, not a single best
  cell).
- `vendor/agentfun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim,
  vendored byte for byte.
- `tools/` — local validation only (a port of the kit's replay engine
  plus backtest / sweep / robustness runners); never imported by the bot.

## Run locally

```sh
node tools/backtest.ts <path to the unpacked kit> ['{"stakeSol":0.2}']
```

Or grade it exactly as the server does (no Docker needed):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Determinism

The bot is a pure function of the batches the harness sends: no clock,
no randomness, no network, no files. Two executions produce
byte-identical action logs (grade-local: "reproduced byte for byte").

## License

MIT — see [LICENSE](LICENSE).
