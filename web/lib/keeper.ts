/**
 * The keeper for TexasPowerPerp: fills pending orders and pool requests at
 * their fill round, the first price round published after each one
 * (GRIDFLEX Trading Platform Plan, "Market 1: perpetual futures").
 *
 * Executing is permissionless and the result is fixed by the fill round, so
 * the keeper only decides how soon: it runs right after the price bot every
 * minute. An execution that reverts (a pool withdrawal waiting for free cash,
 * say) is logged and retried next run.
 *
 * Chain access is passed in (see bots/worker.ts), so the logic is tested
 * without a chain or a key.
 */

export interface PendingItem {
  kind: 'order' | 'pool';
  id: number;
  /** Unix seconds the request was made. */
  createdAt: number;
}

export interface KeeperDeps {
  /** Pending orders and pool requests, oldest first. */
  pending(): Promise<PendingItem[]>;
  latestRoundId(): Promise<number>;
  /** When a round was published, unix seconds. */
  publishedAt(roundId: number): Promise<number>;
  /** Sends executeOrder / executePoolRequest and waits; throws if it reverts. */
  execute(item: PendingItem, roundId: number): Promise<string>;
  log(line: string): void;
  dryRun: boolean;
}

/**
 * The fill round: the first round published strictly after `createdAt`, or
 * null if none has been yet. Walks back from the latest round, so recent
 * requests (the usual case) take a step or two.
 */
export async function findFillRound(
  createdAt: number,
  latest: number,
  publishedAt: (roundId: number) => Promise<number>,
): Promise<number | null> {
  if (latest === 0 || (await publishedAt(latest)) <= createdAt) return null;
  let round = latest;
  while (round > 1 && (await publishedAt(round - 1)) > createdAt) round--;
  return round;
}

/** One run: execute every pending item whose fill round exists, at most `maxPerRun`. */
export async function runKeeper(
  deps: KeeperDeps,
  maxPerRun = 20,
): Promise<number> {
  const items = await deps.pending();
  if (items.length === 0) return 0;
  const latest = await deps.latestRoundId();
  const cache = new Map<number, number>();
  const publishedAt = async (roundId: number) => {
    if (!cache.has(roundId))
      cache.set(roundId, await deps.publishedAt(roundId));
    return cache.get(roundId)!;
  };

  let done = 0;
  for (const item of items.slice(0, maxPerRun)) {
    const round = await findFillRound(item.createdAt, latest, publishedAt);
    const label = `${item.kind} ${item.id}`;
    if (round === null) {
      deps.log(`${label}: waiting for its fill round`);
      continue;
    }
    if (deps.dryRun) {
      deps.log(`dry run: would execute ${label} at round ${round}`);
      done++;
      continue;
    }
    try {
      deps.log(
        `executed ${label} at round ${round} in ${await deps.execute(item, round)}`,
      );
      done++;
    } catch (error) {
      deps.log(
        `${label}: not executed yet (${error instanceof Error ? error.message.split('\n')[0] : 'reverted'})`,
      );
    }
  }
  if (items.length > maxPerRun)
    deps.log(`${items.length - maxPerRun} more left for the next run`);
  return done;
}
