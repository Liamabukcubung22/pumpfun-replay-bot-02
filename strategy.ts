// Snap-back mean reversion for the pump.fun bonding-curve replay.
//
// What the dev window teaches (measured on the 2-3 Nov 2026 window, 1222 coins):
// - Buying a dip and holding loses: after a -15% dip the average forward return
//   is still about -15% at 30-120 slots. Coins decay; catching a falling knife pays
//   the decay.
// - But bounces are real and frequent: after a -15% dip, 36-43% of coins print
//   +10% off the dip within 60 slots, and the bounce is much more likely after a
//   FAST dump (peak -> dip in <=10 slots: 42-47% win rate at TP+10/SL-10) than
//   after a slow bleed (23-28%). A fast dump is an overreaction; a slow bleed is
//   a trend.
// - So this bot only buys fast dumps that follow a real pump, and only after the
//   low has stopped falling: it waits for a small bounce off the low plus fresh
//   buy flow stepping in, then exits fast on a take-profit, a stop, a trailing
//   stop armed once the ticket is up, or a short time limit. It never holds a
//   dip hoping it comes back.
//
// Deterministic by construction: no clock, no randomness, no network, no files;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  maxAge: number;
  /** Peak price over the create price, minus 1: at least this (the dump follows a real pump). */
  minRunup: number;
  /** Fall from the running peak that marks a dip, as a fraction. */
  dipPct: number;
  /** The peak -> dip move must happen within this many slots (fast dump = overreaction). */
  dumpMaxSlots: number;
  /** Price must have bounced this far off the dip low before entry (the low stopped falling). */
  confirmBounce: number;
  /** Entry is only allowed this many slots after the dip low. */
  confirmWindow: number;
  /** Price at entry must still be this far below the peak, as a fraction (don't chase a recovery). */
  minDipRemaining: number;
  /** Distinct non-creator buyers since the dip low: at least this many. */
  minBuyersAfterLow: number;
  /** Net buy SOL (buys minus sells) since the dip low: at least this. */
  minNetBuySol: number;
  /** SOL to put into one position (capped by the per-order reserve cap). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell everything once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Allow a fresh dip-buy on a coin already traded, after a cooldown. */
  allowReentry: boolean;
  /** Slots after an exit before the same coin may be bought again. */
  reentryCooldown: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 3,
  maxAge: 900,
  minRunup: 0.5,
  dipPct: 0.35,
  dumpMaxSlots: 25,
  confirmBounce: 0.1,
  confirmWindow: 40,
  minDipRemaining: 0.08,
  minBuyersAfterLow: 1,
  minNetBuySol: 0,
  stakeSol: 0.2,
  minBuySol: 0.005,
  buySlipBps: 10_000,
  stopLoss: 0.12,
  trail: 0.05,
  trailArm: 0.05,
  takeProfit: 0.06,
  maxHold: 90,
  exitOnDevSell: true,
  allowReentry: true,
  reentryCooldown: 60,
  targetCoins: 21,
  targetFills: 50,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  created: number;
  creator: string;
  p0: number;
  peak: number;
  peakSlot: number;
  /** Lowest price since the running peak; reset whenever a new peak prints. */
  low: number;
  lowSlot: number;
  /** Buy flow since the dip low (reset whenever a new low prints). */
  buyersAfterLow: Set<string>;
  netBuyAfterLow: number;
  devSold: boolean;
  done: boolean;
  lastExitSlot: number | null;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, e: { slot: number; creator: string; virtual_quote_reserves: string; virtual_token_reserves: string }): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      const p0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      c = {
        created: e.slot,
        creator: e.creator,
        p0,
        peak: p0,
        peakSlot: e.slot,
        low: p0,
        lowSlot: e.slot,
        buyersAfterLow: new Set(),
        netBuyAfterLow: 0,
        devSold: false,
        done: false,
        lastExitSlot: null,
      };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint, e);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (price > c.peak) {
            c.peak = price;
            c.peakSlot = e.slot;
            c.low = price;
            c.lowSlot = e.slot;
            c.buyersAfterLow = new Set();
            c.netBuyAfterLow = 0;
          } else if (price < c.low) {
            c.low = price;
            c.lowSlot = e.slot;
            c.buyersAfterLow = new Set();
            c.netBuyAfterLow = 0;
          }
          if (e.is_buy) {
            c.netBuyAfterLow += sol;
            if (e.user !== c.creator) c.buyersAfterLow.add(e.user);
          } else {
            c.netBuyAfterLow -= sol;
            if (e.user === c.creator) c.devSold = true;
          }
          traded.add(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coins.get(mint);
            if (c !== undefined) c.lastExitSlot = now;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell) {
          const c = coins.get(mint);
          if (c !== undefined && c.devSold) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: one snap-back ticket per coin whose fast dump has stopped falling.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined) continue;
        if (c.done) {
          if (!p.allowReentry || c.lastExitSlot === null || now - c.lastExitSlot < p.reentryCooldown) continue;
          // Fresh dip cycle: the old peak/low no longer describes this coin.
          c.done = false;
        }
        const age = now - c.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (c.devSold) continue;
        // The dump must follow a real pump.
        if (c.p0 <= 0 || c.peak / c.p0 - 1 < p.minRunup) continue;
        // The dip must be deep and fast.
        if (c.low > c.peak * (1 - p.dipPct)) continue;
        if (c.lowSlot - c.peakSlot > p.dumpMaxSlots) continue;
        // Entry only shortly after the low, once price bounced off it, still deep.
        if (now - c.lowSlot > p.confirmWindow) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price < c.low * (1 + p.confirmBounce)) continue;
        if (price > c.peak * (1 - p.minDipRemaining)) continue;
        // Fresh buy flow must be stepping in after the low.
        if (c.buyersAfterLow.size < p.minBuyersAfterLow) continue;
        if (c.netBuyAfterLow < p.minNetBuySol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        c.done = true;
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false, lastValue: 0 });
        free -= amount + tx;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
