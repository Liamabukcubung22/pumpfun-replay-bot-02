// Parameter sweep for strategy.ts on the dev window (scratch, NOT shipped).
// Loads the dataset once, runs every combo, prints the top 25 by net PnL.
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', 'dev', ds.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

const results: { net: number; trips: number; wins: number; dd: number; params: Partial<Params> }[] = [];
let n = 0;
for (const dipPct of [0.15, 0.25, 0.35]) {
  for (const dumpMaxSlots of [6, 12, 25]) {
    for (const confirmBounce of [0, 0.05, 0.1]) {
      for (const takeProfit of [0.06, 0.12, 0.25]) {
        for (const stopLoss of [0.06, 0.12]) {
          for (const maxHold of [30, 90]) {
            const params: Params = { ...DEFAULT_PARAMS, dipPct, dumpMaxSlots, confirmBounce, takeProfit, stopLoss, maxHold };
            const r = simulate(ds, hello, createStrategy(params));
            const wins = r.trips.filter((t) => t.pnl > 0n).length;
            results.push({ net: sol(r.netPnl), trips: r.trips.length, wins, dd: r.maxDrawdown, params: { dipPct, dumpMaxSlots, confirmBounce, takeProfit, stopLoss, maxHold } });
            n++;
          }
        }
      }
    }
  }
}
results.sort((a, b) => b.net - a.net);
console.log(`ran ${n} combos`);
for (const r of results.slice(0, 25)) {
  console.log(`net ${r.net.toFixed(4)} trips ${r.trips} wins ${r.wins} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.params)}`);
}
console.log('--- worst 5 ---');
for (const r of results.slice(-5)) {
  console.log(`net ${r.net.toFixed(4)} trips ${r.trips} wins ${r.wins} ${JSON.stringify(r.params)}`);
}
