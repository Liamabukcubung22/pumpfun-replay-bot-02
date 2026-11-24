// Robustness: full-window, split-half (first/second half of the dev window),
// and net-without-top-3 for one param set (scratch, NOT shipped).
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
const overrides = process.argv[3] !== undefined ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', 'dev', ds.sha256));
const params: Params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => Number(x) / 1e9;

function report(name: string, d: Dataset) {
  const r = simulate(d, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const sorted = [...r.trips].sort((a, b) => Number(b.pnl - a.pnl));
  const top3 = sol(sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0n));
  console.log(`${name}: net ${sol(r.netPnl).toFixed(4)} trips ${r.trips.length} wins ${wins} coins ${r.mints} dd ${r.maxDrawdown.toFixed(4)} top3 ${top3.toFixed(4)} net-top3 ${(sol(r.netPnl) - top3).toFixed(4)}`);
}

function toDataset(events: any[], endSlot: number): Dataset {
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { ...ds, events, batches, endSlot };
}

report('FULL       ', ds);
const halfIdx = Math.floor(ds.events.length / 2);
const splitSlot = ds.events[halfIdx].slot;
report('FIRST HALF ', toDataset(ds.events.slice(0, halfIdx), splitSlot));
// Second half: prepend the CreateEvent of every mint traded in the second half.
const secondEvents = ds.events.slice(halfIdx);
const secondMints = new Set(secondEvents.map((e: any) => e.mint));
const creates: any[] = [];
const seen = new Set<string>();
for (const e of ds.events.slice(0, halfIdx)) {
  if (e.event === 'CreateEvent' && secondMints.has(e.mint) && !seen.has(e.mint)) {
    seen.add(e.mint);
    creates.push(e);
  }
}
report('SECOND HALF', toDataset([...creates, ...secondEvents], ds.endSlot));
