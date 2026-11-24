// Quarter-split: 4 chronological ~6h slices of the dev window (closest analog to the
// 6h final window). Reports net per quarter for one param set (scratch, NOT shipped).
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
const overrides = process.argv[3] !== undefined ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', 'dev', ds.sha256));
const params: Params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => Number(x) / 1e9;

function toDataset(events: any[], endSlot: number): Dataset {
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { ...ds, events, batches, endSlot };
}

const n = ds.events.length;
const cuts = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n];
for (let q = 0; q < 4; q++) {
  const seg = ds.events.slice(cuts[q], cuts[q + 1]);
  const segMints = new Set(seg.map((e: any) => e.mint));
  const creates: any[] = [];
  const seen = new Set<string>();
  for (const e of ds.events.slice(0, cuts[q])) {
    if (e.event === 'CreateEvent' && segMints.has(e.mint) && !seen.has(e.mint)) {
      seen.add(e.mint);
      creates.push(e);
    }
  }
  const d = toDataset([...creates, ...seg], cuts[q + 1] < n ? ds.events[cuts[q + 1]].slot : ds.endSlot);
  const r = simulate(d, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const sorted = [...r.trips].sort((a, b) => Number(b.pnl - a.pnl));
  const top3 = sol(sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0n));
  console.log(`Q${q + 1}: net ${sol(r.netPnl).toFixed(4)} trips ${r.trips.length} wins ${wins} coins ${r.mints} dd ${r.maxDrawdown.toFixed(4)} top3 ${top3.toFixed(4)} net-top3 ${(sol(r.netPnl) - top3).toFixed(4)}`);
}
