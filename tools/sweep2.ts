// Sweep stage 2: refine around the positive region; test stake size, probe on/off,
// minRunup, confirmWindow, deeper dips, stronger bounces, no-TP (trail only).
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', 'dev', ds.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

const results: { net: number; trips: number; wins: number; coins: number; dd: number; top3: number; params: Partial<Params> }[] = [];
const base: Params = { ...DEFAULT_PARAMS, dipPct: 0.35, dumpMaxSlots: 25, confirmBounce: 0.1, takeProfit: 0.06, stopLoss: 0.12, maxHold: 90 };
const grid: Partial<Params>[] = [];
for (const stakeSol of [0.05, 0.1, 0.2]) {
  for (const maxProbes of [0, 1]) {
    for (const dipPct of [0.35, 0.45]) {
      for (const confirmBounce of [0.1, 0.15]) {
        grid.push({ stakeSol, maxProbes, dipPct, confirmBounce });
      }
    }
  }
}
for (const minRunup of [0.3, 1.0, 2.0]) grid.push({ minRunup });
for (const confirmWindow of [20, 80]) grid.push({ confirmWindow });
for (const takeProfit of [0.03, 0.1, 100]) grid.push({ takeProfit });
for (const stopLoss of [0.08, 0.2]) grid.push({ stopLoss });
for (const dumpMaxSlots of [15, 40]) grid.push({ dumpMaxSlots });
for (const minBuyersAfterLow of [2, 3]) grid.push({ minBuyersAfterLow });
for (const minNetBuySol of [0.05, 0.2]) grid.push({ minNetBuySol });

for (const over of grid) {
  const params: Params = { ...base, ...over };
  const r = simulate(ds, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const sorted = [...r.trips].sort((a, b) => Number(b.pnl - a.pnl));
  const top3 = sol(sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0n));
  results.push({ net: sol(r.netPnl), trips: r.trips.length, wins, coins: r.mints, dd: r.maxDrawdown, top3, params: over });
}
results.sort((a, b) => b.net - a.net);
console.log(`ran ${grid.length} combos`);
for (const r of results.slice(0, 30)) {
  console.log(`net ${r.net.toFixed(4)} trips ${r.trips} wins ${r.wins} coins ${r.coins} dd ${r.dd.toFixed(3)} top3 ${r.top3.toFixed(4)} net-top3 ${(r.net - r.top3).toFixed(4)} ${JSON.stringify(r.params)}`);
}
