/**
 * How far away a market's answer is: the maturity groups the market list
 * and the landing cards use. The same contract at different maturities -
 * next-day markets settle every afternoon, later ones give longer cover.
 * No React, so it is tested directly.
 */

export type Term = 'next' | 'week' | 'later' | 'awaiting' | 'settled';

/** Group order, nearest answer first, settled last. */
export const TERMS: readonly Term[] = ['next', 'week', 'later', 'awaiting', 'settled'];

export const TERM_LABELS: Record<Term, string> = {
  next: 'Next day',
  week: 'This week',
  later: 'Later',
  awaiting: 'Awaiting the price',
  settled: 'Settled',
};

const DAY_MS = 86_400_000;

/**
 * A market's group from its status and trading close (resolveAfter, unix
 * seconds): trading markets by how soon they close - within a day, a
 * week, or later - then closed ones waiting for their price, then settled.
 */
export function termOf(
  status: 'trading' | 'awaiting' | 'resolved' | 'cancelled' | undefined,
  resolveAfter: number,
  nowMs: number,
): Term {
  if (status === 'resolved' || status === 'cancelled') return 'settled';
  if (status === 'awaiting') return 'awaiting';
  const left = resolveAfter * 1000 - nowMs;
  if (left <= DAY_MS) return 'next';
  if (left <= 7 * DAY_MS) return 'week';
  return 'later';
}

/**
 * Markets in list order: by group, trading ones by close (soonest first)
 * and within a day by strike, highest first, so a ladder reads top to
 * bottom; settled ones most recent first.
 */
export function byTerm<T extends { term: Term; resolveAfter: number; dayKey: number; threshold: number }>(
  markets: readonly T[],
): T[] {
  return [...markets].sort(
    (a, b) =>
      TERMS.indexOf(a.term) - TERMS.indexOf(b.term) ||
      (a.term === 'settled' ? b.dayKey - a.dayKey : a.resolveAfter - b.resolveAfter) ||
      b.threshold - a.threshold,
  );
}
