// Sweep stage 3: screen configs by full net + quarter-split (4x ~6h slices).
// A config is robust only if full net is clearly positive AND >=3/4 quarters positive.
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', 'dev', ds.sha256));
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
const quarters: Dataset[] = [];
for (let q = 0; q < 4; q++) {
  const seg = ds.events.slice(cuts[q], cuts[q + 1]);
  const segMints = new Set(seg.map((e: any) => e.mint));
  const creates: any[] = [];
  const seen = new Set<string>();
  for (const e of ds.events.slice(0, cuts[q])) {
    if (e.event === 'CreateEvent' && segMints.has(e.mint) && !seen.has(e.mint)) { seen.add(e.mint); creates.push(e); }
  }
  quarters.push(toDataset([...creates, ...seg], cuts[q + 1] < n ? ds.events[cuts[q + 1]].slot : ds.endSlot));
}

const grid: Partial<Params>[] = [
  {},
  { maxAge: 200 }, { maxAge: 400 }, { maxAge: 150 }, { minAge: 20 },
  { confirmWindow: 20 }, { confirmWindow: 80 },
  { dipPct: 0.3, dumpMaxSlots: 20 }, { dipPct: 0.4, dumpMaxSlots: 30 },
  { minRunup: 1.0 }, { minRunup: 0.2 },
  { trailArm: 0.02, trail: 0.02 }, { takeProfit: 0.04, stopLoss: 0.08 },
];
for (const over of grid) {
  const params: Params = { ...DEFAULT_PARAMS, ...over };
  const full = simulate(ds, hello, createStrategy(params));
  const qs: number[] = [];
  for (const qd of quarters) qs.push(sol(simulate(qd, hello, createStrategy(params)).netPnl));
  const posQ = qs.filter((x) => x > 0).length;
  console.log(`full ${sol(full.netPnl).toFixed(4)} coins ${full.mints} posQ ${posQ}/4 [${qs.map((x) => x.toFixed(3)).join(', ')}] ${JSON.stringify(over)}`);
}
