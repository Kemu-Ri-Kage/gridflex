/**
 * Wrap `task` so a call made while an earlier one is still running is
 * dropped instead of starting a second run. The lock is taken before the
 * first await, so two clicks in the same tick still start one run, and it
 * is released in `finally`, whether the run succeeds, is rejected or
 * fails. `running` reports whether a run is in progress.
 */
export function singleFlight<Args extends unknown[]>(
  task: (...args: Args) => Promise<void>,
): { run: (...args: Args) => Promise<void>; running: () => boolean } {
  let busy = false;
  return {
    running: () => busy,
    run: async (...args) => {
      if (busy) return;
      busy = true;
      try {
        await task(...args);
      } finally {
        busy = false;
      }
    },
  };
}
