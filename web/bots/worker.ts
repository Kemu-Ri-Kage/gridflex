/**
 * gridflex-bots: the price bot and the quote bot on Cloudflare's timer
 * (GRIDFLEX Trading Platform Plan, "How it fits together").
 *
 *   every minute     price bot: LivePriceFeed.submitPrice for each new
 *                    5-minute ERCOT North Hub price (lib/price-bot.ts)
 *   every 5 minutes  quote bot: TexasPowerOptions.openExpiry / postQuotes
 *                    for the next seven Texas days (lib/quote-bot.ts)
 *
 * Nothing is sent unless LIVE is "yes" and the bot's own key is set; until
 * then every run is a dry run that only logs. Each bot has its own key
 * (REPORTER_PRIVATE_KEY, QUOTER_PRIVATE_KEY), set as Worker secrets by the
 * person who deploys, never in code; they are the contracts' replaceable
 * online keys, never an owner key and never the old GridOracle v1 key.
 * See bots/README.md.
 */

import {
  createPublicClient,
  createWalletClient,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { xLayerTestnet, xLayerTransport } from '../lib/contracts.ts';
import type { CommittedRecord } from '../lib/feed-data.ts';
import { liveQueryUrl } from '../lib/live-price.ts';
import { runPriceBot, type Round } from '../lib/price-bot.ts';
import {
  runQuoteBot,
  type ExpiryPlan,
  type QuoteVersion,
} from '../lib/quote-bot.ts';
import recordsJson from '../public/data/ERCOT_HBNORTH_DA_AVG.json';
import { livePriceFeedAbi, texasPowerOptionsAbi } from './abi.ts';

interface Env {
  LIVE?: string;
  GRIDSTATUS_API_KEY?: string;
  FEED_ADDRESS?: string;
  OPTIONS_ADDRESS?: string;
  REPORTER_PRIVATE_KEY?: string;
  QUOTER_PRIVATE_KEY?: string;
}

export const FEED_ID = keccak256(toBytes('ERCOT_HBNORTH_RT_5MIN'));
const PRICE_CRON = '* * * * *';
const QUOTE_CRON = '*/5 * * * *';

const chain = createPublicClient({
  chain: xLayerTestnet,
  transport: xLayerTransport(),
});

function address(value: string | undefined): Address | null {
  return value && isAddress(value) ? value : null;
}

function wallet(privateKey: string) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey as Hex),
    chain: xLayerTestnet,
    transport: xLayerTransport(),
  });
}

function logger(bot: string) {
  return (line: string) => console.log(`[${bot}] ${line}`);
}

async function priceRun(env: Env, now: number): Promise<void> {
  const log = logger('price');
  const feed = address(env.FEED_ADDRESS);
  if (!feed || !env.GRIDSTATUS_API_KEY) {
    log('not configured (FEED_ADDRESS and GRIDSTATUS_API_KEY are needed)');
    return;
  }
  const live = env.LIVE === 'yes' && Boolean(env.REPORTER_PRIVATE_KEY);
  const signer = live ? wallet(env.REPORTER_PRIVATE_KEY!) : null;
  const apiKey = env.GRIDSTATUS_API_KEY;

  await runPriceBot(
    {
      dryRun: !live,
      log,
      latestEnd: async () => {
        const roundId = await chain.readContract({
          address: feed,
          abi: livePriceFeedAbi,
          functionName: 'latestRoundId',
          args: [FEED_ID],
        });
        if (roundId === 0n) return 0;
        const round = await chain.readContract({
          address: feed,
          abi: livePriceFeedAbi,
          functionName: 'getRound',
          args: [FEED_ID, roundId],
        });
        return Number(round.intervalEnd);
      },
      fetchRows: async (nowMs) => {
        const response = await fetch(liveQueryUrl(nowMs), {
          headers: { 'x-api-key': apiKey, 'x-client': 'gridflex-bots' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(`GridStatus answered ${response.status}`);
        return ((await response.json()) as { data?: unknown }).data;
      },
      submit: async (round: Round) => {
        const hash = await signer!.writeContract({
          address: feed,
          abi: livePriceFeedAbi,
          functionName: 'submitPrice',
          args: [
            FEED_ID,
            BigInt(round.intervalEnd),
            BigInt(round.priceCents),
            round.sourceHash,
          ],
        });
        const receipt = await chain.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success')
          throw new Error(`submitPrice reverted in ${hash}`);
        return hash;
      },
    },
    now,
  );
}

/** Daily averages in $/MWh, oldest first, from the price data the bot was built with. */
const records = (recordsJson as CommittedRecord[]).toSorted(
  (a, b) => a.dayKey - b.dayKey,
);
const history = records.map((r) => r.value / 100);
const committedByDay = new Map(records.map((r) => [r.dayKey, r.value / 100]));

async function quoteRun(env: Env, now: number): Promise<void> {
  const log = logger('quote');
  const options = address(env.OPTIONS_ADDRESS);
  if (!options) {
    log('not configured (OPTIONS_ADDRESS is needed)');
    return;
  }
  const live = env.LIVE === 'yes' && Boolean(env.QUOTER_PRIVATE_KEY);
  const signer = live ? wallet(env.QUOTER_PRIVATE_KEY!) : null;
  const [floorCents, capCents] = await Promise.all([
    chain.readContract({
      address: options,
      abi: texasPowerOptionsAbi,
      functionName: 'floorCents',
    }),
    chain.readContract({
      address: options,
      abi: texasPowerOptionsAbi,
      functionName: 'capCents',
    }),
  ]);

  const send = async (hash: Hex, what: string) => {
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success')
      throw new Error(`${what} reverted in ${hash}`);
    return hash;
  };

  await runQuoteBot(
    {
      dryRun: !live,
      log,
      band: { floor: Number(floorCents) / 100, cap: Number(capCents) / 100 },
      isListed: async (dayKey) => {
        const [exists] = await chain.readContract({
          address: options,
          abi: texasPowerOptionsAbi,
          functionName: 'expiries',
          args: [dayKey],
        });
        return exists;
      },
      openExpiry: async (plan: ExpiryPlan) =>
        send(
          await signer!.writeContract({
            address: options,
            abi: texasPowerOptionsAbi,
            functionName: 'openExpiry',
            args: [plan.dayKey, BigInt(plan.tradingCloseUtc)],
          }),
          'openExpiry',
        ),
      postQuotes: async (dayKey: number, version: QuoteVersion) =>
        send(
          await signer!.writeContract({
            address: options,
            abi: texasPowerOptionsAbi,
            functionName: 'postQuotes',
            args: [
              dayKey,
              version.strikesCents.map(BigInt),
              version.quotes.map((q) => ({
                callAsk: BigInt(q.callAsk),
                callBid: BigInt(q.callBid),
                putAsk: BigInt(q.putAsk),
                putBid: BigInt(q.putBid),
              })),
            ],
          }),
          'postQuotes',
        ),
      history: async () => history,
      // the committed daily price for that day, once a refresh has fetched it
      dayAhead: async (dayKey) => committedByDay.get(dayKey) ?? null,
    },
    now,
  );
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const now = Date.now();
    if (controller.cron === QUOTE_CRON) ctx.waitUntil(quoteRun(env, now));
    else if (controller.cron === PRICE_CRON) ctx.waitUntil(priceRun(env, now));
  },
  async fetch(): Promise<Response> {
    return new Response(
      'gridflex-bots runs on a timer and has no web pages.\n',
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
