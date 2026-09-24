import { parseUnits } from 'viem';

import { formatPrice, formatToken } from './format.ts';
import { dayLabel } from './market-facts.ts';
import { dayKeyOf } from './price-api.ts';
import type { MarketRow } from './price-api.ts';

/**
 * The pure parts of scripts/hedge-agent.ts, the prototype hedging agent:
 * its arguments, the lines it prints, and the checks before it buys.
 * It reads everything through the price API, pays for each call when the
 * API charges, and buys a ladder the way the order ticket does.
 */

export const DEFAULT_BASE = 'https://gridflex-web.teslenko-platon.workers.dev';

export interface AgentOptions {
  base: string;
  mw: number;
  hours: number;
  /** YYYY-MM-DD, or null for the next day with a trading market. */
  day: string | null;
  protectTo: number;
  execute: boolean;
  fund: boolean;
}

export const USAGE = `Usage: node web/scripts/hedge-agent.ts [options]
  --base <url>        site to call (default ${DEFAULT_BASE})
  --mw <n>            load in megawatts (default 10)
  --hours <n>         hours a day at that load, up to 24 (default 24)
  --day <YYYY-MM-DD>  market day (default the next day with a trading market)
  --protect-to <n>    $/MWh the ladder pays up to (default 80)
  --execute           buy every rung's YES from the agent wallet
  --fund              mint 1,000 test mUSDT to the agent wallet first`;

/** The command line as options; throws with the reason on a bad one. */
export function parseAgentArgs(argv: readonly string[]): AgentOptions {
  const options: AgentOptions = {
    base: DEFAULT_BASE,
    mw: 10,
    hours: 24,
    day: null,
    protectTo: 80,
    execute: false,
    fund: false,
  };
  const positive = (flag: string, raw: string | undefined, max: number) => {
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value) || value <= 0 || value > max) {
      throw new Error(`${flag} needs a number above 0 and at most ${max}.`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--base': {
        const raw = next();
        if (!raw || !/^https?:\/\//.test(raw)) throw new Error('--base needs an http(s) URL.');
        options.base = raw.replace(/\/+$/, '');
        break;
      }
      case '--mw':
        options.mw = positive(flag, next(), 10_000);
        break;
      case '--hours':
        options.hours = positive(flag, next(), 24);
        break;
      case '--protect-to':
        options.protectTo = positive(flag, next(), 10_000);
        break;
      case '--day': {
        const raw = next();
        if (!raw || dayKeyOf(raw) === null) throw new Error('--day needs a date as YYYY-MM-DD.');
        options.day = raw;
        break;
      }
      case '--execute':
        options.execute = true;
        break;
      case '--fund':
        options.fund = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}.`);
    }
  }
  return options;
}

/** The earliest day after `today` (YYYY-MM-DD) with a trading market, or null. */
export function nextTradingDay(
  markets: readonly Pick<MarketRow, 'day' | 'status'>[],
  today: string,
): string | null {
  const days = markets
    .filter((market) => market.status === 'trading' && market.day > today)
    .map((market) => market.day)
    .sort();
  return days[0] ?? null;
}

/** "0xf6bdfc…cb44f": enough of a hash to find it on OKLink. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-5)}` : hash;
}

/** "2026-09-08" -> "8 Sep 2026". */
export function dayWords(day: string): string {
  return dayLabel(dayKeyOf(day) ?? 0, true);
}

/** How a call was paid for: settled over x402, or served free. */
export type CallPayment = { paid: true; tx: string | null } | { paid: false };

function paidFor(payment: CallPayment, what: string): string {
  return payment.paid
    ? `Paid $0.01 in USDT0 on X Layer for ${what}`
    : `Free call (the API isn't charging yet) for ${what}`;
}

/** The settlement transaction under a paid line, when the API returned one. */
export function receiptLine(payment: CallPayment): string | null {
  return payment.paid && payment.tx ? `  payment settled in tx ${payment.tx}` : null;
}

/** The /price answer the agent reads. */
export interface PriceAnswer {
  day: string;
  valueCents: number;
  verified: boolean;
  oracle: { published: boolean; txHash: string | null; checked: boolean };
}

export function priceLine(payment: CallPayment, price: PriceAnswer): string {
  const value = formatPrice(price.valueCents, 'MWh');
  const on = dayWords(price.day);
  if (price.verified) {
    const tx = price.oracle.txHash ? ` (oracle tx ${shortHash(price.oracle.txHash)})` : '';
    return `${paidFor(payment, 'the verified Texas power price')}: ${value} on ${on}${tx}`;
  }
  const why = !price.oracle.checked
    ? 'X Layer could not be checked'
    : price.oracle.published
      ? 'the oracle holds a different reading'
      : 'not yet published to the oracle';
  return `${paidFor(payment, 'the Texas power price')}: ${value} on ${on} (${why})`;
}

export function marketsLine(
  payment: CallPayment,
  markets: readonly Pick<MarketRow, 'day' | 'strike' | 'status'>[],
  day: string | null,
): string {
  const trading = markets.filter((market) => market.status === 'trading');
  const strikes = trading
    .filter((market) => market.day === day)
    .map((market) => market.strike)
    .sort((a, b) => a - b)
    .map((strike) => `$${strike}`);
  const next = !day
    ? ''
    : strikes.length > 0
      ? `; ${dayWords(day)} has strikes ${strikes.join(', ')}`
      : `; none on ${dayWords(day)}`;
  return `${paidFor(payment, 'the markets')}: ${trading.length} trading${next}`;
}

/** The /hedge-quote answer the agent reads. */
export interface HedgeAnswer {
  day: string;
  mw: number;
  hours: number;
  mwh: number;
  protectTo: number;
  rungs: { market: string; strike: number; tokens: number; yesPrice: number; cost: number }[];
  totalCost: number;
  scenarios: { price: number; extraCost: number; payout: number; covered: number | null }[];
  notes: string[];
}

export function hedgeLine(payment: CallPayment, quote: HedgeAnswer): string {
  return `${paidFor(payment, 'a hedge quote')}: ${quote.rungs.length} rung${quote.rungs.length === 1 ? '' : 's'} for ${quote.mw} MW x ${quote.hours} h on ${dayWords(quote.day)}`;
}

const amount = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('   ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('   '), ...rows.map(line)];
}

/** The plan: one row per rung, the total, then what it pays at each price. */
export function planLines(quote: HedgeAnswer): string[] {
  const rungs = table(
    ['Strike', 'YES to buy', 'YES price', 'Cost (mUSDT)'],
    quote.rungs.map((rung) => [
      `$${rung.strike}/MWh`,
      amount(rung.tokens),
      `${(rung.yesPrice * 100).toFixed(1)}¢`,
      amount(rung.cost),
    ]),
  );
  const outcomes = table(
    ['Settles at', 'Extra cost', 'Ladder pays', 'Covered'],
    quote.scenarios.map((row) => [
      `$${row.price}/MWh`,
      `$${amount(row.extraCost)}`,
      `${amount(row.payout)} mUSDT`,
      row.covered === null ? '-' : `${Math.round(row.covered * 100)}%`,
    ]),
  );
  return [
    `Hedge plan: ${quote.mwh.toLocaleString('en-US')} MWh on ${dayWords(quote.day)}, protected up to $${quote.protectTo}/MWh`,
    ...rungs,
    `Total: ${amount(quote.totalCost)} mUSDT (indicative)`,
    '',
    ...outcomes,
  ];
}

/** A rung's cost as the mUSDT base units a buy mints with (6 decimals). */
export function buyUnits(cost: number): bigint {
  return parseUnits(cost.toFixed(6), 6);
}

/** OKB the agent wants for gas before it sends anything: 0.001 OKB. */
export const MIN_GAS_WEI = 10n ** 15n;

/** Why the agent can't buy the plan yet, or [] when it can. */
export function preflightProblems(
  wallet: string,
  gasWei: bigint,
  musdtUnits: bigint,
  neededUnits: bigint,
): string[] {
  const problems: string[] = [];
  if (gasWei < MIN_GAS_WEI) {
    problems.push(
      `The agent wallet ${wallet} needs at least 0.001 OKB for gas on X Layer testnet. Claim test OKB from the X Layer faucet and run again.`,
    );
  }
  if (musdtUnits < neededUnits) {
    problems.push(
      `The plan needs ${formatToken(neededUnits)} mUSDT and the agent wallet holds ${formatToken(musdtUnits)}. Run with --fund (1,000 test mUSDT a run) until it holds enough.`,
    );
  }
  return problems;
}
