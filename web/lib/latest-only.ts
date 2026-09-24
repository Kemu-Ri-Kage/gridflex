/**
 * Let only the most recently started of several overlapping reads apply
 * its result. `begin()` returns a token; `isLatest(token)` is true until
 * another read begins. An older read that finishes late is dropped instead
 * of overwriting a newer one, e.g. a read started before the wallet
 * connected landing after the read started on connect.
 */
export function latestOnly(): {
  begin: () => number;
  isLatest: (token: number) => boolean;
} {
  let latest = 0;
  return {
    begin: () => ++latest,
    isLatest: (token) => token === latest,
  };
}
