/**
 * The simulation's shadow books: every event the contracts emit is checked
 * against sim/model.ts as it happens (fill round, fill price, fees, funding,
 * payouts, settlement), and the simulation's own running totals are compared
 * with the contracts' totals and token balances after every transaction.
 *
 * A broken rule is recorded as a Violation with the transaction and time,
 * never thrown, so one run reports everything it finds.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

import type { DecodedLog, TxResult } from './chain.ts';
import {
  clamp,
  closeAmounts,
  escrowForOpen,
  expectedOpen,
  expectedOptionFill,
  fee,
  fillRound,
  FundingModel,
  indexAt,
  maxPayoutCents,
  openTerms,
  payoffCents,
  reserveForOrder,
  value,
  type Band,
  type PublishedRound,
  type QuoteCents,
} from './model.ts';

export interface Violation {
  check: string;
  detail: string;
  ts: number;
  tx?: Hex;
  phase: string;
}

export interface PerpOrder {
  id: number;
  account: Address;
  createdAt: number;
  isOpen: boolean;
  isLong: boolean;
  size: bigint;
  limit: bigint;
  positionId: number;
  escrow: bigint;
  reserveHeld: bigint;
  pending: boolean;
  outcome?: string;
  resolvedAt?: number;
}

export interface Position {
  id: number;
  account: Address;
  isLong: boolean;
  size: bigint;
  entry: bigint;
  collateral: bigint;
  reserve: bigint;
  open: boolean;
  closeOrderId: number;
  openedAt: number;
}

export interface PoolRequest {
  id: number;
  account: Address;
  createdAt: number;
  isDeposit: boolean;
  amount: bigint;
  pending: boolean;
  outcome?: string;
}

export interface OptOrder {
  id: number;
  account: Address;
  createdAt: number;
  dayKey: number;
  isBuy: boolean;
  isCall: boolean;
  strike: bigint;
  limit: bigint;
  size: bigint;
  escrow: bigint;
  pending: boolean;
  outcome?: string;
}

export interface Series {
  id: Hex;
  dayKey: number;
  strike: bigint;
  isCall: boolean;
  openSize: bigint;
  premiumOpen: bigint;
  settled: boolean;
  voided: boolean;
  payoff: bigint;
  holders: Record<string, { bal: bigint; paid: bigint }>;
}

export interface QuoteVersion {
  version: number;
  time: number;
  quotes: Record<string, QuoteCents>;
}

export interface PoolFillDeviation {
  requestId: number;
  isDeposit: boolean;
  ts: number;
  waitedSeconds: number;
  /** Units the request got beyond (or short of) its fair share at its fill round. */
  vsFillRound: bigint;
  /** Same, against the pool's value at the latest index when it executed. */
  vsNow: bigint;
}

export interface LedgerState {
  rounds: PublishedRound[];
  feedPaused: boolean;
  perpPaused: boolean;
  optionsPaused: boolean;
  feeBps: bigint;
  maxFunding: bigint;
  perpOrderTimeout: number;
  optOrderTimeout: number;
  perp: {
    poolCash: bigint;
    totalReserved: bigint;
    traderCollateral: bigint;
    orderEscrow: bigint;
    depositEscrow: bigint;
    longSize: bigint;
    shortSize: bigint;
    lpSupply: bigint;
  };
  lpBalances: Record<string, bigint>;
  accountSize: Record<string, bigint>;
  perpOrders: Record<number, PerpOrder>;
  positions: Record<number, Position>;
  poolRequests: Record<number, PoolRequest>;
  options: {
    poolCash: bigint;
    totalReserved: bigint;
    orderEscrow: bigint;
    settledOwed: bigint;
  };
  expiries: Record<number, { close: number; versions: QuoteVersion[] }>;
  optOrders: Record<number, OptOrder>;
  series: Record<string, Series>;
  readings: Record<number, { value: bigint; final: boolean }>;
  /** Pool value at the moment each round was published, for fairness of pool requests. */
  valueAtRound: Record<number, bigint>;
  /** USDT each account got from (+) or paid into (-) each contract. */
  netCash: Record<string, { perp: bigint; options: bigint }>;
  stats: {
    perpOpens: number;
    perpCloses: number;
    perpEmergencyCloses: number;
    perpCancels: Record<string, number>;
    poolDeposits: number;
    poolWithdrawals: number;
    poolCancels: Record<string, number>;
    optBuys: number;
    optSells: number;
    optCancels: Record<string, number>;
    claims: number;
    seriesSettled: number;
    seriesVoided: number;
    feesOpen: bigint;
    feesClose: bigint;
    funding: bigint;
    fundingModel: bigint;
    maxFundingDiff: bigint;
    premiumsIn: bigint;
    buybacksOut: bigint;
    optionPayouts: bigint;
    voidRefunds: bigint;
    biggestPerpPayout: bigint;
    bandEdgeCloses: number;
    perpLongestWait: { seconds: number; orderId: number };
    eventChecks: number;
    globalChecks: number;
  };
  poolDeviations: PoolFillDeviation[];
}

export interface Addresses {
  usdt: Address;
  feed: Address;
  perp: Address;
  options: Address;
  oracle: Address;
}

export interface TxContext {
  fn: string;
  from: Address;
  args: readonly unknown[];
  phase: string;
}

const lower = (a: unknown) => String(a).toLowerCase() as Address;
const big = (v: unknown) => BigInt(v as bigint);
const DAY = 86_400;

export function seriesIdOf(dayKey: number, strike: bigint, isCall: boolean): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'int64' }, { type: 'bool' }],
      [dayKey, strike, isCall],
    ),
  );
}

export class Ledger {
  s: LedgerState;
  funding: FundingModel;
  violations: Violation[] = [];
  readonly band: Band;
  readonly a: Addresses;
  /** The price the source data had for an interval end (cents), to check what the bot published. */
  sourcePrice: (intervalEnd: number) => bigint | null = () => null;
  /** When an expiry should stop trading, by the quote bot's rule. */
  expectedClose: (dayKey: number) => number | null = () => null;
  /** Quotes being posted by the transaction in flight. */
  postingQuotes: Record<string, QuoteCents> | null = null;
  private emergencyPrice: bigint | null = null;

  constructor(a: Addresses, band: Band, start: number) {
    this.a = { ...a };
    for (const k of Object.keys(this.a) as (keyof Addresses)[])
      this.a[k] = lower(this.a[k]);
    this.band = band;
    this.funding = new FundingModel(1n, start);
    this.s = {
      rounds: [],
      feedPaused: false,
      perpPaused: false,
      optionsPaused: false,
      feeBps: 10n,
      maxFunding: 1n,
      perpOrderTimeout: 900,
      optOrderTimeout: 900,
      perp: {
        poolCash: 0n,
        totalReserved: 0n,
        traderCollateral: 0n,
        orderEscrow: 0n,
        depositEscrow: 0n,
        longSize: 0n,
        shortSize: 0n,
        lpSupply: 0n,
      },
      lpBalances: {},
      accountSize: {},
      perpOrders: {},
      positions: {},
      poolRequests: {},
      options: { poolCash: 0n, totalReserved: 0n, orderEscrow: 0n, settledOwed: 0n },
      expiries: {},
      optOrders: {},
      series: {},
      readings: {},
      valueAtRound: {},
      netCash: {},
      stats: {
        perpOpens: 0,
        perpCloses: 0,
        perpEmergencyCloses: 0,
        perpCancels: {},
        poolDeposits: 0,
        poolWithdrawals: 0,
        poolCancels: {},
        optBuys: 0,
        optSells: 0,
        optCancels: {},
        claims: 0,
        seriesSettled: 0,
        seriesVoided: 0,
        feesOpen: 0n,
        feesClose: 0n,
        funding: 0n,
        fundingModel: 0n,
        maxFundingDiff: 0n,
        premiumsIn: 0n,
        buybacksOut: 0n,
        optionPayouts: 0n,
        voidRefunds: 0n,
        biggestPerpPayout: 0n,
        bandEdgeCloses: 0,
        perpLongestWait: { seconds: 0, orderId: 0 },
        eventChecks: 0,
        globalChecks: 0,
      },
      poolDeviations: [],
    };
  }

  // ------------------------------------------------------------------ snapshots

  save() {
    return {
      s: structuredClone(this.s),
      funding: this.funding.clone(),
      violations: this.violations.length,
    };
  }

  restore(saved: ReturnType<Ledger['save']>, keepViolations = true) {
    this.s = structuredClone(saved.s);
    this.funding = saved.funding.clone();
    if (!keepViolations) this.violations.length = saved.violations;
  }

  // ------------------------------------------------------------------ helpers

  private ts = 0;
  private tx: Hex | undefined;
  private phase = '';

  fail(check: string, detail: string) {
    this.violations.push({ check, detail, ts: this.ts, tx: this.tx, phase: this.phase });
  }

  private expect(check: string, ok: boolean, detail: () => string) {
    this.s.stats.eventChecks++;
    if (!ok) this.fail(check, detail());
  }

  latestIndex(): bigint | null {
    return indexAt(this.s.rounds, this.s.rounds.length);
  }

  /** Pool cash minus what traders are up at `price`, as the pool rules value it. */
  poolValueAt(price: bigint): bigint {
    let pnl = 0n;
    for (const p of Object.values(this.s.positions)) {
      pnl += p.isLong ? value(p.size, price - p.entry) : value(p.size, p.entry - price);
    }
    const v = this.s.perp.poolCash - pnl;
    return v > 0n ? v : 0n;
  }

  openPositions(): Position[] {
    return Object.values(this.s.positions);
  }

  pendingPerpOrders(): PerpOrder[] {
    return Object.values(this.s.perpOrders);
  }

  pendingPoolRequests(): PoolRequest[] {
    return Object.values(this.s.poolRequests);
  }

  pendingOptOrders(dayKey?: number): OptOrder[] {
    return Object.values(this.s.optOrders).filter(
      (o) => dayKey === undefined || o.dayKey === dayKey,
    );
  }

  private roundPublishedAfter(createdAt: number) {
    const r = this.s.rounds;
    return r.length > 0 && r[r.length - 1].publishedAt > createdAt;
  }

  private seriesFor(dayKey: number, strike: bigint, isCall: boolean): Series {
    const id = seriesIdOf(dayKey, strike, isCall);
    if (!this.s.series[id])
      this.s.series[id] = {
        id,
        dayKey,
        strike,
        isCall,
        openSize: 0n,
        premiumOpen: 0n,
        settled: false,
        voided: false,
        payoff: 0n,
        holders: {},
      };
    return this.s.series[id];
  }

  private holder(series: Series, account: Address) {
    const key = lower(account);
    series.holders[key] ??= { bal: 0n, paid: 0n };
    return series.holders[key];
  }

  private cash(account: Address, contract: 'perp' | 'options', amount: bigint) {
    const key = lower(account);
    this.s.netCash[key] ??= { perp: 0n, options: 0n };
    this.s.netCash[key][contract] += amount;
  }

  /** Outcomes of futures orders, kept for the last few thousand (cases look theirs up). */
  perpOutcome = new Map<number, string>();

  /** Records how long an order waited after its fill round existed, and how it ended. */
  private resolved(o: PerpOrder, outcome = 'filled') {
    this.perpOutcome.set(o.id, outcome);
    if (this.perpOutcome.size > 5000) this.perpOutcome.delete(this.perpOutcome.keys().next().value!);
    const R = fillRound(this.s.rounds, o.createdAt);
    if (R === null) return;
    const wait = this.ts - this.s.rounds[R - 1].publishedAt;
    if (wait > this.s.stats.perpLongestWait.seconds)
      this.s.stats.perpLongestWait = { seconds: wait, orderId: o.id };
  }

  private count(map: Record<string, number>, key: string) {
    map[key] = (map[key] ?? 0) + 1;
  }

  // ------------------------------------------------------------------ events

  apply(result: TxResult, ctx: TxContext) {
    this.ts = result.ts;
    this.tx = result.hash;
    this.phase = ctx.phase;
    if (!result.ok) return;
    for (const log of result.logs) this.onLog(log, ctx);
    if (ctx.fn === 'postQuotes') {
      const dayKey = Number(ctx.args[0]);
      for (const o of this.pendingOptOrders(dayKey))
        this.expect('every options order fills or cancels at the next quotes', o.createdAt >= this.ts, () =>
          `order ${o.id} (made ${o.createdAt}) still pending after quotes at ${this.ts}`,
        );
      this.postingQuotes = null;
    }
  }

  private onLog(log: DecodedLog, ctx: TxContext) {
    const at = log.address;
    const e = log.eventName;
    const x = log.args;
    if (at === this.a.usdt && e === 'Transfer') return this.onUsdt(x);
    if (at === this.a.feed) {
      if (e === 'PriceSubmitted') return this.onPrice(x);
      if (e === 'Paused') this.s.feedPaused = true;
      if (e === 'Unpaused') this.s.feedPaused = false;
      return;
    }
    if (at === this.a.oracle) {
      if (e === 'ReadingSubmitted')
        this.s.readings[Number(x.dayKey)] = { value: big(x.value), final: false };
      if (e === 'ReadingFinalized') this.s.readings[Number(x.dayKey)].final = true;
      return;
    }
    if (at === this.a.perp) return this.onPerp(e, x, ctx);
    if (at === this.a.options) return this.onOptions(e, x, ctx);
  }

  private onUsdt(x: Record<string, unknown>) {
    const from = lower(x.from);
    const to = lower(x.to);
    const amount = big(x.value);
    if (to === this.a.perp) this.cash(from, 'perp', -amount);
    if (from === this.a.perp) this.cash(to, 'perp', amount);
    if (to === this.a.options) this.cash(from, 'options', -amount);
    if (from === this.a.options) this.cash(to, 'options', amount);
  }

  private onPrice(x: Record<string, unknown>) {
    const roundId = Number(x.roundId);
    const intervalEnd = Number(x.intervalEnd);
    const price = big(x.priceCents);
    this.expect('rounds are numbered in order', roundId === this.s.rounds.length + 1, () =>
      `round ${roundId} after ${this.s.rounds.length}`,
    );
    const source = this.sourcePrice(intervalEnd);
    this.expect('the price bot publishes the source price', source === null || source === price, () =>
      `interval ${new Date(intervalEnd * 1000).toISOString()}: published ${price}, source ${source}`,
    );
    this.s.rounds.push({ priceCents: price, intervalEnd, publishedAt: this.ts });
    const idx = this.latestIndex();
    this.s.valueAtRound[roundId] =
      idx === null ? this.s.perp.poolCash : this.poolValueAt(clamp(idx, this.band));
  }

  // ------------------------------------------------------------------ futures

  private onPerp(e: string, x: Record<string, unknown>, ctx: TxContext) {
    const P = this.s.perp;
    switch (e) {
      case 'OrderRequested': {
        const id = Number(x.orderId);
        const isOpen = Boolean(x.isOpen);
        const isLong = Boolean(x.isLong);
        const size = big(x.size);
        const account = lower(x.account);
        if (isOpen) {
          const escrow = escrowForOpen(isLong, size, big(x.acceptablePriceCents), this.band, this.s.feeBps);
          const reserveHeld = reserveForOrder(size, this.band);
          P.orderEscrow += escrow;
          P.totalReserved += reserveHeld;
          this.s.accountSize[account] = (this.s.accountSize[account] ?? 0n) + size;
          this.s.perpOrders[id] = {
            id, account, createdAt: this.ts, isOpen, isLong, size,
            limit: big(x.acceptablePriceCents), positionId: 0, escrow, reserveHeld, pending: true,
          };
        } else {
          const pid = Number(x.positionId);
          const p = this.s.positions[pid];
          this.expect('a close is for an open position', Boolean(p?.open), () => `position ${pid}`);
          if (p) p.closeOrderId = id;
          this.s.perpOrders[id] = {
            id, account, createdAt: this.ts, isOpen, isLong, size, limit: 0n,
            positionId: pid, escrow: 0n, reserveHeld: 0n, pending: true,
          };
        }
        return;
      }
      case 'PositionOpened': {
        const o = this.s.perpOrders[Number(x.orderId)];
        const pid = Number(x.positionId);
        const entry = big(x.entryPriceCents);
        const roundId = Number(x.roundId);
        if (!o || !o.pending) return this.fail('an open fills a pending order', `order ${String(x.orderId)}`);
        const R = fillRound(this.s.rounds, o.createdAt);
        this.expect('futures fill at the first round after the order', R === roundId, () =>
          `order ${o.id}: filled at round ${roundId}, first round after it is ${R}`,
        );
        const exp = expectedOpen({
          isLong: o.isLong, limitCents: o.limit, index: indexAt(this.s.rounds, roundId),
          marketPaused: this.s.perpPaused, band: this.band,
        });
        this.expect('futures fill at the index of the fill round', 'fill' in exp && exp.fill === entry, () =>
          `order ${o.id}: filled at ${entry}, expected ${JSON.stringify(exp, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
        );
        this.expect('a fill is strictly inside the band', entry > this.band.floorCents && entry < this.band.capCents, () =>
          `order ${o.id} filled at ${entry}`,
        );
        const terms = openTerms(o.isLong, o.size, entry, this.band);
        const openFee = fee(o.size, entry, this.s.feeBps);
        this.expect('collateral and reserve follow the band', terms.collateral === big(x.collateral) && terms.reserve === big(x.reserve), () =>
          `position ${pid}: collateral ${String(x.collateral)} vs ${terms.collateral}, reserve ${String(x.reserve)} vs ${terms.reserve}`,
        );
        this.expect('the open fee is feeBps of the value', openFee === big(x.fee), () =>
          `position ${pid}: fee ${String(x.fee)} vs ${openFee}`,
        );
        this.funding.open(this.ts, String(pid), o.isLong, o.size);
        P.orderEscrow -= o.escrow;
        P.totalReserved += big(x.reserve) - o.reserveHeld;
        P.traderCollateral += big(x.collateral);
        P.poolCash += big(x.fee);
        if (o.isLong) P.longSize += o.size;
        else P.shortSize += o.size;
        this.s.positions[pid] = {
          id: pid, account: o.account, isLong: o.isLong, size: o.size, entry,
          collateral: big(x.collateral), reserve: big(x.reserve), open: true, closeOrderId: 0, openedAt: this.ts,
        };
        this.resolved(o);
        delete this.s.perpOrders[o.id];
        this.s.stats.perpOpens++;
        this.s.stats.feesOpen += big(x.fee);
        return;
      }
      case 'EmergencyClosed': {
        const p = this.s.positions[Number(x.positionId)];
        const latest = this.s.rounds.length;
        const last = this.s.rounds[latest - 1];
        this.expect('an emergency close needs 3 silent days', Boolean(last) && this.ts >= last.intervalEnd + 3 * DAY, () =>
          `at ${this.ts}, last interval ${last?.intervalEnd}`,
        );
        const idx = indexAt(this.s.rounds, latest);
        const expected = this.s.feedPaused || idx === null ? p.entry : clamp(idx, this.band);
        this.expect('an emergency close uses the last index (entry price if paused)', big(x.priceCents) === expected && Number(x.roundId) === latest, () =>
          `position ${p.id}: ${String(x.priceCents)} at round ${String(x.roundId)}, expected ${expected} at ${latest}`,
        );
        this.emergencyPrice = big(x.priceCents);
        return;
      }
      case 'PositionClosed': {
        const pid = Number(x.positionId);
        const p = this.s.positions[pid];
        if (!p || !p.open) return this.fail('a close is for an open position', `position ${pid}`);
        const orderId = Number(x.orderId);
        const exit = big(x.exitPriceCents);
        if (orderId !== 0) {
          const o = this.s.perpOrders[orderId];
          const R = fillRound(this.s.rounds, o.createdAt);
          this.expect('closes fill at the first round after the request', R === Number(x.roundId), () =>
            `order ${orderId}: round ${String(x.roundId)}, expected ${R}`,
          );
          const idx = indexAt(this.s.rounds, Number(x.roundId));
          this.expect('closes fill at the clamped index', idx !== null && clamp(idx, this.band) === exit, () =>
            `order ${orderId}: exit ${exit}, index ${idx}`,
          );
          this.resolved(o);
          delete this.s.perpOrders[o.id];
        } else {
          this.expect('an emergency close pays at its announced price', this.emergencyPrice === exit, () =>
            `position ${pid}: ${exit} vs ${this.emergencyPrice}`,
          );
          this.s.stats.perpEmergencyCloses++;
        }
        this.expect('no exit outside the band', exit >= this.band.floorCents && exit <= this.band.capCents, () =>
          `position ${pid} exit ${exit}`,
        );
        if (exit === this.band.floorCents || exit === this.band.capCents) this.s.stats.bandEdgeCloses++;
        const modelFunding = this.funding.close(this.ts, String(pid));
        const funding = big(x.funding);
        const diff = funding > modelFunding ? funding - modelFunding : modelFunding - funding;
        if (diff > this.s.stats.maxFundingDiff) this.s.stats.maxFundingDiff = diff;
        this.expect('funding matches the plan rule', diff <= 2n, () =>
          `position ${pid}: charged ${funding}, rule gives ${modelFunding}`,
        );
        const amounts = closeAmounts({
          isLong: p.isLong, size: p.size, entryCents: p.entry, exitCents: exit,
          collateral: p.collateral, funding, feeBps: this.s.feeBps,
        });
        this.expect('gain or loss is size x move', amounts.pnl === big(x.pnl), () =>
          `position ${pid}: pnl ${String(x.pnl)} vs ${amounts.pnl}`,
        );
        this.expect('the close fee is feeBps of the value', amounts.fee === big(x.fee), () =>
          `position ${pid}: fee ${String(x.fee)} vs ${amounts.fee}`,
        );
        this.expect('payout is collateral + gain - funding - fee, never below 0', amounts.payout === big(x.payout), () =>
          `position ${pid}: payout ${String(x.payout)} vs ${amounts.payout}`,
        );
        this.expect('no payout above its maximum', big(x.payout) <= p.collateral + p.reserve && amounts.pnl <= p.reserve && amounts.pnl >= -p.collateral, () =>
          `position ${pid}: payout ${String(x.payout)}, collateral ${p.collateral}, reserve ${p.reserve}`,
        );
        if (p.isLong) P.longSize -= p.size;
        else P.shortSize -= p.size;
        this.s.accountSize[p.account] -= p.size;
        P.traderCollateral -= p.collateral;
        P.totalReserved -= p.reserve;
        P.poolCash += p.collateral - big(x.payout);
        delete this.s.positions[pid];
        this.s.stats.perpCloses++;
        this.s.stats.feesClose += big(x.fee);
        this.s.stats.funding += funding;
        this.s.stats.fundingModel += modelFunding;
        if (big(x.payout) > this.s.stats.biggestPerpPayout) this.s.stats.biggestPerpPayout = big(x.payout);
        return;
      }
      case 'OrderCancelled': {
        const o = this.s.perpOrders[Number(x.orderId)];
        const reason = String(x.reason);
        if (!o || !o.pending) return this.fail('a cancel is for a pending order', `order ${String(x.orderId)}`);
        if (ctx.fn === 'executeOrder') {
          const R = Number(ctx.args[1]);
          this.expect('futures resolve at the first round after the order', fillRound(this.s.rounds, o.createdAt) === R, () =>
            `order ${o.id}: round ${R}`,
          );
          const idx = indexAt(this.s.rounds, R);
          if (o.isOpen) {
            const exp = expectedOpen({ isLong: o.isLong, limitCents: o.limit, index: idx, marketPaused: this.s.perpPaused, band: this.band });
            this.expect('an open cancels only for the documented reasons', 'cancel' in exp && exp.cancel === reason, () =>
              `order ${o.id}: "${reason}", expected ${'cancel' in exp ? exp.cancel : `fill at ${exp.fill}`}`,
            );
          } else {
            this.expect('a close is dropped only across a gap', idx === null && reason === 'no index at the fill round', () =>
              `order ${o.id}: "${reason}", index ${idx}`,
            );
          }
        } else if (ctx.fn === 'cancelOrder') {
          const allowed =
            this.s.feedPaused ||
            (this.ts >= o.createdAt + this.s.perpOrderTimeout && !this.roundPublishedAfter(o.createdAt));
          this.expect('a trader cancels only while paused or after a timeout with no round', allowed, () =>
            `order ${o.id} made ${o.createdAt}, cancelled ${this.ts}`,
          );
        }
        if (o.isOpen) {
          this.s.accountSize[o.account] -= o.size;
          P.totalReserved -= o.reserveHeld;
          P.orderEscrow -= o.escrow;
        } else {
          const p = this.s.positions[o.positionId];
          if (p) p.closeOrderId = 0;
        }
        this.resolved(o, `cancelled: ${reason}`);
        delete this.s.perpOrders[o.id];
        this.count(this.s.stats.perpCancels, reason);
        return;
      }
      case 'PoolRequested': {
        const id = Number(x.requestId);
        const isDeposit = Boolean(x.isDeposit);
        if (isDeposit) P.depositEscrow += big(x.amount);
        this.s.poolRequests[id] = {
          id, account: lower(x.account), createdAt: this.ts, isDeposit, amount: big(x.amount), pending: true,
        };
        return;
      }
      case 'Transfer': {
        const from = lower(x.from);
        const to = lower(x.to);
        const amount = big(x.value);
        const zero = '0x0000000000000000000000000000000000000000';
        if (from === zero) P.lpSupply += amount;
        else this.s.lpBalances[from] = (this.s.lpBalances[from] ?? 0n) - amount;
        if (to === zero) P.lpSupply -= amount;
        else this.s.lpBalances[to] = (this.s.lpBalances[to] ?? 0n) + amount;
        return;
      }
      case 'Deposited':
      case 'Withdrawn': {
        const isDeposit = e === 'Deposited';
        const assets = big(x.assets);
        const shares = big(x.shares);
        // the share mint or burn was already applied, so put it back for the price
        const supplyBefore = isDeposit ? P.lpSupply - shares : P.lpSupply + shares;
        const V = 1000n;
        if (ctx.fn === 'deposit' || ctx.fn === 'withdraw') {
          this.expect('instant pool moves only while no position is open', P.longSize === 0n && P.shortSize === 0n, () =>
            `${ctx.fn} with ${P.longSize}/${P.shortSize} open`,
          );
          const fair = isDeposit
            ? (assets * (supplyBefore + V)) / (P.poolCash + 1n)
            : (shares * (P.poolCash + 1n)) / (supplyBefore + V);
          this.expect('pool shares are priced at the pool value', fair === (isDeposit ? shares : assets), () =>
            `${ctx.fn}: got ${isDeposit ? shares : assets}, expected ${fair}`,
          );
          if (!isDeposit)
            this.expect('an instant withdrawal is paid only from unreserved cash', assets <= P.poolCash - P.totalReserved, () =>
              `${assets} with ${P.poolCash - P.totalReserved} free`,
            );
          if (isDeposit) P.poolCash += assets;
          else P.poolCash -= assets;
        } else {
          const req = this.s.poolRequests[Number(ctx.args[0])];
          const R = Number(ctx.args[1]);
          this.expect('pool requests fill at the first round after them', fillRound(this.s.rounds, req.createdAt) === R, () =>
            `request ${req.id}: round ${R}`,
          );
          const idx = indexAt(this.s.rounds, R);
          const used = this.poolValueAt(clamp(idx ?? 0n, this.band));
          const got = isDeposit ? shares : assets;
          const rule = isDeposit
            ? (req.amount * (supplyBefore + V)) / (used + 1n)
            : (req.amount * (used + 1n)) / (supplyBefore + V);
          this.expect('pool requests use the pool value at the fill round price', got === rule, () =>
            `request ${req.id}: got ${got}, rule gives ${rule}`,
          );
          // fairness: what the request would get at the pool's value when its round came out, and now
          const atRound = this.s.valueAtRound[R] ?? used;
          const nowIdx = this.latestIndex();
          const atNow = nowIdx === null ? used : this.poolValueAt(clamp(nowIdx, this.band));
          const deviation = (v: bigint) =>
            isDeposit
              ? ((shares - (req.amount * (supplyBefore + V)) / (v + 1n)) * (v + 1n)) / (supplyBefore + V)
              : assets - (req.amount * (v + 1n)) / (supplyBefore + V);
          this.s.poolDeviations.push({
            requestId: req.id,
            isDeposit,
            ts: this.ts,
            waitedSeconds: this.ts - this.s.rounds[R - 1].publishedAt,
            vsFillRound: deviation(atRound),
            vsNow: deviation(atNow),
          });
          delete this.s.poolRequests[req.id];
          if (isDeposit) {
            P.depositEscrow -= req.amount;
            P.poolCash += req.amount;
          } else {
            this.expect('a withdrawal is paid only from unreserved cash', assets <= P.poolCash - P.totalReserved, () =>
              `request ${req.id}: ${assets} with ${P.poolCash - P.totalReserved} free`,
            );
            P.poolCash -= assets;
          }
        }
        if (isDeposit) this.s.stats.poolDeposits++;
        else this.s.stats.poolWithdrawals++;
        return;
      }
      case 'PoolRequestCancelled': {
        const req = this.s.poolRequests[Number(x.requestId)];
        const reason = String(x.reason);
        if (ctx.fn === 'executePoolRequest') {
          this.expect('a pool request is cancelled at its round only across a gap', indexAt(this.s.rounds, Number(ctx.args[1])) === null, () =>
            `request ${req.id}`,
          );
        } else {
          const allowed =
            this.s.feedPaused ||
            (this.ts >= req.createdAt + this.s.perpOrderTimeout && !this.roundPublishedAfter(req.createdAt));
          this.expect('a provider cancels only while paused or after a timeout with no round', allowed, () =>
            `request ${req.id} made ${req.createdAt}, cancelled ${this.ts}`,
          );
        }
        if (req.isDeposit) P.depositEscrow -= req.amount;
        delete this.s.poolRequests[req.id];
        this.count(this.s.stats.poolCancels, reason);
        return;
      }
      case 'SettingsChanged':
        this.funding.setRate(this.ts, big(x.maxFundingCentsPerMwhHour));
        this.s.feeBps = big(x.feeBps);
        this.s.maxFunding = big(x.maxFundingCentsPerMwhHour);
        this.s.perpOrderTimeout = Number(x.orderTimeout);
        return;
      case 'Paused':
        this.s.perpPaused = true;
        return;
      case 'Unpaused':
        this.s.perpPaused = false;
        return;
    }
  }

  // ------------------------------------------------------------------ options

  private firstVersionAfter(dayKey: number, createdAt: number): QuoteVersion | undefined {
    return this.s.expiries[dayKey]?.versions.find((v) => v.time > createdAt);
  }

  private onOptions(e: string, x: Record<string, unknown>, ctx: TxContext) {
    const O = this.s.options;
    switch (e) {
      case 'ExpiryOpened': {
        const dayKey = Number(x.dayKey);
        const close = Number(x.tradingCloseUtc);
        const rule = this.expectedClose(dayKey);
        this.expect('an expiry closes before its settlement price can be known', rule === null || rule === close, () =>
          `${dayKey}: closes ${close}, rule ${rule}`,
        );
        this.s.expiries[dayKey] = { close, versions: [] };
        return;
      }
      case 'QuotesPosted': {
        const dayKey = Number(x.dayKey);
        const exp = this.s.expiries[dayKey];
        this.expect('quote versions count up', Number(x.version) === exp.versions.length + 1, () =>
          `${dayKey}: version ${String(x.version)}`,
        );
        exp.versions.push({ version: Number(x.version), time: this.ts, quotes: this.postingQuotes ?? {} });
        return;
      }
      case 'OrderRequested': {
        const id = Number(x.orderId);
        const dayKey = Number(x.dayKey);
        const isBuy = Boolean(x.isBuy);
        const isCall = Boolean(x.isCall);
        const strike = big(x.strikeCents);
        const size = big(x.size);
        const limit = big(x.limitCents);
        const account = lower(x.account);
        let escrow: bigint;
        if (isBuy) {
          escrow = value(size, limit);
          O.totalReserved += value(size, maxPayoutCents(strike, isCall, this.band));
          O.orderEscrow += escrow;
        } else {
          const h = this.holder(this.seriesFor(dayKey, strike, isCall), account);
          this.expect('a holder sells only options they hold', h.bal >= size, () => `order ${id}`);
          escrow = (h.paid * size) / h.bal;
          h.bal -= size;
          h.paid -= escrow;
        }
        this.s.optOrders[id] = {
          id, account, createdAt: this.ts, dayKey, isBuy, isCall, strike, limit, size, escrow, pending: true,
        };
        return;
      }
      case 'OrderFilled': {
        const o = this.s.optOrders[Number(x.orderId)];
        if (!o || !o.pending) return this.fail('an options fill is for a pending order', `order ${String(x.orderId)}`);
        const v = this.firstVersionAfter(o.dayKey, o.createdAt);
        this.expect('options fill at the first quotes posted after the order', v?.version === Number(x.version), () =>
          `order ${o.id}: version ${String(x.version)}, expected ${v?.version}`,
        );
        const exp = expectedOptionFill({ isBuy: o.isBuy, isCall: o.isCall, limitCents: o.limit, quote: v?.quotes[o.strike.toString()] });
        const premium = big(x.premiumCents);
        this.expect('options fill at the quoted premium within the limit', 'premium' in exp && exp.premium === premium, () =>
          `order ${o.id}: premium ${premium}, expected ${'premium' in exp ? exp.premium : exp.cancel}`,
        );
        const max = maxPayoutCents(o.strike, o.isCall, this.band);
        this.expect('no premium above the largest payout', premium <= max, () => `order ${o.id}: ${premium} > ${max}`);
        const amount = value(o.size, premium);
        this.expect('premium cash is size x premium', amount === big(x.amount), () => `order ${o.id}: ${String(x.amount)} vs ${amount}`);
        const series = this.seriesFor(o.dayKey, o.strike, o.isCall);
        const h = this.holder(series, o.account);
        if (o.isBuy) {
          O.orderEscrow -= o.escrow;
          O.poolCash += amount;
          series.openSize += o.size;
          series.premiumOpen += amount;
          h.bal += o.size;
          h.paid += amount;
          this.s.stats.optBuys++;
          this.s.stats.premiumsIn += amount;
        } else {
          series.openSize -= o.size;
          series.premiumOpen -= o.escrow;
          O.totalReserved -= value(o.size, max);
          O.poolCash -= amount;
          this.s.stats.optSells++;
          this.s.stats.buybacksOut += amount;
        }
        delete this.s.optOrders[o.id];
        return;
      }
      case 'OrderCancelled': {
        const o = this.s.optOrders[Number(x.orderId)];
        const reason = String(x.reason);
        if (!o || !o.pending) return this.fail('an options cancel is for a pending order', `order ${String(x.orderId)}`);
        if (ctx.fn === 'postQuotes') {
          const versions = this.s.expiries[o.dayKey].versions;
          const current = versions[versions.length - 1];
          const v = this.firstVersionAfter(o.dayKey, o.createdAt);
          this.expect('options resolve at the first quotes posted after the order', v?.version === current.version, () =>
            `order ${o.id}: resolved at ${current.version}, expected ${v?.version}`,
          );
          const exp = expectedOptionFill({ isBuy: o.isBuy, isCall: o.isCall, limitCents: o.limit, quote: current.quotes[o.strike.toString()] });
          this.expect('an options order cancels only for the documented reasons', 'cancel' in exp && exp.cancel === reason, () =>
            `order ${o.id}: "${reason}", expected ${'cancel' in exp ? exp.cancel : `fill at ${exp.premium}`}`,
          );
        } else {
          const close = this.s.expiries[o.dayKey].close;
          const allowed =
            this.s.optionsPaused || this.ts >= close || this.ts >= o.createdAt + this.s.optOrderTimeout;
          this.expect('a trader cancels an options order only when allowed', allowed, () => `order ${o.id}`);
        }
        if (o.isBuy) {
          O.totalReserved -= value(o.size, maxPayoutCents(o.strike, o.isCall, this.band));
          O.orderEscrow -= o.escrow;
        } else {
          const h = this.holder(this.seriesFor(o.dayKey, o.strike, o.isCall), o.account);
          h.bal += o.size;
          h.paid += o.escrow;
        }
        delete this.s.optOrders[o.id];
        this.count(this.s.stats.optCancels, reason);
        return;
      }
      case 'SeriesSettled': {
        const dayKey = Number(x.dayKey);
        const strike = big(ctx.args[1]);
        const isCall = Boolean(ctx.args[2]);
        const series = this.seriesFor(dayKey, strike, isCall);
        const reading = this.s.readings[dayKey];
        this.expect('a series settles only on a final reading', Boolean(reading?.final), () => `${dayKey}`);
        const payoff = payoffCents(reading.value, strike, isCall, this.band);
        const max = maxPayoutCents(strike, isCall, this.band);
        this.expect('settlement pays the clamped day average minus the strike', payoff === big(x.payoffCents), () =>
          `${dayKey} ${isCall ? 'call' : 'put'} ${strike}: ${String(x.payoffCents)} vs ${payoff} (reading ${reading.value})`,
        );
        this.expect('no option pays above its maximum', big(x.payoffCents) <= max, () => `${dayKey} ${strike}`);
        this.expect('a series owes payoff x open size', value(series.openSize, payoff) === big(x.owed), () =>
          `${dayKey} ${strike}: owed ${String(x.owed)} vs ${value(series.openSize, payoff)}`,
        );
        O.totalReserved -= value(series.openSize, max);
        O.poolCash -= big(x.owed);
        O.settledOwed += big(x.owed);
        series.settled = true;
        series.payoff = big(x.payoffCents);
        this.s.stats.seriesSettled++;
        return;
      }
      case 'SeriesVoided': {
        const dayKey = Number(x.dayKey);
        const series = this.seriesFor(dayKey, big(ctx.args[1]), Boolean(ctx.args[2]));
        this.expect('a series is voided only without a final reading, 14 days after its close',
          !this.s.readings[dayKey]?.final && this.ts >= this.s.expiries[dayKey].close + 14 * DAY, () => `${dayKey}`);
        this.expect('a void refunds exactly the premiums still open', big(x.refunded) === series.premiumOpen, () =>
          `${dayKey}: ${String(x.refunded)} vs ${series.premiumOpen}`,
        );
        O.totalReserved -= value(series.openSize, maxPayoutCents(series.strike, series.isCall, this.band));
        O.poolCash -= series.premiumOpen;
        O.settledOwed += series.premiumOpen;
        series.voided = true;
        this.s.stats.seriesVoided++;
        return;
      }
      case 'Claimed': {
        const series = this.s.series[String(x.seriesId)] ??
          this.seriesFor(Number(ctx.args[0]), big(ctx.args[1]), Boolean(ctx.args[2]));
        const h = this.holder(series, lower(x.account));
        const exp = series.voided ? h.paid : value(h.bal, series.payoff);
        this.expect('a claim pays the holder exactly their share', exp === big(x.amount), () =>
          `${series.dayKey} ${series.strike}: ${String(x.amount)} vs ${exp}`,
        );
        O.settledOwed -= big(x.amount);
        if (series.voided) this.s.stats.voidRefunds += big(x.amount);
        else this.s.stats.optionPayouts += big(x.amount);
        h.bal = 0n;
        h.paid = 0n;
        this.s.stats.claims++;
        return;
      }
      case 'PoolFunded':
        O.poolCash += big(x.amount);
        return;
      case 'PoolDefunded':
        O.poolCash -= big(x.amount);
        return;
      case 'Paused':
        this.s.optionsPaused = true;
        return;
      case 'Unpaused':
        this.s.optionsPaused = false;
        return;
    }
  }

  // ------------------------------------------------------------------ totals

  /**
   * The contracts' own totals and balances, against each other and against
   * the shadow books. Called after every transaction.
   */
  checkTotals(chain: {
    perpBalance: bigint;
    perp: Record<keyof LedgerState['perp'], bigint>;
    optionsBalance: bigint;
    options: Record<keyof LedgerState['options'], bigint>;
  }) {
    this.s.stats.globalChecks++;
    const p = chain.perp;
    const o = chain.options;
    const perpSum = p.poolCash + p.traderCollateral + p.orderEscrow + p.depositEscrow;
    if (chain.perpBalance !== perpSum)
      this.fail('futures: token balance = pool + collateral + escrows', `balance ${chain.perpBalance}, books ${perpSum}`);
    if (p.poolCash < p.totalReserved)
      this.fail('futures: pool cash covers every reserve', `cash ${p.poolCash} < reserved ${p.totalReserved}`);
    for (const k of Object.keys(p) as (keyof LedgerState['perp'])[])
      if (p[k] !== this.s.perp[k])
        this.fail(`futures: contract ${k} matches the independent books`, `contract ${p[k]}, books ${this.s.perp[k]}`);
    const optSum = o.poolCash + o.orderEscrow + o.settledOwed;
    if (chain.optionsBalance !== optSum)
      this.fail('options: token balance = pool + escrow + owed payouts', `balance ${chain.optionsBalance}, books ${optSum}`);
    if (o.poolCash < o.totalReserved)
      this.fail('options: pool cash covers every reserve', `cash ${o.poolCash} < reserved ${o.totalReserved}`);
    for (const k of Object.keys(o) as (keyof LedgerState['options'])[])
      if (o[k] !== this.s.options[k])
        this.fail(`options: contract ${k} matches the independent books`, `contract ${o[k]}, books ${this.s.options[k]}`);
    // what the books say is reserved must be exactly what the open risk needs
    let perpRisk = 0n;
    for (const pos of this.openPositions()) perpRisk += pos.reserve;
    for (const ord of this.pendingPerpOrders()) if (ord.isOpen) perpRisk += ord.reserveHeld;
    if (perpRisk !== this.s.perp.totalReserved)
      this.fail('futures: reserved = open positions + pending opens', `${this.s.perp.totalReserved} vs ${perpRisk}`);
    let optRisk = 0n;
    for (const se of Object.values(this.s.series))
      if (!se.settled && !se.voided) optRisk += value(se.openSize, maxPayoutCents(se.strike, se.isCall, this.band));
    for (const ord of this.pendingOptOrders())
      if (ord.isBuy) optRisk += value(ord.size, maxPayoutCents(ord.strike, ord.isCall, this.band));
    if (optRisk !== this.s.options.totalReserved)
      this.fail('options: reserved = largest payout of open options + pending buys', `${this.s.options.totalReserved} vs ${optRisk}`);
  }
}
