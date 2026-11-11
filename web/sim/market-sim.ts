/**
 * Many-wallet stress test of the GRIDFLEX derivatives before they go on
 * X Layer testnet: LivePriceFeed, TexasPowerPerp (futures) and
 * TexasPowerOptions, deployed with the settings of
 * contracts/script/DeployDerivatives.s.sol on a local anvil chain this script
 * starts itself.
 *
 * - Replays real ERCOT North Hub 5-minute prices (sim/data) through the real
 *   price bot, keeper and quote bot (lib/price-bot.ts, keeper.ts, quote-bot.ts).
 * - 200 trader wallets and 10 pool providers from anvil's public test
 *   mnemonic open and close longs and shorts, buy and sell calls and puts on
 *   every listed day, and claim after settlement on the real day-ahead averages.
 * - Edge cases on a schedule: prices beyond the -$50/$300 band (real ones and
 *   exact ones), missed prices, bot outages, pauses, cancels, a burst of
 *   hundreds of orders in one block, a funding change.
 * - Every event is checked against sim/model.ts and the books are reconciled
 *   with the contracts after every transaction (sim/ledger.ts); every 3 hours
 *   every holder must be able to close, withdraw, sell back or claim.
 * - Then targeted cases, each from a snapshot of the chain (and undone), and
 *   a wind-down where everyone exits and the contracts must end up empty.
 *
 * Run from web/ (needs foundry): node sim/market-sim.ts [--days 9] [--seed 7] [--lambda 5]
 * Writes sim/out/report.md and sim/out/report.json. Never touches a real
 * network: it only talks to the anvil it started.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { keccak256, toBytes, maxUint256, type Address, type Hex } from 'viem';

import { runKeeper, type PendingItem } from '../lib/keeper.ts';
import { finishedIntervals, planRounds, runPriceBot } from '../lib/price-bot.ts';
import {
  runQuoteBot,
  texasDayKey,
  texasDayStartMs,
  texasLocalMs,
  type QuoteVersion as BotQuoteVersion,
} from '../lib/quote-bot.ts';
import { Chain, loadArtifact, type TxResult } from './chain.ts';
import { Ledger, seriesIdOf, type Violation } from './ledger.ts';
import { clamp, maxPayoutCents, value, type Band } from './model.ts';
import { writeReport, type ScenarioResult } from './report.ts';

// ------------------------------------------------------------------ settings

const { values: opt } = parseArgs({
  options: {
    days: { type: 'string', default: '9' },
    seed: { type: 'string', default: '7' },
    lambda: { type: 'string', default: '5' },
    port: { type: 'string', default: '8548' },
    out: { type: 'string', default: 'sim/out' },
    'skip-scenarios': { type: 'boolean', default: false },
  },
});
const DAYS = Number(opt.days);
const LAMBDA = Number(opt.lambda);
const SEED = Number(opt.seed);
const TRADERS = 200;
const LPS = 10;
const ACCOUNTS = 20 + TRADERS;
const USD = 1_000_000n; // collateral units per dollar

// the deploy script's own settings, read from its source so the two cannot drift apart
const deploySource = readFileSync('../contracts/script/DeployDerivatives.s.sol', 'utf8');
const constant = (name: string) => {
  const m = deploySource.match(new RegExp(`${name} = (-?[\\d_]+);`));
  if (!m) throw new Error(`${name} not found in DeployDerivatives.s.sol`);
  return BigInt(m[1].replaceAll('_', ''));
};
const INTERVAL = Number(constant('INTERVAL'));
const FEED_MIN = constant('FEED_MIN_CENTS');
const FEED_MAX = constant('FEED_MAX_CENTS');
const band: Band = { floorCents: constant('BAND_FLOOR_CENTS'), capCents: constant('BAND_CAP_CENTS') };
const STRIKE_STEP = constant('STRIKE_STEP_CENTS');
const METRIC = deploySource.match(/vm\.envOr\("OPTIONS_METRIC", string\("([A-Z_]+)"\)\)/)?.[1];
if (!METRIC) throw new Error('options metric not found in DeployDerivatives.s.sol');
const FEED_ID = keccak256(toBytes('ERCOT_HBNORTH_RT_5MIN'));
const METRIC_ID = keccak256(toBytes(METRIC));
const ORACLE_DISPUTE_WINDOW = 3600n;

// ------------------------------------------------------------------ data

interface Fixture {
  firstIntervalEndUtc: string;
  intervalSeconds: number;
  lmp: (number | null)[];
  firstTexasDay: string;
}
const fixture = JSON.parse(readFileSync('sim/data/hb-north-5min-2026-09-15.json', 'utf8')) as Fixture;
const FIRST_END = Date.parse(fixture.firstIntervalEndUtc) / 1000;
if (DAYS + 1 > fixture.lmp.length / 288) throw new Error(`the price file has ${fixture.lmp.length / 288} days`);
/** Prices the simulation puts in place of the real ones (the exact band-edge test). */
const syntheticLmp = new Map<number, number>();
/** Intervals GridStatus "never had" (a hole in the source). */
const missingFromSource = new Set<number>();
const lmpAt = (end: number): number | null => {
  if (missingFromSource.has(end)) return null;
  if (syntheticLmp.has(end)) return syntheticLmp.get(end)!;
  const k = (end - FIRST_END) / INTERVAL;
  return Number.isInteger(k) && k >= 0 && k < fixture.lmp.length ? fixture.lmp[k] : null;
};
/** GridStatus rows for the price bot: the last 25 minutes of finished intervals. */
const rowsFor = (nowMs: number) => {
  const rows = [];
  const nowS = Math.floor(nowMs / 1000);
  const lastEnd = Math.floor(nowS / INTERVAL) * INTERVAL;
  for (let end = lastEnd - 5 * INTERVAL; end <= lastEnd; end += INTERVAL) {
    const lmp = lmpAt(end);
    if (lmp === null) continue;
    rows.push({
      interval_start_utc: new Date((end - INTERVAL) * 1000).toISOString(),
      interval_end_utc: new Date(end * 1000).toISOString(),
      lmp,
    });
  }
  return rows;
};

interface DaRecord {
  dayKey: number;
  value: number;
  sourceHash: string;
}
const daRecords = JSON.parse(readFileSync('public/data/ERCOT_HBNORTH_DA_AVG.json', 'utf8')) as DaRecord[];
const daByDay = new Map(daRecords.map((r) => [r.dayKey, r]));

// ------------------------------------------------------------------ randomness (seeded, so a run repeats)

let rngState = SEED >>> 0;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const uniform = (a: number, b: number) => a + (b - a) * rand();
const logUniform = (a: number, b: number) => Math.exp(uniform(Math.log(a), Math.log(b)));
const poisson = (lambda: number) => {
  let k = 0;
  let p = Math.exp(-lambda);
  let s = p;
  const u = rand();
  while (u > s) {
    k++;
    p *= lambda / k;
    s += p;
  }
  return k;
};
const cents = (dollars: number) => BigInt(Math.round(dollars * 100));

// ------------------------------------------------------------------ dates

const addDays = (dayKey: number, days: number) => {
  const d = new Date(Date.UTC(Math.floor(dayKey / 10_000), Math.floor((dayKey % 10_000) / 100) - 1, dayKey % 100) + days * 86_400_000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const FIRST_DAY = Number(fixture.firstTexasDay.replaceAll('-', ''));
/** Unix seconds of a Texas local time on simulation day `day` (0 = the first day). */
const T = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return texasLocalMs(addDays(FIRST_DAY, day), h, m) / 1000;
};
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const VOID_DAY = addDays(FIRST_DAY, 4); // the oracle never publishes this day: its options must be voided and refunded

// ------------------------------------------------------------------ chain and contracts

execFileSync('forge', ['build'], { cwd: '../contracts', stdio: 'ignore' });
const OUT_DIR = '../contracts/out';
const art = {
  usdt: loadArtifact(OUT_DIR, 'MockUSDT'),
  oracle: loadArtifact(OUT_DIR, 'GridOracle'),
  feed: loadArtifact(OUT_DIR, 'LivePriceFeed'),
  perp: loadArtifact(OUT_DIR, 'TexasPowerPerp'),
  options: loadArtifact(OUT_DIR, 'TexasPowerOptions'),
};
type Name = keyof typeof art;

const START = FIRST_END - 3600; // an hour before the first price, for setup
const chain = new Chain(Number(opt.port));
await chain.start(ACCOUNTS, START);
process.on('exit', () => chain.stop());
const accounts = (await chain.accounts()).map((a) => a.toLowerCase() as Address);
const role = {
  owner: accounts[0],
  reporter: accounts[1],
  guardian: accounts[2],
  quoter: accounts[3],
  keeper: accounts[5],
  oracleReporter: accounts[6],
  deployer: accounts[9],
};
const lps = accounts.slice(10, 10 + LPS);
const traders = accounts.slice(20, 20 + TRADERS);

let now = START;
const addr = {} as Record<Name, Address>;
addr.usdt = await chain.deploy(role.deployer, art.usdt, [], now);
addr.oracle = await chain.deploy(role.deployer, art.oracle, [role.oracleReporter, ORACLE_DISPUTE_WINDOW], now);
addr.feed = await chain.deploy(role.deployer, art.feed, [role.owner, role.reporter, role.guardian, BigInt(INTERVAL), FEED_MIN, FEED_MAX], now);
addr.perp = await chain.deploy(role.deployer, art.perp, [role.owner, role.guardian, addr.usdt, addr.feed, FEED_ID, band.floorCents, band.capCents], now);
addr.options = await chain.deploy(role.deployer, art.options, [role.owner, role.quoter, role.guardian, addr.usdt, addr.oracle, METRIC_ID, band.floorCents, band.capCents, STRIKE_STEP], now);
for (const k of Object.keys(addr) as Name[]) addr[k] = addr[k].toLowerCase() as Address;

const ledger = new Ledger(addr, band, START);
ledger.sourcePrice = (end) => {
  const lmp = lmpAt(end);
  return lmp === null ? null : BigInt(Math.round(lmp * 100));
};
ledger.expectedClose = (dayKey) => texasLocalMs(addDays(dayKey, -1), 12, 30) / 1000;

// ------------------------------------------------------------------ sending, with checks after every transaction

let phase = 'setup';
const outcomes = new Map<string, Map<string, number>>();
const refusals = new Map<string, number>();
const tally = (fn: string, outcome: string) => {
  const m = outcomes.get(fn) ?? new Map<string, number>();
  m.set(outcome, (m.get(outcome) ?? 0) + 1);
  outcomes.set(fn, m);
};

const totalsCalls = (() => {
  const c = (name: Name, functionName: string, args: readonly unknown[] = []) => ({ address: addr[name], abi: art[name].abi, functionName, args });
  return [
    c('usdt', 'balanceOf', [addr.perp]),
    c('usdt', 'balanceOf', [addr.options]),
    ...['poolCash', 'totalReserved', 'traderCollateral', 'orderEscrow', 'depositEscrow', 'longSize', 'shortSize', 'totalSupply'].map((f) => c('perp', f)),
    ...['poolCash', 'totalReserved', 'orderEscrow', 'settledOwed'].map((f) => c('options', f)),
  ];
})();

async function checkTotals() {
  const [perpBalance, optionsBalance, ...v] = (await chain.readMany(totalsCalls)) as bigint[];
  ledger.checkTotals({
    perpBalance,
    perp: {
      poolCash: v[0], totalReserved: v[1], traderCollateral: v[2], orderEscrow: v[3],
      depositEscrow: v[4], longSize: v[5], shortSize: v[6], lpSupply: v[7],
    },
    optionsBalance,
    options: { poolCash: v[8], totalReserved: v[9], orderEscrow: v[10], settledOwed: v[11] },
  });
}

const GAS: Partial<Record<string, bigint>> = { postQuotes: 30_000_000n };

function outcomeOf(fn: string, result: TxResult): string {
  if (!result.ok) return result.errorName ?? 'reverted';
  const names = result.logs.map((l) => l.eventName);
  if (fn === 'executeOrder')
    return names.includes('PositionOpened') ? 'open filled' : names.includes('PositionClosed') ? 'close filled' : 'cancelled';
  if (fn === 'executePoolRequest')
    return names.includes('PoolRequestCancelled') ? 'cancelled' : names.includes('Deposited') ? 'deposit filled' : 'withdrawal filled';
  if (fn === 'claim') return names.includes('SeriesSettled') ? 'settled and paid' : names.includes('SeriesVoided') ? 'voided and refunded' : 'paid';
  return 'ok';
}

function gasLabel(fn: string, result: TxResult, pendingBefore?: number): string {
  const o = outcomeOf(fn, result);
  if (fn === 'postQuotes' && pendingBefore !== undefined) {
    const n = pendingBefore;
    return `postQuotes (${n === 0 ? 'no' : n < 10 ? '1-9' : n < 50 ? '10-49' : '50-100'} orders waiting)`;
  }
  if (fn === 'executeOrder' || fn === 'executePoolRequest' || fn === 'claim') return `${fn} (${o})`;
  return fn;
}

async function tx(
  from: Address,
  to: Name,
  fn: string,
  args: readonly unknown[],
  at = now,
): Promise<TxResult> {
  const pendingBefore = fn === 'postQuotes' ? ledger.pendingOptOrders(Number(args[0])).length : undefined;
  const req = { from, to: addr[to], abi: art[to].abi, functionName: fn, args, gas: GAS[fn] };
  const result = await chain.send(req, at, '__pending__');
  // relabel the gas record now that the outcome is known
  const list = chain.gas.get('__pending__') ?? chain.gas.get('__pending__ [reverted]');
  chain.gas.delete('__pending__');
  chain.gas.delete('__pending__ [reverted]');
  const label = result.ok ? gasLabel(fn, result, pendingBefore) : `${fn} [reverted]`;
  chain.gas.set(label, [...(chain.gas.get(label) ?? []), ...(list ?? [])]);
  now = Math.max(now, result.ts);
  ledger.apply(result, { fn, from, args, phase });
  tally(fn, outcomeOf(fn, result));
  if (!result.ok) refusals.set(`${phase.split(':')[0]} | ${fn}: ${result.errorName}`, (refusals.get(`${phase.split(':')[0]} | ${fn}: ${result.errorName}`) ?? 0) + 1);
  await checkTotals();
  return result;
}

/** Many transactions in one block, as if sent at the same moment. */
async function burst(items: { from: Address; to: Name; fn: string; args: readonly unknown[]; gas?: bigint }[], at: number) {
  const results = await chain.burst(
    items.map((i) => ({
      req: { from: i.from, to: addr[i.to], abi: art[i.to].abi, functionName: i.fn, args: i.args, gas: i.gas ?? GAS[i.fn] ?? 800_000n },
      label: i.fn,
    })),
    at,
  );
  for (let k = 0; k < items.length; k++) {
    ledger.apply(results[k], { fn: items[k].fn, from: items[k].from, args: items[k].args, phase });
    tally(items[k].fn, outcomeOf(items[k].fn, results[k]));
  }
  now = Math.max(now, chain.lastTs);
  await checkTotals();
  return results;
}

// ------------------------------------------------------------------ the bots, as the Worker runs them

const botLog: string[] = [];
const log = (bot: string) => (line: string) => {
  if (!line.startsWith('waiting')) botLog.push(`${iso(now)} ${bot}: ${line}`);
};
let priceBotDown = false;

async function priceBot() {
  if (priceBotDown) return;
  try {
    await runPriceBot(
      {
        dryRun: false,
        log: log('price'),
        latestEnd: async () => {
          const r = ledger.s.rounds;
          return r.length === 0 ? 0 : r[r.length - 1].intervalEnd;
        },
        fetchRows: async (nowMs) => rowsFor(nowMs),
        submit: async (round) => {
          const result = await tx(role.reporter, 'feed', 'submitPrice', [FEED_ID, BigInt(round.intervalEnd), BigInt(round.priceCents), round.sourceHash]);
          if (!result.ok) throw new Error(result.error);
          return result.hash;
        },
      },
      now * 1000,
    );
  } catch (error) {
    log('price')(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const keeperFailures = new Map<string, number>();
async function keeper(maxPerRun = 20) {
  if (ledger.pendingPerpOrders().length === 0 && ledger.pendingPoolRequests().length === 0) return 0;
  const [nextOrder, nextPool] = await Promise.all([
    chain.read<bigint>(addr.perp, art.perp.abi, 'nextOrderId'),
    chain.read<bigint>(addr.perp, art.perp.abi, 'nextPoolRequestId'),
  ]);
  return runKeeper(
    {
      dryRun: false,
      log: log('keeper'),
      // as bots/worker.ts: the last 300 ids of each, pending ones, oldest first
      pending: async () => {
        const recentOrders = ledger.pendingPerpOrders().filter((o) => o.id >= Number(nextOrder) - 300);
        const recentPool = ledger.pendingPoolRequests().filter((r) => r.id >= Number(nextPool) - 300);
        const items: PendingItem[] = [
          ...recentOrders.toSorted((a, b) => a.id - b.id).map((o) => ({ kind: 'order' as const, id: o.id, createdAt: o.createdAt })),
          ...recentPool.toSorted((a, b) => a.id - b.id).map((r) => ({ kind: 'pool' as const, id: r.id, createdAt: r.createdAt })),
        ];
        return items.toSorted((a, b) => a.createdAt - b.createdAt);
      },
      latestRoundId: async () => ledger.s.rounds.length,
      publishedAt: async (roundId) => ledger.s.rounds[roundId - 1].publishedAt,
      execute: async (item, roundId) => {
        const fn = item.kind === 'order' ? 'executeOrder' : 'executePoolRequest';
        const args = [BigInt(item.id), BigInt(roundId)];
        // the Worker's writeContract estimates gas first, so a reverting execution is never sent
        const dry = await chain.check({ from: role.keeper, to: addr.perp, abi: art.perp.abi, functionName: fn, args });
        if (!dry.ok) {
          keeperFailures.set(dry.name, (keeperFailures.get(dry.name) ?? 0) + 1);
          throw new Error(dry.text);
        }
        const result = await tx(role.keeper, 'perp', fn, args);
        if (!result.ok) throw new Error(result.error);
        return result.hash;
      },
    },
    maxPerRun,
  );
}

let quoteBotOn = true;
async function quoteBot() {
  if (!quoteBotOn) return;
  const today = texasDayKey(now * 1000);
  const history = daRecords.filter((r) => r.dayKey <= today).map((r) => r.value / 100);
  try {
    await runQuoteBot(
      {
        band: { floor: Number(band.floorCents) / 100, cap: Number(band.capCents) / 100 },
        closeRule: 'dayAheadAuction',
        isListed: async (dayKey) => ledger.s.expiries[dayKey] !== undefined,
        openExpiry: async (plan) => {
          const result = await tx(role.quoter, 'options', 'openExpiry', [plan.dayKey, BigInt(plan.tradingCloseUtc)]);
          if (!result.ok) throw new Error(result.error);
          return result.hash;
        },
        postQuotes: async (dayKey: number, version: BotQuoteVersion) => {
          const quotes = version.quotes.map((q) => ({
            callAsk: BigInt(q.callAsk), callBid: BigInt(q.callBid), putAsk: BigInt(q.putAsk), putBid: BigInt(q.putBid),
          }));
          ledger.postingQuotes = Object.fromEntries(version.strikesCents.map((s, i) => [String(s), quotes[i]]));
          const result = await tx(role.quoter, 'options', 'postQuotes', [dayKey, version.strikesCents.map(BigInt), quotes]);
          ledger.postingQuotes = null;
          if (!result.ok) throw new Error(result.error);
          return result.hash;
        },
        history: async () => history,
        dayAhead: async () => null,
        log: log('quote'),
        dryRun: false,
      },
      now * 1000,
    );
  } catch (error) {
    log('quote')(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ------------------------------------------------------------------ the oracle (the daily settlement prices)

async function publishReading(dayKey: number, valueCents: bigint, label = 'real') {
  const start = BigInt(texasDayStartMs(dayKey) / 1000);
  const end = BigInt(texasDayStartMs(addDays(dayKey, 1)) / 1000);
  const hash = (daByDay.get(dayKey)?.sourceHash ? `0x${daByDay.get(dayKey)!.sourceHash}` : keccak256(toBytes(`${label}:${dayKey}`))) as Hex;
  await tx(role.oracleReporter, 'oracle', 'submitReading', [METRIC_ID, dayKey, start, end, valueCents, hash]);
}
async function finalizeReading(dayKey: number) {
  await tx(role.keeper, 'oracle', 'finalize', [METRIC_ID, dayKey]);
}

// ------------------------------------------------------------------ wallets

const minted = new Map<Address, bigint>();
const cashOf = (a: Address) => {
  const net = ledger.s.netCash[a];
  return (minted.get(a) ?? 0n) + (net ? net.perp + net.options : 0n);
};
async function fund(a: Address, dollars: bigint) {
  await tx(a, 'usdt', 'mint', [a, dollars * USD]);
  minted.set(a, (minted.get(a) ?? 0n) + dollars * USD);
}

// ------------------------------------------------------------------ what traders do

const latestQuotes = (dayKey: number) => {
  const v = ledger.s.expiries[dayKey]?.versions;
  return v && v.length ? v[v.length - 1].quotes : undefined;
};
const openExpiries = (at: number) =>
  Object.entries(ledger.s.expiries)
    .filter(([, e]) => e.close > at + 60 && e.versions.length > 0)
    .map(([d]) => Number(d));

const attempts = { perpOpen: 0, perpClose: 0, optBuy: 0, optSell: 0, cancels: 0, poolMoves: 0, claims: 0 };

function limitFor(isLong: boolean, index: bigint): bigint {
  const r = rand();
  const slack = r < 0.75 ? uniform(2, 20) : r < 0.9 ? uniform(0, 0.5) : -uniform(0.5, 5);
  const limit = index + (isLong ? cents(slack) : -cents(slack));
  const lo = band.floorCents + 1n;
  const hi = band.capCents - 1n;
  return limit < lo ? lo : limit > hi ? hi : limit;
}

async function perpOpen(who: Address, at: number, size?: bigint, isLongArg?: boolean) {
  const idx = ledger.latestIndex();
  const shown = idx === null ? (ledger.s.rounds.at(-1)?.priceCents ?? 4000n) : clamp(idx, band);
  const isLong = isLongArg ?? rand() < 0.5;
  const sz = size ?? BigInt(Math.round(logUniform(100, 100_000)));
  const limit = limitFor(isLong, shown);
  const worst = isLong ? limit - band.floorCents : band.capCents - limit;
  const escrow = value(sz, worst) + value(sz, 30_000n) / 1000n;
  if (escrow > cashOf(who)) return;
  attempts.perpOpen++;
  await tx(who, 'perp', 'requestOpen', [isLong, sz, limit], at);
}

async function perpClose(who: Address, at: number) {
  const mine = ledger.openPositions().filter((p) => p.account === who && p.closeOrderId === 0);
  if (mine.length === 0) return perpOpen(who, at);
  attempts.perpClose++;
  await tx(who, 'perp', 'requestClose', [BigInt(pick(mine).id)], at);
}

async function optionBuy(who: Address, at: number) {
  const days = openExpiries(at);
  if (days.length === 0) return;
  const dayKey = pick(days);
  const quotes = latestQuotes(dayKey)!;
  const strike = BigInt(pick(Object.keys(quotes)));
  const isCall = rand() < 0.5;
  const q = quotes[strike.toString()];
  const ask = isCall ? q.callAsk : q.putAsk;
  if (ask === 0n) return;
  const max = maxPayoutCents(strike, isCall, band);
  let limit = BigInt(Math.max(1, Math.round(Number(ask) * uniform(0.9, 1.25))));
  if (limit > max) limit = max;
  const size = BigInt(Math.round(logUniform(100, 20_000)));
  if (value(size, limit) > cashOf(who)) return;
  attempts.optBuy++;
  await tx(who, 'options', 'requestBuy', [dayKey, strike, isCall, size, limit], at);
}

async function optionSell(who: Address, at: number) {
  const holdings = Object.values(ledger.s.series).filter(
    (s) => !s.settled && !s.voided && (s.holders[who]?.bal ?? 0n) >= 100n && (ledger.s.expiries[s.dayKey]?.close ?? 0) > at + 60,
  );
  if (holdings.length === 0) return optionBuy(who, at);
  const s = pick(holdings);
  const bal = s.holders[who].bal;
  const size = rand() < 0.5 ? bal : BigInt(Math.max(100, Math.round(Number(bal) * uniform(0.2, 1))));
  const q = latestQuotes(s.dayKey)?.[s.strike.toString()];
  const bid = q ? (s.isCall ? q.callBid : q.putBid) : 0n;
  const limit = BigInt(Math.max(0, Math.floor(Number(bid) * uniform(0.75, 1.05))));
  attempts.optSell++;
  await tx(who, 'options', 'requestSell', [s.dayKey, s.strike, s.isCall, size > bal ? bal : size, limit], at);
}

async function tryCancel(who: Address, at: number) {
  const perp = ledger.pendingPerpOrders().filter((o) => o.account === who);
  const opts = ledger.pendingOptOrders().filter((o) => o.account === who);
  if (perp.length) {
    attempts.cancels++;
    await tx(who, 'perp', 'cancelOrder', [BigInt(pick(perp).id)], at);
  } else if (opts.length) {
    attempts.cancels++;
    await tx(who, 'options', 'cancelOrder', [BigInt(pick(opts).id)], at);
  }
}

async function poolMove(at: number) {
  const lp = pick(lps);
  attempts.poolMoves++;
  if (rand() < 0.5) {
    const amount = BigInt(Math.round(uniform(10_000, 100_000))) * USD;
    if (amount > cashOf(lp)) return;
    await tx(lp, 'perp', 'requestDeposit', [amount], at);
  } else {
    const shares = ledger.s.lpBalances[lp] ?? 0n;
    if (shares === 0n) return;
    await tx(lp, 'perp', 'requestWithdraw', [(shares * BigInt(Math.round(uniform(5, 30)))) / 100n], at);
  }
}

/** Holders of settled (or voidable) series claim. */
async function claimSome(at: number, n: number) {
  const claimable: { who: Address; dayKey: number; strike: bigint; isCall: boolean }[] = [];
  for (const s of Object.values(ledger.s.series)) {
    const reading = ledger.s.readings[s.dayKey];
    if (!reading?.final && !s.settled) continue;
    for (const [who, h] of Object.entries(s.holders))
      if (h.bal > 0n) claimable.push({ who: who as Address, dayKey: s.dayKey, strike: s.strike, isCall: s.isCall });
  }
  for (let i = 0; i < n && claimable.length; i++) {
    const c = claimable.splice(Math.floor(rand() * claimable.length), 1)[0];
    attempts.claims++;
    await tx(c.who, 'options', 'claim', [c.dayKey, c.strike, c.isCall], at);
  }
}

async function traderAction(at: number) {
  const who = pick(traders);
  const r = rand();
  if (r < 0.34) return perpOpen(who, at);
  if (r < 0.56) return perpClose(who, at);
  if (r < 0.76) return optionBuy(who, at);
  if (r < 0.86) return optionSell(who, at);
  if (r < 0.9) return tryCancel(who, at);
  if (r < 0.93) return poolMove(at);
  return claimSome(at, 1);
}

// ------------------------------------------------------------------ can every holder always get out?

const exitChecks = { runs: 0, calls: 0, blockedSells: 0 };
async function canEveryoneExit() {
  exitChecks.runs++;
  const checks: { what: string; req: Parameters<Chain['check']>[0] }[] = [];
  for (const p of ledger.openPositions())
    if (p.closeOrderId === 0)
      checks.push({ what: `close position ${p.id}`, req: { from: p.account, to: addr.perp, abi: art.perp.abi, functionName: 'requestClose', args: [BigInt(p.id)] } });
  for (const lp of lps) {
    const shares = ledger.s.lpBalances[lp] ?? 0n;
    if (shares > 0n)
      checks.push({ what: `withdraw for ${lp}`, req: { from: lp, to: addr.perp, abi: art.perp.abi, functionName: 'requestWithdraw', args: [shares] } });
  }
  for (const s of Object.values(ledger.s.series)) {
    const close = ledger.s.expiries[s.dayKey]?.close ?? 0;
    for (const [who, h] of Object.entries(s.holders)) {
      if (h.bal === 0n) continue;
      if (s.settled || ledger.s.readings[s.dayKey]?.final)
        checks.push({ what: `claim ${s.dayKey}`, req: { from: who as Address, to: addr.options, abi: art.options.abi, functionName: 'claim', args: [s.dayKey, s.strike, s.isCall] } });
      else if (now < close && h.bal >= 100n)
        checks.push({ what: `sell back ${s.dayKey}`, req: { from: who as Address, to: addr.options, abi: art.options.abi, functionName: 'requestSell', args: [s.dayKey, s.strike, s.isCall, h.bal, 0n] } });
    }
  }
  for (let i = 0; i < checks.length; i += 100) {
    const chunk = checks.slice(i, i + 100);
    const results = await Promise.all(chunk.map((c) => chain.check(c.req)));
    exitChecks.calls += chunk.length;
    results.forEach((r, k) => {
      if (r.ok) return;
      if (r.name === 'TooManyPendingOrders') {
        exitChecks.blockedSells++;
        return;
      }
      ledger.fail('every holder can always close, withdraw, sell back or claim', `${chunk[k].what}: ${r.text}`);
    });
  }
}

// ------------------------------------------------------------------ setup

console.log(`GRIDFLEX market simulation: ${DAYS} days from ${fixture.firstTexasDay}, seed ${SEED}, ${TRADERS} traders, ${LPS} pool providers`);
console.log(`  deploy settings from DeployDerivatives.s.sol: band ${band.floorCents}..${band.capCents} cents, strikes every ${STRIKE_STEP}, options on ${METRIC}`);
now = START + 10;
await fund(role.owner, 2_000_000n);
await tx(role.owner, 'usdt', 'approve', [addr.options, maxUint256]);
await tx(role.owner, 'options', 'fundPool', [1_500_000n * USD]);
for (const lp of lps) {
  await fund(lp, 500_000n);
  await tx(lp, 'usdt', 'approve', [addr.perp, maxUint256]);
  await tx(lp, 'perp', 'deposit', [BigInt(Math.round(uniform(200_000, 350_000))) * USD]);
}
for (const t of traders) {
  await fund(t, BigInt(Math.round(logUniform(20_000, 250_000))));
  await tx(t, 'usdt', 'approve', [addr.perp, maxUint256]);
  await tx(t, 'usdt', 'approve', [addr.options, maxUint256]);
}
console.log(`  setup done: ${chain.txCount} transactions, futures pool $${ledger.s.perp.poolCash / USD}, options pool $${ledger.s.options.poolCash / USD}`);

// ------------------------------------------------------------------ the edge-case schedule

const edgeLog: { at: string; what: string; result: string }[] = [];
const note = (what: string, result: string) => edgeLog.push({ at: iso(now), what, result });
interface Scheduled {
  at: number;
  run: () => Promise<void>;
}
const schedule: Scheduled[] = [];
const at = (ts: number, run: () => Promise<void>) => schedule.push({ at: ts, run });

// 1. the price bot is down for 25 minutes: it comes back with the newest three prices only
at(T(0, '06:00'), async () => {
  priceBotDown = true;
  note('price bot down for 25 minutes', 'no prices published');
});
at(T(0, '06:25') + 30, async () => {
  priceBotDown = false;
  const before = ledger.s.rounds.length;
  await priceBot();
  note('price bot back', `published ${ledger.s.rounds.length - before} rounds (newest three); older intervals stay a gap`);
});
// 2. GridStatus never has one interval: a one-interval gap
missingFromSource.add(T(0, '14:05'));
note('source gap planned', `interval ending ${iso(T(0, '14:05'))} missing from the data source`);
// 3. a burst: every trader sends a futures order, and 120 option buys hit one day, all in the same block
at(T(1, '10:01') + 30, async () => {
  const idx = clamp(ledger.latestIndex() ?? 4000n, band);
  const items: Parameters<typeof burst>[0] = [];
  for (const t of traders) {
    const isLong = rand() < 0.5;
    const size = BigInt(Math.round(uniform(1_000, 20_000)));
    const limit = isLong ? (idx + 3000n < band.capCents ? idx + 3000n : band.capCents - 1n) : idx - 3000n > band.floorCents ? idx - 3000n : band.floorCents + 1n;
    items.push({ from: t, to: 'perp', fn: 'requestOpen', args: [isLong, size, limit] });
  }
  const days = openExpiries(now).sort((a, b) => a - b);
  const day = days[0];
  const quotes = latestQuotes(day)!;
  const strikes = Object.keys(quotes);
  for (let i = 0; i < 120; i++) {
    const strike = BigInt(strikes[i % strikes.length]);
    const isCall = i % 2 === 0;
    const q = quotes[strike.toString()];
    const ask = isCall ? q.callAsk : q.putAsk;
    const limit = ask === 0n ? 1n : (ask * 125n) / 100n + 1n;
    const max = maxPayoutCents(strike, isCall, band);
    items.push({ from: traders[i], to: 'options', fn: 'requestBuy', args: [day, strike, isCall, 1_000n, limit > max ? max : limit] });
  }
  const results = await burst(items, now + 1);
  const perpOk = results.slice(0, TRADERS).filter((r) => r.ok).length;
  const optOk = results.slice(TRADERS).filter((r) => r.ok).length;
  const reasons = new Map<string, number>();
  for (const r of results) if (!r.ok) reasons.set(r.errorName!, (reasons.get(r.errorName!) ?? 0) + 1);
  note('burst: 200 futures orders + 120 option buys in one block',
    `${perpOk} futures orders and ${optOk} option orders accepted; refused: ${[...reasons].map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}; block gas ${results.reduce((s, r) => s + r.gasUsed, 0n)}`);
  burstDay = day;
});
let burstDay = 0;
// 4. the feed is paused by the guardian (a bad price), traders take back their orders, owner unpauses
at(T(2, '15:02') + 30, async () => {
  await tx(role.guardian, 'feed', 'pause', []);
  note('guardian pauses the price feed', 'no prices, no fills; trading orders wait');
});
at(T(2, '15:19'), async () => {
  let ok = 0;
  let tried = 0;
  for (const o of ledger.pendingPerpOrders()) {
    tried++;
    if ((await tx(o.account, 'perp', 'cancelOrder', [BigInt(o.id)])).ok) ok++;
  }
  for (const r of ledger.pendingPoolRequests()) {
    tried++;
    if ((await tx(r.account, 'perp', 'cancelPoolRequest', [BigInt(r.id)])).ok) ok++;
  }
  note('traders cancel while the feed is paused', `${ok} of ${tried} pending futures orders and pool requests cancelled and refunded`);
});
at(T(2, '15:25') + 20, async () => {
  await tx(role.owner, 'feed', 'unpause', []);
  note('owner unpauses the feed', 'prices resume');
});
// 5. the futures market is paused for 30 minutes: new opens refused, closes keep working
at(T(3, '09:00') + 70, async () => {
  await tx(role.guardian, 'perp', 'pause', []);
  note('guardian pauses futures', 'opens refused, pending opens cancel at their fill, closes still fill');
});
at(T(3, '09:30') + 70, async () => {
  await tx(role.owner, 'perp', 'unpause', []);
  note('owner unpauses futures', '');
});
// 6. the options market is paused: the quote bot cannot post, traders take back their orders
at(T(3, '10:00') + 70, async () => {
  await tx(role.guardian, 'options', 'pause', []);
  note('guardian pauses options', 'no quotes, no buys');
});
at(T(3, '10:12'), async () => {
  let ok = 0;
  const pending = ledger.pendingOptOrders();
  for (const o of pending) if ((await tx(o.account, 'options', 'cancelOrder', [BigInt(o.id)])).ok) ok++;
  note('traders cancel options orders while paused', `${ok} of ${pending.length} cancelled and refunded`);
});
at(T(3, '10:30') + 70, async () => {
  await tx(role.owner, 'options', 'unpause', []);
  note('owner unpauses options', '');
});
// 7. the price bot is down for 40 minutes, longer than the 15-minute order timeout
at(T(4, '08:00') + 10, async () => {
  priceBotDown = true;
  note('price bot down for 40 minutes', '');
});
at(T(4, '08:20'), async () => {
  let ok = 0;
  let tried = 0;
  for (const o of ledger.pendingPerpOrders()) {
    tried++;
    if ((await tx(o.account, 'perp', 'cancelOrder', [BigInt(o.id)])).ok) ok++;
  }
  for (const r of ledger.pendingPoolRequests()) {
    tried++;
    if ((await tx(r.account, 'perp', 'cancelPoolRequest', [BigInt(r.id)])).ok) ok++;
  }
  note('traders cancel orders older than 15 minutes with no price since', `${ok} of ${tried} cancelled (younger ones must wait)`);
});
at(T(4, '08:40') + 30, async () => {
  priceBotDown = false;
  await priceBot();
  note('price bot back after 40 minutes', 'newest three prices published');
});
// 8. exact band-edge prices (synthetic, in place of the real ones): three at exactly -$50, three at exactly $300
for (let i = 0; i < 3; i++) syntheticLmp.set(T(5, '12:05') + i * INTERVAL, -50);
for (let i = 0; i < 3; i++) syntheticLmp.set(T(5, '12:20') + i * INTERVAL, 300);
at(T(5, '12:00') + 90, async () => {
  for (let i = 0; i < 10; i++) await perpOpen(pick(traders), now, 5_000n);
  note('orders placed before exact -$50 prices', 'opens must cancel on the band edge; closes fill at the floor');
});
at(T(5, '12:15') + 90, async () => {
  for (let i = 0; i < 10; i++) await perpOpen(pick(traders), now, 5_000n);
  for (let i = 0; i < 10; i++) await perpClose(pick(traders), now);
});
// 9. the owner raises the funding rate from 1 to 5 cents per MWh per hour (fee unchanged)
at(T(6, '00:00') + 100, async () => {
  const fee = await chain.read<bigint>(addr.perp, art.perp.abi, 'feeBps');
  await tx(role.owner, 'perp', 'setSettings', [fee, 5n, 900n, 900n, 1_000_000n]);
  note('owner raises funding to 5 cents/MWh/hour', 'accrued at the old rate up to the change');
});
// 10. drills: everyone tries to get out at once (run on a copy of the chain, then undone)
const drills: { at: string; result: string }[] = [];
at(T(1, '19:00') + 200, async () => drill('spike day (16 Sep)'));
at(T(8, '09:00') + 200, async () => drill('negative-price day (23 Sep)'));

schedule.sort((a, b) => a.at - b.at);

// ------------------------------------------------------------------ settling everything that is pending

function fillRound(createdAt: number) {
  const i = ledger.s.rounds.findIndex((rd) => rd.publishedAt > createdAt);
  return i < 0 ? null : i + 1;
}

/**
 * Orders and pool requests the keeper will never reach (more than 300 ids old, outside the
 * Worker's window) whose fill round has come out: their owners execute them.
 */
async function ownersExecute(): Promise<number> {
  let n = 0;
  const [nextOrder, nextPool] = (await chain.readMany([
    { address: addr.perp, abi: art.perp.abi, functionName: 'nextOrderId' },
    { address: addr.perp, abi: art.perp.abi, functionName: 'nextPoolRequestId' },
  ])) as bigint[];
  for (const o of ledger.pendingPerpOrders()) {
    const R = fillRound(o.createdAt);
    if (R !== null && o.id < Number(nextOrder) - 300)
      if ((await tx(o.account, 'perp', 'executeOrder', [BigInt(o.id), BigInt(R)])).ok) n++;
  }
  for (const q of ledger.pendingPoolRequests()) {
    const R = fillRound(q.createdAt);
    if (R !== null && q.id < Number(nextPool) - 300)
      if ((await tx(q.account, 'perp', 'executePoolRequest', [BigInt(q.id), BigInt(R)])).ok) n++;
  }
  return n;
}

/**
 * New prices and keeper runs until no futures order or pool request is pending (and, with
 * `closeAll`, no position is open); what the keeper never reaches, its owner executes.
 */
async function settleAll(maxRounds: number, closeAll: boolean, publish: () => Promise<void> = priceBot) {
  const started = now;
  let rounds = 0;
  let byOwner = 0;
  const busy = () => (closeAll && ledger.openPositions().length > 0) || ledger.pendingPerpOrders().length > 0 || ledger.pendingPoolRequests().length > 0;
  if (closeAll) for (const p of ledger.openPositions()) if (p.closeOrderId === 0) await tx(p.account, 'perp', 'requestClose', [BigInt(p.id)]);
  while (busy() && rounds < maxRounds) {
    now = (Math.floor(now / INTERVAL) + 1) * INTERVAL + 60;
    await publish();
    rounds++;
    for (let m = 0; m < 4; m++) {
      await keeper();
      now += 60;
    }
    byOwner += await ownersExecute();
    // closes dropped across a gap are asked again; opens with no price for 15 minutes are taken back
    if (closeAll) for (const p of ledger.openPositions()) if (p.closeOrderId === 0) await tx(p.account, 'perp', 'requestClose', [BigInt(p.id)]);
    for (const o of ledger.pendingPerpOrders())
      if (now >= o.createdAt + 900 && fillRound(o.createdAt) === null) await tx(o.account, 'perp', 'cancelOrder', [BigInt(o.id)]);
  }
  return { rounds, byOwner, minutes: Math.round((now - started) / 60) };
}

// ------------------------------------------------------------------ a drill: everyone exits at once, then undo

async function drill(label: string) {
  const saved = ledger.save();
  const savedNow = now;
  const snap = await chain.snapshot();
  const before = ledger.violations.length;
  phase = `drill: ${label}`;
  const positions = ledger.openPositions().length;
  const { rounds, byOwner, minutes } = await settleAll(24, true);
  let paid = 0n;
  let lpsOut = 0;
  for (const lp of lps) {
    const shares = ledger.s.lpBalances[lp] ?? 0n;
    if (shares === 0n) continue;
    const r = await tx(lp, 'perp', 'withdraw', [shares]);
    if (r.ok) {
      lpsOut++;
      paid += BigInt(r.logs.find((l) => l.eventName === 'Withdrawn')?.args.assets as bigint);
    }
  }
  const result = `${positions} positions closed in ${minutes} minutes, ${rounds} prices (${ledger.openPositions().length} left; the keeper executes 20 a minute; ${byOwner} closes more than 300 orders back, which the keeper never looks at, executed by their owners); ${lpsOut} of ${lps.filter((l) => (saved.s.lpBalances[l] ?? 0n) > 0n).length} providers withdrew $${paid / USD}; ${ledger.violations.length - before} broken rules`;
  drills.push({ at: iso(savedNow), result: `${label}: ${result}` });
  console.log(`  drill ${label}: ${result}`);
  await chain.revert(snap, savedNow);
  ledger.restore(saved);
  now = savedNow;
  phase = 'main';
}

// ------------------------------------------------------------------ the replay

phase = 'main';
const startedAt = Date.now();
const intervals = DAYS * 288;
let next = 0;
const reconcileEvery = 72; // every 6 hours
for (let k = 0; k < intervals; k++) {
  const E = FIRST_END + k * INTERVAL; // this interval's end: its price can be published from E + 60
  const events: { at: number; run: () => Promise<void> }[] = [];
  events.push({ at: E, run: quoteBot });
  events.push({ at: E + 60, run: async () => { await priceBot(); await keeper(); } });
  for (const m of [120, 180, 240]) events.push({ at: E + m, run: async () => { await keeper(); } });
  const n = poisson(LAMBDA);
  for (let i = 0; i < n; i++) {
    const t = E + 61 + Math.floor(rand() * 235);
    events.push({ at: t, run: () => traderAction(t) });
  }
  while (next < schedule.length && schedule[next].at < E + INTERVAL) events.push(schedule[next++]);
  // the oracle: each day's day-ahead average is published 00:20 UTC on the day and finalized after an hour
  for (const dayKey of Object.keys(ledger.s.expiries).map(Number)) {
    const pub = Date.UTC(Math.floor(dayKey / 10_000), Math.floor((dayKey % 10_000) / 100) - 1, dayKey % 100, 0, 20) / 1000;
    const fin = pub + Number(ORACLE_DISPUTE_WINDOW) + 300;
    const da = daByDay.get(dayKey);
    if (!da || dayKey === VOID_DAY) continue;
    if (pub >= E && pub < E + INTERVAL) events.push({ at: pub, run: () => publishReading(dayKey, BigInt(da.value)) });
    if (fin >= E && fin < E + INTERVAL) events.push({ at: fin, run: () => finalizeReading(dayKey) });
  }
  // claimers: a few holders of settled days claim each interval
  events.push({ at: E + 290, run: () => claimSome(E + 290, 2) });
  events.sort((a, b) => a.at - b.at);
  for (const ev of events) {
    now = Math.max(now, ev.at);
    await ev.run();
  }
  if (k % 36 === 35) await canEveryoneExit(); // every 3 hours
  if (k % reconcileEvery === reconcileEvery - 1) {
    await reconcileSeries();
    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
    const slow = [...chain.timing].toSorted((a, b) => b[1].ms - a[1].ms).slice(0, 3).map(([m, t]) => `${m} ${(t.ms / 1000).toFixed(0)}s`).join(', ');
    console.log(`  ${iso(E + INTERVAL)}  [${slow}]  ${chain.txCount} tx, ${ledger.openPositions().length} open positions, futures pool $${ledger.s.perp.poolCash / USD}, options pool $${ledger.s.options.poolCash / USD}, ${ledger.violations.length} broken rules (${minutes} min)`);
  }
}

/** Every series and holder in the shadow books against the contract, field by field. */
async function reconcileSeries() {
  const reads: Promise<void>[] = [];
  for (const s of Object.values(ledger.s.series)) {
    reads.push(
      chain.read<readonly [boolean, boolean, bigint, bigint, bigint]>(addr.options, art.options.abi, 'series', [s.id]).then((c) => {
        if (c[0] !== s.settled || c[1] !== s.voided || c[3] !== s.openSize || c[4] !== s.premiumOpen)
          ledger.fail('options: each series matches the books', `${s.dayKey} ${s.isCall ? 'call' : 'put'} ${s.strike}: chain ${c.join('/')}, books ${s.settled}/${s.voided}/${s.openSize}/${s.premiumOpen}`);
      }),
    );
    let held = 0n;
    let paid = 0n;
    for (const [who, h] of Object.entries(s.holders)) {
      held += h.bal;
      paid += h.paid;
      reads.push(
        chain.read<bigint>(addr.options, art.options.abi, 'balanceOf', [s.id, who]).then((b) => {
          if (b !== h.bal) ledger.fail('options: each holding matches the books', `${who} ${s.dayKey} ${s.strike}: ${b} vs ${h.bal}`);
        }),
      );
    }
    for (const o of ledger.pendingOptOrders())
      if (!o.isBuy && seriesIdOf(o.dayKey, o.strike, o.isCall) === s.id) {
        held += o.size;
        paid += o.escrow;
      }
    if (!s.settled && !s.voided && (held !== s.openSize || paid !== s.premiumOpen))
      ledger.fail('options: open size = holdings + options in sell orders', `${s.dayKey} ${s.strike}: ${held}/${paid} vs ${s.openSize}/${s.premiumOpen}`);
  }
  await Promise.all(reads);
}

const mainEnd = now;
const mainTx = chain.txCount;
console.log(`  replay done: ${chain.txCount} transactions in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);

// ------------------------------------------------------------------ targeted cases, each on a copy of the chain

const scenarios: ScenarioResult[] = [];
async function scenario(name: string, run: (r: ScenarioResult) => Promise<void>) {
  const saved = ledger.save();
  const savedNow = now;
  const snap = await chain.snapshot();
  const before = ledger.violations.length;
  const synthetic = new Map(syntheticLmp);
  const mintedBefore = new Map(minted);
  phase = `case: ${name}`;
  const r: ScenarioResult = { name, verdict: 'as designed', steps: [], brokenRules: [] };
  try {
    await run(r);
  } catch (error) {
    r.verdict = 'error';
    r.steps.push(`the case itself failed: ${error instanceof Error ? error.stack : String(error)}`);
  }
  r.brokenRules = ledger.violations.slice(before).map((v) => `${v.check}: ${v.detail}`);
  scenarios.push(r);
  console.log(`  case "${name}": ${r.verdict}`);
  syntheticLmp.clear();
  for (const [k2, v] of synthetic) syntheticLmp.set(k2, v);
  minted.clear();
  for (const [k2, v] of mintedBefore) minted.set(k2, v);
  await chain.revert(snap, savedNow);
  ledger.restore(saved, false);
  now = savedNow;
}

/** Publishes the next round at a chosen price, as the reporter (for exact cases only). */
async function publishPrice(dollars: number) {
  const last = ledger.s.rounds.at(-1)!;
  const end = last.intervalEnd + INTERVAL;
  now = Math.max(now, end + 60);
  syntheticLmp.set(end, dollars);
  await tx(role.reporter, 'feed', 'submitPrice', [FEED_ID, BigInt(end), cents(dollars), keccak256(toBytes(`case:${end}`))]);
}
/** Runs the keeper the way the Worker does, every minute for `minutes`. */
async function keeperMinutes(minutes: number) {
  for (let i = 0; i < minutes; i++) {
    await keeper();
    now += 60;
  }
}
/** Big longs from fresh wallets until the futures pool has less than `targetFree` dollars unreserved. */
async function reservePool(wallets: Address[], targetFree: bigint, limitCents: bigint) {
  let used = 0;
  for (let round = 0; round < 8; round++) {
    const free = ledger.s.perp.poolCash - ledger.s.perp.totalReserved;
    if (free < targetFree * USD) break;
    // a pending open holds the whole band; after its fill only cap - price stays reserved
    const perMwh = value(1000n, band.capCents - band.floorCents);
    let left = free;
    while (left >= perMwh / 10n && used < wallets.length) {
      const w = wallets[used];
      const room = 1_000_000n - (ledger.s.accountSize[w] ?? 0n);
      let size = (left * 1000n) / perMwh;
      if (size > room) size = room;
      if (size < 100n) {
        used++;
        continue;
      }
      if (cashOf(w) < 300_000n * USD) await fund(w, 300_000n);
      const res = await tx(w, 'perp', 'requestOpen', [true, size, limitCents]);
      if (!res.ok) break;
      left -= value(size, band.capCents - band.floorCents);
      if ((ledger.s.accountSize[w] ?? 0n) >= 1_000_000n - 100n) used++;
    }
    await publishPrice(Number(clamp(ledger.latestIndex() ?? 4000n, band)) / 100);
    await keeperMinutes(4);
  }
  return ledger.s.perp.poolCash - ledger.s.perp.totalReserved;
}
const newWallets = accounts.slice(20 + TRADERS - 40, 20 + TRADERS); // the last 40 traders act in the cases

if (!opt['skip-scenarios']) {
  await scenario('owner raises the fee while an order waits', async (r) => {
    const [a] = newWallets;
    for (let i = 0; i < 3; i++) await publishPrice(40);
    const limit = 4000n; // a long that accepts at most $40.00, and the next price is exactly $40.00
    const req = await tx(a, 'perp', 'requestOpen', [true, 10_000n, limit]);
    const orderId = Number(req.logs.find((l) => l.eventName === 'OrderRequested')!.args.orderId);
    r.steps.push(`a trader asks to open a 10 MWh long at no more than $40.00 (order ${orderId})`);
    await tx(role.owner, 'perp', 'setSettings', [100n, 1n, 900n, 900n, 1_000_000n]);
    r.steps.push('the owner raises the trading fee from 0.10% to 1.00% (the most setSettings allows) before the next price');
    await publishPrice(40);
    const dry = await chain.check({ from: role.keeper, to: addr.perp, abi: art.perp.abi, functionName: 'executeOrder', args: [BigInt(orderId), BigInt(ledger.s.rounds.length)] });
    r.steps.push(`the next price is $40.00; executeOrder at that round: ${dry.ok ? 'fills' : dry.text}`);
    await keeperMinutes(3);
    const stillPending = ledger.s.perpOrders[orderId] !== undefined;
    r.steps.push(`after 3 keeper runs the order is ${stillPending ? 'still pending' : 'resolved'}`);
    now += 20 * 60;
    const cancel = await tx(a, 'perp', 'cancelOrder', [BigInt(orderId)]);
    r.steps.push(`20 minutes later the trader tries to cancel: ${cancel.ok ? 'cancelled' : cancel.error}`);
    if (!dry.ok && stillPending && !cancel.ok) {
      r.verdict = 'BUG';
      r.steps.push('the order can neither fill nor be cancelled: its escrow and the pool reserve stay locked');
      await tx(role.guardian, 'perp', 'pause', []);
      await keeperMinutes(1);
      r.steps.push(`way out: the guardian pauses futures, then the keeper's execute cancels it ("market paused") and refunds: ${ledger.s.perpOrders[orderId] ? 'still stuck' : 'refunded'}`);
      r.steps.push('the escrow covers the largest fee at the fee rate of the request, but the fill charges the fee rate of the fill; when the rate rises in between, `assert(position.collateral + fee <= order.escrow ...)` in _fillOpen fails (Panic 0x01) for a long that fills at (or within a few cents of) its limit above $30, and for a short the same way');
    }
  });

  await scenario('a withdrawal waits for free cash, then pays at an old price', async (r) => {
    for (let i = 0; i < 3; i++) await publishPrice(40);
    await keeperMinutes(2);
    // close what is open, so the pool is plain cash at $40
    await settleAll(12, true, () => publishPrice(40));
    r.steps.push(`start: no positions open, the price is $40, the futures pool holds $${ledger.s.perp.poolCash / USD}`);
    const free = await reservePool(newWallets, 20_000n, 4500n);
    const longs = ledger.openPositions();
    const longMwh = longs.reduce((t, p) => t + p.size, 0n) / 1000n;
    r.steps.push(`traders open ${longMwh} MWh of longs at $40; the pool has $${free / USD} left unreserved`);
    const big = lps.reduce((best, lp) => ((ledger.s.lpBalances[lp] ?? 0n) > (ledger.s.lpBalances[best] ?? 0n) ? lp : best));
    const shares = ledger.s.lpBalances[big];
    const fairAtRequest = (shares * (ledger.poolValueAt(4000n) + 1n)) / (ledger.s.perp.lpSupply + 1000n);
    const req = await tx(big, 'perp', 'requestWithdraw', [shares]);
    const reqId = Number(req.logs.find((l) => l.eventName === 'PoolRequested')!.args.requestId);
    r.steps.push(`the largest provider (${(Number((shares * 1000n) / ledger.s.perp.lpSupply) / 10).toFixed(1)}% of the pool) asks to withdraw all its shares, worth $${fairAtRequest / USD} at $40`);
    await publishPrice(40);
    const fillRoundId = ledger.s.rounds.length;
    await keeperMinutes(3);
    r.steps.push(`its fill round (round ${fillRoundId}, $40) comes; the withdrawal ${ledger.s.poolRequests[reqId] ? 'cannot be paid (not enough free cash), so it waits, as designed' : 'is paid'}`);
    for (let i = 0; i < 3; i++) await publishPrice(150);
    await keeperMinutes(1);
    r.steps.push('the price climbs to $150: the longs are up $110 per MWh, which the pool owes them');
    const closers = longs.slice(0, Math.ceil(longs.length / 2));
    for (const p of closers) await tx(p.account, 'perp', 'requestClose', [BigInt(p.id)]);
    await publishPrice(150);
    await keeperMinutes(5);
    const dev = ledger.s.poolDeviations.find((d) => d.requestId === reqId);
    if (!dev) {
      r.steps.push('the withdrawal is still waiting');
      return;
    }
    r.steps.push(`half the longs take their profit at $150, cash frees up, and the keeper pays the withdrawal ${Math.round(dev.waitedSeconds / 60)} minutes after its fill round`);
    const atRound = dev.vsFillRound;
    r.steps.push(`the contract values it with the positions still open now but at the fill round's $40, where they show no gain: the provider gets $${(Number(dev.vsNow) / 1e6).toFixed(0)} more than its share is worth at today's $150, and $${(Number(atRound < 0n ? -atRound : atRound) / 1e6).toFixed(0)} ${atRound < 0n ? 'less' : 'more'} than it was worth at its fill round`);
    if (dev.vsNow > USD || dev.vsNow < -USD) {
      r.verdict = 'BUG';
      r.steps.push('the providers who stay carry the difference. `executePoolRequest` prices the request with `_poolValueAt(priceCents)` from the CURRENT poolCash and open positions at the fill round\'s price, so a withdrawal that waits for cash is not "fixed by the fill round" as its NatSpec says: what it gets depends on what traded while it waited (and anyone may pick the moment it executes)');
    }
  });

  await scenario('stuck pool withdrawals block the keeper', async (r) => {
    for (let i = 0; i < 3; i++) await publishPrice(40);
    await keeperMinutes(2);
    const free = await reservePool(newWallets, 3_000n, 4500n);
    r.steps.push(`big longs reserve the futures pool until $${free / USD} is left unreserved`);
    const lp = lps.reduce((best, l) => ((ledger.s.lpBalances[l] ?? 0n) > (ledger.s.lpBalances[best] ?? 0n) ? l : best));
    const shares = ledger.s.lpBalances[lp];
    for (let i = 0; i < 20; i++) await tx(lp, 'perp', 'requestWithdraw', [shares / 20n]);
    const each = ((shares / 20n) * (ledger.poolValueAt(4000n) + 1n)) / (ledger.s.perp.lpSupply + 1000n);
    r.steps.push(`one provider asks for 20 withdrawals of about $${each / USD} each, more than the free cash, so each must wait`);
    const closers = ledger.openPositions().filter((p) => p.closeOrderId === 0).slice(0, 10);
    for (const p of closers) await tx(p.account, 'perp', 'requestClose', [BigInt(p.id)]);
    r.steps.push(`then ${closers.length} traders ask to close; their closes would free the cash the withdrawals wait for`);
    for (let i = 0; i < 4; i++) {
      await publishPrice(40);
      await keeperMinutes(5);
    }
    const closesLeft = closers.filter((p) => ledger.s.positions[p.id]).length;
    r.steps.push(`4 prices and 20 keeper runs later: ${closesLeft} of ${closers.length} closes not executed; every run the keeper retried the same 20 withdrawals`);
    if (closesLeft > 0) {
      r.verdict = 'BUG';
      r.steps.push('runKeeper (lib/keeper.ts) takes the oldest 20 pending items each run (maxPerRun) and counts the ones that revert; when 20 keep reverting it never reaches the rest. Here that is a deadlock: the closes it never runs are what would free the cash. Any 20 requests that keep failing (one provider, or a griefer with a few shares while the pool is fully used) stop every later order from filling');
      const p = closers.find((c) => ledger.s.positions[c.id])!;
      const orderId = ledger.s.positions[p.id].closeOrderId;
      const res = await tx(p.account, 'perp', 'executeOrder', [BigInt(orderId), BigInt(fillRoundFor(orderId))]);
      r.steps.push(`the contract itself is fine: the trader can execute its own close (executeOrder is open to anyone): ${res.ok ? 'filled' : res.error}`);
    }
  });

  await scenario('100 tiny orders fill an expiry\'s queue', async (r) => {
    const days = openExpiries(now).sort((a, b) => a - b);
    const day = days.find((d) => Object.values(ledger.s.series).some((s) => s.dayKey === d && Object.values(s.holders).some((h) => h.bal >= 100n)));
    if (!day) {
      r.steps.push('no open expiry with holders');
      return;
    }
    const holderSeries = Object.values(ledger.s.series).find((s) => s.dayKey === day && Object.values(s.holders).some((h) => h.bal >= 100n))!;
    const [holder] = Object.entries(holderSeries.holders).find(([, h]) => h.bal >= 100n)!;
    const griefer = newWallets[0];
    await fund(griefer, 1_000n);
    const strike = BigInt(Object.keys(latestQuotes(day)!)[0]);
    const room = 100 - ledger.pendingOptOrders(day).length;
    const items = Array.from({ length: room }, () => ({ from: griefer, to: 'options' as Name, fn: 'requestBuy', args: [day, strike, true, 100n, 1n] as const }));
    await burst(items, now + 1);
    r.steps.push(`one wallet sends ${room} buys of 0.1 MWh at a 1-cent limit (they can never fill) on ${day}, all in one block; its cash at risk: $${value(100n * BigInt(room), 1n) / USD}`);
    const sell = await tx(holder as Address, 'options', 'requestSell', [day, holderSeries.strike, holderSeries.isCall, 100n, 0n]);
    const buy = await tx(newWallets[1], 'options', 'requestBuy', [day, strike, false, 1000n, 100n]);
    r.steps.push(`a holder trying to sell back: ${sell.ok ? 'accepted' : sell.error}; a new buyer: ${buy.ok ? 'accepted' : buy.error}`);
    now = (Math.floor(now / INTERVAL) + 1) * INTERVAL;
    await quoteBot();
    const gas = chain.gas.get('postQuotes (50-100 orders waiting)');
    r.steps.push(`the next quote post cancels all ${room} and refunds them (gas ${gas?.at(-1)} for that post); the griefer can repeat every 5 minutes, paying only gas`);
    if (!sell.ok) {
      r.verdict = 'RISK';
      r.steps.push('while the queue is full no one can buy or sell back that day, so a wallet that refills it after every quote post can keep holders from selling until the close. MAX_PENDING bounds the quoter\'s gas; a minimum order size or a per-account cap on pending orders would raise the cost');
    }
    // and the same burst with orders that do fill, for the quoter's worst-case gas
    const q = latestQuotes(day)!;
    const ask = q[strike.toString()].callAsk;
    const fillers = traders.slice(0, 100).map((t) => ({ from: t, to: 'options' as Name, fn: 'requestBuy', args: [day, strike, true, 100n, ask + 50n] as const }));
    await burst(fillers, now + 2);
    now = (Math.floor(now / INTERVAL) + 1) * INTERVAL;
    await quoteBot();
    r.steps.push(`100 buys that do fill: the quote post that fills them uses ${chain.gas.get('postQuotes (50-100 orders waiting)')?.at(-1)} gas`);
  });

  await scenario('more than 300 orders arrive between keeper runs', async (r) => {
    const items: Parameters<typeof burst>[0] = [];
    for (const p of ledger.openPositions()) if (p.closeOrderId === 0 && items.length < 320) items.push({ from: p.account, to: 'perp', fn: 'requestClose', args: [BigInt(p.id)] });
    const idx = clamp(ledger.latestIndex() ?? 4000n, band);
    for (let i = 0; items.length < 320; i++) {
      const t = traders[i % traders.length];
      items.push({ from: t, to: 'perp', fn: 'requestOpen', args: [true, 100n, idx + 2000n < band.capCents ? idx + 2000n : band.capCents - 1n] });
    }
    const results = await burst(items, now + 1);
    const ids = results.filter((x) => x.ok).map((x) => Number(x.logs.find((l) => l.eventName === 'OrderRequested')!.args.orderId));
    r.steps.push(`${ids.length} futures orders (closes and small opens) arrive in one block`);
    await publishPrice(Number(clamp(ledger.latestIndex() ?? 4000n, band)) / 100);
    await keeperMinutes(30);
    const left = ids.filter((id) => ledger.s.perpOrders[id]);
    r.steps.push(`after the next price and 30 keeper runs (room for 600 executions), ${left.length} are still pending: ids ${left[0]}..${left.at(-1)}, the oldest ones`);
    if (left.length) {
      r.verdict = 'BUG';
      r.steps.push('the Worker\'s keeper (bots/worker.ts) only looks at the newest 300 order ids and 300 pool request ids, so an order that is still pending once 300 newer ones exist is never executed by it; its trader cannot cancel either (a round was published), so it waits until someone executes it by hand');
      const o = ledger.s.perpOrders[left[0]];
      const res = await tx(o.account, 'perp', 'executeOrder', [BigInt(o.id), BigInt(fillRound(o.createdAt)!)]);
      r.steps.push(`the trader can execute it directly: ${res.ok ? 'filled' : res.error}`);
    }
  });

  await scenario('the feed falls silent for 3 days', async (r) => {
    const open = ledger.openPositions().length;
    const lastEnd = ledger.s.rounds.at(-1)!.intervalEnd;
    now = lastEnd + 3 * 86_400 - 600;
    const early = ledger.openPositions()[0];
    const tooEarly = early ? await tx(role.keeper, 'perp', 'emergencyClose', [BigInt(early.id)]) : null;
    r.steps.push(`${open} positions are open when prices stop; 10 minutes before 3 days, emergencyClose: ${tooEarly?.ok ? 'closed (too early!)' : tooEarly?.error}`);
    now = lastEnd + 3 * 86_400 + 60;
    let ok = 0;
    for (const p of ledger.openPositions()) if ((await tx(role.keeper, 'perp', 'emergencyClose', [BigInt(p.id)])).ok) ok++;
    r.steps.push(`after 3 days anyone closes them at the last index: ${ok} of ${open} closed, ${ledger.openPositions().length} left`);
    let orders = 0;
    for (const o of ledger.pendingPerpOrders()) if ((await tx(o.account, 'perp', 'cancelOrder', [BigInt(o.id)])).ok) orders++;
    for (const q of ledger.pendingPoolRequests()) if ((await tx(q.account, 'perp', 'cancelPoolRequest', [BigInt(q.id)])).ok) orders++;
    let out = 0;
    for (const lp of lps) if ((ledger.s.lpBalances[lp] ?? 0n) > 0n && (await tx(lp, 'perp', 'withdraw', [ledger.s.lpBalances[lp]])).ok) out++;
    r.steps.push(`${orders} pending orders and requests cancelled and refunded; ${out} providers withdrew at once (the pool is flat)`);
    if (ledger.openPositions().length) r.verdict = 'BUG';
  });

  await scenario('the feed is paused and stays silent for 3 days', async (r) => {
    await tx(role.guardian, 'feed', 'pause', []);
    const lastEnd = ledger.s.rounds.at(-1)!.intervalEnd;
    now = lastEnd + 3 * 86_400 + 60;
    const open = ledger.openPositions();
    let flat = 0;
    for (const p of open) {
      const res = await tx(role.keeper, 'perp', 'emergencyClose', [BigInt(p.id)]);
      const closed = res.logs.find((l) => l.eventName === 'PositionClosed');
      if (closed && BigInt(closed.args.exitPriceCents as bigint) === p.entry) flat++;
    }
    r.steps.push(`the guardian pauses the feed (its last price may be the bad one); after 3 days ${flat} of ${open.length} positions close at their own entry price (no gain or loss, only funding and fees)`);
    if (flat !== open.length) r.verdict = 'BUG';
  });

  await scenario('a day settles beyond the band', async (r) => {
    const days = Object.keys(ledger.s.expiries).map(Number).filter((d) => !ledger.s.readings[d] && d !== VOID_DAY).sort((a, b) => a - b);
    const [hot, cold] = days;
    now = Math.max(ledger.s.expiries[hot].close, ledger.s.expiries[cold].close) + 60;
    await publishReading(hot, 45_000n, 'case');
    await publishReading(cold, -8_000n, 'case');
    now += Number(ORACLE_DISPUTE_WINDOW) + 1;
    await finalizeReading(hot);
    await finalizeReading(cold);
    let paid = 0n;
    let claims = 0;
    for (const s of Object.values(ledger.s.series).filter((x) => x.dayKey === hot || x.dayKey === cold))
      for (const [who, h] of Object.entries(s.holders))
        if (h.bal > 0n) {
          const res = await tx(who as Address, 'options', 'claim', [s.dayKey, s.strike, s.isCall]);
          if (res.ok) {
            claims++;
            paid += BigInt(res.logs.find((l) => l.eventName === 'Claimed')?.args.amount as bigint);
          }
        }
    r.steps.push(`${hot} settles at $450 (above the $300 cap) and ${cold} at -$80 (below the -$50 floor): ${claims} claims pay $${paid / USD}; calls on ${hot} pay cap minus strike, puts on ${cold} pay strike minus floor, each at most its locked maximum`);
  });

  await scenario('an order in the same block as the price, and as the quotes', async (r) => {
    const a = newWallets[2];
    await fund(a, 50_000n);
    const nextEnd = ledger.s.rounds.at(-1)!.intervalEnd + INTERVAL;
    now = Math.max(now, nextEnd + 60);
    const rows = rowsFor(now * 1000);
    const plan = await planRounds(finishedIntervals(rows, now * 1000), ledger.s.rounds.at(-1)!.intervalEnd);
    const round = plan.rounds[0] ?? { intervalEnd: nextEnd, priceCents: 4000, sourceHash: keccak256(toBytes('x')) };
    const [, order] = await burst([
      { from: role.reporter, to: 'feed', fn: 'submitPrice', args: [FEED_ID, BigInt(round.intervalEnd), BigInt(round.priceCents), round.sourceHash] },
      { from: a, to: 'perp', fn: 'requestOpen', args: [true, 1_000n, band.capCents - 1n] },
    ], now);
    const orderId = Number(order.logs.find((l) => l.eventName === 'OrderRequested')!.args.orderId);
    const sameRound = ledger.s.rounds.length;
    const dry = await chain.check({ from: role.keeper, to: addr.perp, abi: art.perp.abi, functionName: 'executeOrder', args: [BigInt(orderId), BigInt(sameRound)] });
    r.steps.push(`a futures order in the same block as a new price: executing it at that round is refused (${dry.ok ? 'filled!' : dry.name})`);
    if (dry.ok) r.verdict = 'BUG';
    now += 300;
    await priceBot();
    await keeper();
    const filled = ledger.s.perpOrders[orderId] === undefined;
    r.steps.push(`it fills at the next round instead: ${filled ? 'yes' : 'no'}`);
    const day = openExpiries(now).sort((x, y) => x - y)[0];
    const strike = BigInt(Object.keys(latestQuotes(day)!)[0]);
    now = (Math.floor(now / INTERVAL) + 1) * INTERVAL;
    const v = latestQuotes(day)!;
    const strikes = Object.keys(v).map(BigInt);
    ledger.postingQuotes = v;
    const [, buy] = await burst([
      { from: role.quoter, to: 'options', fn: 'postQuotes', args: [day, strikes, strikes.map((s) => v[s.toString()])] },
      { from: a, to: 'options', fn: 'requestBuy', args: [day, strike, true, 100n, maxPayoutCents(strike, true, band)] },
    ], now);
    ledger.postingQuotes = null;
    const buyId = Number(buy.logs.find((l) => l.eventName === 'OrderRequested')!.args.orderId);
    r.steps.push(`an options buy in the same block as a quote post: ${ledger.s.optOrders[buyId] ? 'waits' : 'filled at quotes it could see!'}`);
    if (!ledger.s.optOrders[buyId]) r.verdict = 'BUG';
    now += 300;
    await quoteBot();
    r.steps.push(`it fills at the next post: ${ledger.s.optOrders[buyId] ? 'no' : 'yes'}`);
  });
}

function fillRoundFor(orderId: number): number {
  const o = ledger.s.perpOrders[orderId];
  return ledger.s.rounds.findIndex((rd) => rd.publishedAt > o.createdAt) + 1;
}

// ------------------------------------------------------------------ wind-down: everyone gets out, the contracts must end empty

phase = 'wind-down';
const windDown: string[] = [];
quoteBotOn = false;
const settled = await settleAll(288, true);
windDown.push(`futures: every position asked to close at once; the keeper (20 executions a minute) needed ${settled.minutes} minutes`);
if (settled.byOwner)
  windDown.push(`futures: ${settled.byOwner} orders the keeper never executed (more than 300 ids old, outside its window) were executed by their owners`);
windDown.push(`futures: every position closed within ${settled.rounds} rounds (${ledger.openPositions().length} left, ${ledger.pendingPerpOrders().length} orders and ${ledger.pendingPoolRequests().length} pool requests pending)`);
let lpPaid = 0n;
for (const lp of lps) {
  const shares = ledger.s.lpBalances[lp] ?? 0n;
  if (shares > 0n) {
    const res = await tx(lp, 'perp', 'withdraw', [shares]);
    if (res.ok) lpPaid += BigInt(res.logs.find((l) => l.eventName === 'Withdrawn')!.args.assets as bigint);
  }
}
windDown.push(`futures: providers withdrew $${lpPaid / USD}; left in the contract: ${ledger.s.perp.poolCash} units (rounding dust of the empty-pool guard)`);

// options: trading closes for every listed day, every day but one gets its real day-ahead average, all claim
const lastClose = Math.max(...Object.values(ledger.s.expiries).map((e) => e.close));
now = Math.max(now, lastClose + 60);
for (const o of ledger.pendingOptOrders()) await tx(o.account, 'options', 'cancelOrder', [BigInt(o.id)]);
for (const dayKey of Object.keys(ledger.s.expiries).map(Number))
  if (!ledger.s.readings[dayKey] && dayKey !== VOID_DAY) await publishReading(dayKey, BigInt(daByDay.get(dayKey)!.value));
now += Number(ORACLE_DISPUTE_WINDOW) + 60;
for (const [dayKey, reading] of Object.entries(ledger.s.readings)) if (!reading.final) await finalizeReading(Number(dayKey));
let early = 0;
for (const s of Object.values(ledger.s.series))
  for (const [who, h] of Object.entries(s.holders)) {
    if (h.bal === 0n) continue;
    const res = await tx(who as Address, 'options', 'claim', [s.dayKey, s.strike, s.isCall]);
    if (!res.ok && s.dayKey === VOID_DAY) early++;
  }
windDown.push(`options: every settled day claimed; ${early} claims on ${VOID_DAY} (no price published) refused until 14 days after its close, as designed`);
now = ledger.s.expiries[VOID_DAY].close + 14 * 86_400 + 60;
let refunds = 0;
for (const s of Object.values(ledger.s.series))
  for (const [who, h] of Object.entries(s.holders))
    if (h.bal > 0n || h.paid > 0n) if ((await tx(who as Address, 'options', 'claim', [s.dayKey, s.strike, s.isCall])).ok) refunds++;
windDown.push(`options: 14 days after its close ${VOID_DAY} is voided: ${refunds} holders got their premium back`);
const free = ledger.s.options.poolCash - ledger.s.options.totalReserved;
if (free > 0n) await tx(role.owner, 'options', 'defundPool', [free]);
await checkTotals();

// final state: nothing pending, nothing reserved, every token accounted for
const finalRead = async (name: Name, fn: string, args: readonly unknown[] = []) => chain.read<bigint>(addr[name], art[name].abi, fn, args);
const final = {
  perpBalance: await finalRead('usdt', 'balanceOf', [addr.perp]),
  perpReserved: await finalRead('perp', 'totalReserved'),
  perpSupply: await finalRead('perp', 'totalSupply'),
  optionsBalance: await finalRead('usdt', 'balanceOf', [addr.options]),
  optionsReserved: await finalRead('options', 'totalReserved'),
  settledOwed: await finalRead('options', 'settledOwed'),
};
if (ledger.pendingPerpOrders().length || ledger.pendingPoolRequests().length || ledger.pendingOptOrders().length)
  ledger.fail('every order fills or cancels, none stuck', `at the end: ${ledger.pendingPerpOrders().length} futures orders, ${ledger.pendingPoolRequests().length} pool requests, ${ledger.pendingOptOrders().length} options orders pending`);
if (ledger.openPositions().length) ledger.fail('every holder can close', `${ledger.openPositions().length} positions still open at the end`);
if (final.perpReserved !== 0n || final.optionsReserved !== 0n || final.settledOwed !== 0n || final.optionsBalance !== 0n)
  ledger.fail('the contracts end empty', JSON.stringify(final, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (final.perpBalance > 10_000n) ledger.fail('the futures pool ends with only rounding dust', `${final.perpBalance} units`);
// no money created or lost: what every wallet got back plus what is left equals what went in
let netPerp = 0n;
let netOptions = 0n;
for (const v of Object.values(ledger.s.netCash)) {
  netPerp += v.perp;
  netOptions += v.options;
}
if (netPerp + final.perpBalance !== 0n) ledger.fail('futures: no money created or lost', `wallets net ${netPerp}, left ${final.perpBalance}`);
if (netOptions + final.optionsBalance !== 0n) ledger.fail('options: no money created or lost', `wallets net ${netOptions}, left ${final.optionsBalance}`);
const usdtSupply = await finalRead('usdt', 'totalSupply');
let held = final.perpBalance + final.optionsBalance;
for (const a of accounts) held += await finalRead('usdt', 'balanceOf', [a]);
if (held !== usdtSupply) ledger.fail('every token is accounted for', `${held} held vs ${usdtSupply} minted`);

// ------------------------------------------------------------------ report

const groupPnl = (group: Address[], contract: 'perp' | 'options') =>
  group.reduce((s, a) => s + (ledger.s.netCash[a]?.[contract] ?? 0n), 0n);
mkdirSync(opt.out!, { recursive: true });
writeReport(opt.out!, {
  settings: {
    days: DAYS, seed: SEED, lambda: LAMBDA, traders: TRADERS, lps: LPS, firstDay: fixture.firstTexasDay,
    band: `${Number(band.floorCents) / 100}..${Number(band.capCents) / 100}`, metric: METRIC, voidDay: VOID_DAY,
  },
  ledger,
  chain,
  outcomes,
  attempts,
  exitChecks,
  edgeLog,
  drills,
  scenarios,
  windDown,
  botLog,
  keeperFailures,
  refusals,
  timing: chain.timing,
  mainTx,
  mainEnd: iso(mainEnd),
  burstDay,
  economics: {
    traderPerp: groupPnl(traders, 'perp'),
    lpPerp: groupPnl(lps, 'perp'),
    traderOptions: groupPnl(traders, 'options'),
    ownerOptions: groupPnl([role.owner], 'options'),
    perpDust: final.perpBalance,
  },
  minutes: (Date.now() - startedAt) / 60_000,
});
const violations: Violation[] = ledger.violations;
console.log(`done: ${chain.txCount} transactions, ${ledger.s.stats.eventChecks} event checks, ${ledger.s.stats.globalChecks} balance checks, ${violations.length} broken rules; report in ${opt.out}/report.md`);
chain.stop();
process.exit(0);
