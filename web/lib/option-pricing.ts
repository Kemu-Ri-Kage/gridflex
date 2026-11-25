/**
 * Pricing for the Texas power options (TexasPowerOptions): the quote bot's
 * model, also usable by the site to show premiums.
 *
 * The underlying is one day's average price, which can sit near zero or go
 * negative, so the model is the normal (Bachelier) one rather than
 * Black-Scholes: the settlement S is taken as normal with mean F (the
 * expected day average) and standard deviation sigma, both in $/MWh.
 *
 * Options settle on S clamped to the contract's band [floor, cap], so a call
 * pays min(max(S - K, 0), cap - K) = call(K) - call(cap), and a put pays
 * min(max(K - S, 0), K - floor) = put(K) - put(floor). Prices here are in
 * dollars per MWh; quotes for the contract are whole cents per MWh.
 *
 * No React and no Worker APIs, so it is tested directly.
 */

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/** The error function, Abramowitz and Stegun 7.1.26 (absolute error under 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normalPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** E[max(S - K, 0)] for S ~ Normal(F, sigma). */
export function bachelierCall(
  forward: number,
  strike: number,
  sigma: number,
): number {
  if (!(sigma > 0)) return Math.max(forward - strike, 0);
  const d = (forward - strike) / sigma;
  return (forward - strike) * normalCdf(d) + sigma * normalPdf(d);
}

/** E[max(K - S, 0)], by put-call parity. */
export function bachelierPut(
  forward: number,
  strike: number,
  sigma: number,
): number {
  return bachelierCall(forward, strike, sigma) - (forward - strike);
}

export interface Band {
  floor: number;
  cap: number;
}

/** A call on the clamped settlement: pays at most cap - strike. */
export function bandedCall(
  forward: number,
  strike: number,
  sigma: number,
  band: Band,
): number {
  const value =
    bachelierCall(forward, strike, sigma) -
    bachelierCall(forward, band.cap, sigma);
  return Math.min(Math.max(value, 0), band.cap - strike);
}

/** A put on the clamped settlement: pays at most strike - floor. */
export function bandedPut(
  forward: number,
  strike: number,
  sigma: number,
  band: Band,
): number {
  const value =
    bachelierPut(forward, strike, sigma) -
    bachelierPut(forward, band.floor, sigma);
  return Math.min(Math.max(value, 0), strike - band.floor);
}

/** The listed strikes: the forward rounded to the step, then `each` steps either side, inside the band. */
export function strikesAround(
  forward: number,
  band: Band,
  step = 5,
  each = 4,
): number[] {
  const centre = Math.round(forward / step) * step;
  const strikes: number[] = [];
  for (let i = -each; i <= each; i++) {
    const strike = centre + i * step;
    if (strike > band.floor && strike < band.cap) strikes.push(strike);
  }
  return strikes;
}

export interface QuoteCents {
  callAsk: number;
  callBid: number;
  putAsk: number;
  putBid: number;
}

export interface QuoteSettings {
  /** The pool's margin either side of the model price, e.g. 0.05 for 5%. */
  spread: number;
  /** A minimum margin in cents either side, so cheap options still carry one. */
  minEdgeCents: number;
}

export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  spread: 0.05,
  minEdgeCents: 2,
};

function askBid(midDollars: number, maxCents: number, settings: QuoteSettings) {
  const mid = midDollars * 100;
  const edge = Math.max(mid * settings.spread, settings.minEdgeCents);
  const ask = Math.min(Math.max(Math.ceil(mid + edge), 1), maxCents);
  const bid = Math.max(Math.floor(mid - edge), 0);
  return { ask, bid: Math.min(bid, ask) };
}

/**
 * Whole-cent quotes for one strike, within what the contract accepts: a bid
 * never above the ask, an ask between 1 cent and the largest payout. A bid
 * of 0 means the pool does not buy that option back at this version.
 */
export function quoteStrike(
  forward: number,
  strike: number,
  sigma: number,
  band: Band,
  settings: QuoteSettings = DEFAULT_QUOTE_SETTINGS,
): QuoteCents {
  const call = askBid(
    bandedCall(forward, strike, sigma, band),
    Math.round((band.cap - strike) * 100),
    settings,
  );
  const put = askBid(
    bandedPut(forward, strike, sigma, band),
    Math.round((strike - band.floor) * 100),
    settings,
  );
  return {
    callAsk: call.ask,
    callBid: call.bid,
    putAsk: put.ask,
    putBid: put.bid,
  };
}

/**
 * The expected day average and its uncertainty from past daily averages
 * ($/MWh, oldest first): the mean of the last `window` days, and their
 * standard deviation, never below `minSigma`. When the day-ahead auction for
 * the day is out, that average is the forward and the uncertainty shrinks to
 * the real-time vs day-ahead difference (`daSigma`).
 */
export function forwardAndSigma(
  history: readonly number[],
  dayAheadAverage: number | null,
  options: { window?: number; minSigma?: number; daSigma?: number } = {},
): { forward: number; sigma: number } | null {
  const window = options.window ?? 14;
  const minSigma = options.minSigma ?? 3;
  if (dayAheadAverage !== null && Number.isFinite(dayAheadAverage)) {
    return {
      forward: dayAheadAverage,
      sigma: Math.max(options.daSigma ?? 6, minSigma),
    };
  }
  const recent = history.filter(Number.isFinite).slice(-window);
  if (recent.length < 3) return null;
  const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
  const variance =
    recent.reduce((s, v) => s + (v - mean) ** 2, 0) / (recent.length - 1);
  return { forward: mean, sigma: Math.max(Math.sqrt(variance), minSigma) };
}
