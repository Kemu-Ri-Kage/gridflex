/**
 * Writes the market simulation's results: report.json (everything) and
 * report.md (the technical summary: activity, checks, gas, cases).
 */
import { writeFileSync } from 'node:fs';

import type { Chain } from './chain.ts';
import type { Ledger } from './ledger.ts';

export interface ScenarioResult {
  name: string;
  verdict: 'as designed' | 'BUG' | 'RISK' | 'error';
  steps: string[];
  brokenRules: string[];
}

export interface ReportInput {
  settings: Record<string, unknown>;
  ledger: Ledger;
  chain: Chain;
  outcomes: Map<string, Map<string, number>>;
  attempts: Record<string, number>;
  exitChecks: { runs: number; calls: number; blockedSells: number };
  edgeLog: { at: string; what: string; result: string }[];
  drills: { at: string; result: string }[];
  scenarios: ScenarioResult[];
  windDown: string[];
  botLog: string[];
  keeperFailures: Map<string, number>;
  refusals: Map<string, number>;
  timing: Map<string, { calls: number; ms: number }>;
  mainTx: number;
  mainEnd: string;
  burstDay: number;
  economics: Record<string, bigint>;
  minutes: number;
}

const usd = (units: bigint) => {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}$${(Number(abs) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
};

function gasRows(gas: Map<string, bigint[]>) {
  return [...gas.entries()]
    .filter(([k]) => !k.startsWith('__'))
    .map(([label, list]) => {
      const sorted = list.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const mean = sorted.reduce((s, v) => s + v, 0n) / BigInt(sorted.length);
      return {
        label,
        count: sorted.length,
        min: sorted[0],
        median: sorted[Math.floor(sorted.length / 2)],
        mean,
        max: sorted[sorted.length - 1],
      };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function writeReport(dir: string, r: ReportInput) {
  const s = r.ledger.s.stats;
  const violations = r.ledger.violations;
  const byCheck = new Map<string, typeof violations>();
  for (const v of violations) byCheck.set(v.check, [...(byCheck.get(v.check) ?? []), v]);
  const deviations = r.ledger.s.poolDeviations;
  const maxAbs = (pick: (d: (typeof deviations)[number]) => bigint) =>
    deviations.reduce((m, d) => {
      const v = pick(d) < 0n ? -pick(d) : pick(d);
      return v > m ? v : m;
    }, 0n);
  const gas = gasRows(r.chain.gas);

  const md: string[] = [];
  md.push('# GRIDFLEX market simulation: results', '');
  md.push(`Run ${new Date().toISOString().slice(0, 16)}Z, ${r.minutes.toFixed(1)} minutes. Settings: ${Object.entries(r.settings).map(([k, v]) => `${k} ${String(v)}`).join(', ')}.`, '');
  md.push('## Totals', '');
  md.push(`- Transactions: ${r.chain.txCount} (${r.mainTx} up to the end of the replay at ${r.mainEnd}); ${r.chain.revertCount} were refused by a contract (most on purpose: edge cases and trades the rules forbid).`);
  md.push(`- Checks: ${s.eventChecks} event checks against the model, ${s.globalChecks} full balance reconciliations (one after every transaction), ${r.exitChecks.calls} "can this holder get out" calls in ${r.exitChecks.runs} rounds (every 3 simulated hours).`);
  md.push(`- Broken rules: **${violations.length}**${violations.length ? ' (listed below)' : ''}.`);
  md.push('');
  md.push('## What happened', '');
  md.push('| | count |', '| --- | ---: |');
  const rows: [string, number | string][] = [
    ['futures positions opened', s.perpOpens],
    ['futures positions closed (of them emergency closes)', `${s.perpCloses} (${s.perpEmergencyCloses})`],
    ['futures closes at a band edge (-$50 or $300)', s.bandEdgeCloses],
    ...Object.entries(s.perpCancels).map(([k, v]) => [`futures orders cancelled: ${k}`, v] as [string, number]),
    ['pool deposits / withdrawals filled', `${s.poolDeposits} / ${s.poolWithdrawals}`],
    ...Object.entries(s.poolCancels).map(([k, v]) => [`pool requests cancelled: ${k}`, v] as [string, number]),
    ['options bought / sold back', `${s.optBuys} / ${s.optSells}`],
    ...Object.entries(s.optCancels).map(([k, v]) => [`options orders cancelled: ${k}`, v] as [string, number]),
    ['options series settled / voided', `${s.seriesSettled} / ${s.seriesVoided}`],
    ['claims paid', s.claims],
    ['longest a futures order waited after its fill round', `${Math.round(s.perpLongestWait.seconds / 60)} min (order ${s.perpLongestWait.orderId})`],
  ];
  for (const [k, v] of rows) md.push(`| ${k} | ${v} |`);
  md.push('');
  md.push('## Money', '');
  md.push(`- Futures fees: ${usd(s.feesOpen)} at open, ${usd(s.feesClose)} at close. Funding charged ${usd(s.funding)}; the plan's rule integrated independently gives ${usd(s.fundingModel)} (largest difference on one position: ${s.maxFundingDiff} units, i.e. rounding).`);
  md.push(`- Biggest single futures payout: ${usd(s.biggestPerpPayout)}.`);
  md.push(`- Options: premiums in ${usd(s.premiumsIn)}, buy-backs out ${usd(s.buybacksOut)}, settlement payouts ${usd(s.optionPayouts)}, void refunds ${usd(s.voidRefunds)}.`);
  md.push(`- Net result after everyone exited: traders on futures ${usd(r.economics.traderPerp)}, pool providers ${usd(r.economics.lpPerp)}, traders on options ${usd(r.economics.traderOptions)}, options pool (owner) ${usd(r.economics.ownerOptions)}; futures dust left: ${r.economics.perpDust} units.`);
  const late = deviations.filter((d) => d.waitedSeconds > 300);
  md.push(`- Pool deposits and withdrawals filled from requests: ${deviations.length}; largest gap between what one got and its fair share at the pool's value when it executed: ${usd(maxAbs((d) => d.vsNow))}. ${late.length} executed more than 5 minutes after their fill round.`);
  md.push('');
  md.push('## Broken rules', '');
  if (violations.length === 0) md.push('None.');
  for (const [check, list] of byCheck) {
    md.push(`- **${check}**: ${list.length} time(s). First: ${list[0].detail} (${list[0].phase}, ${new Date(list[0].ts * 1000).toISOString()}, tx ${list[0].tx})`);
  }
  md.push('');
  md.push('## Targeted cases (each on a copy of the chain, then undone)', '');
  for (const c of r.scenarios) {
    md.push(`### ${c.name}: ${c.verdict}`, '');
    for (const step of c.steps) md.push(`1. ${step}`);
    if (c.brokenRules.length) {
      md.push('', 'Rules the checker flagged in this case:');
      for (const b of [...new Set(c.brokenRules)].slice(0, 8)) md.push(`- ${b}`);
    }
    md.push('');
  }
  md.push('## Edge cases in the replay', '');
  md.push('| time (UTC) | what | result |', '| --- | --- | --- |');
  for (const e of r.edgeLog) md.push(`| ${e.at} | ${e.what} | ${e.result} |`);
  md.push('');
  md.push('Drills (everyone exits at once, on a copy of the chain):', '');
  for (const d of r.drills) md.push(`- ${d.at}: ${d.result}`);
  md.push('');
  md.push('## Wind-down', '');
  for (const w of r.windDown) md.push(`- ${w}`);
  md.push('');
  md.push('## Gas per action', '');
  md.push('| action | count | min | median | mean | max |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const g of gas) md.push(`| ${g.label} | ${g.count} | ${g.min} | ${g.median} | ${g.mean} | ${g.max} |`);
  md.push('');
  md.push('## Contract calls by outcome', '');
  md.push('| call | outcomes |', '| --- | --- |');
  for (const [fn, m] of [...r.outcomes].toSorted((a, b) => a[0].localeCompare(b[0])))
    md.push(`| ${fn} | ${[...m].map(([k, v]) => `${k}: ${v}`).join(', ')} |`);
  md.push('');
  md.push('## Calls a contract refused, by phase', '');
  md.push('| phase, call and reason | count |', '| --- | ---: |');
  for (const [k, v] of [...r.refusals].toSorted((a, b) => a[0].localeCompare(b[0]))) md.push(`| ${k} | ${v} |`);
  md.push('');
  md.push('## Keeper executions that would revert (skipped, retried next run)', '');
  if (r.keeperFailures.size === 0) md.push('None.');
  for (const [k, v] of r.keeperFailures) md.push(`- ${k}: ${v}`);
  md.push('');
  md.push('## Bot errors', '');
  const errors = r.botLog.filter((l) => l.includes('failed') || l.includes('not executed') || l.includes('skip'));
  for (const l of errors.slice(0, 40)) md.push(`- ${l}`);
  if (errors.length > 40) md.push(`- ... ${errors.length - 40} more in report.json`);
  writeFileSync(`${dir}/report.md`, `${md.join('\n')}\n`);

  const json = {
    settings: r.settings,
    totals: { tx: r.chain.txCount, reverted: r.chain.revertCount, mainTx: r.mainTx },
    stats: s,
    attempts: r.attempts,
    exitChecks: r.exitChecks,
    violations,
    scenarios: r.scenarios,
    edgeLog: r.edgeLog,
    drills: r.drills,
    windDown: r.windDown,
    gas,
    outcomes: Object.fromEntries([...r.outcomes].map(([k, m]) => [k, Object.fromEntries(m)])),
    keeperFailures: Object.fromEntries(r.keeperFailures),
    refusals: Object.fromEntries(r.refusals),
    timing: Object.fromEntries(r.timing),
    poolDeviations: deviations,
    economics: r.economics,
    botLog: r.botLog,
  };
  writeFileSync(`${dir}/report.json`, JSON.stringify(json, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
}
