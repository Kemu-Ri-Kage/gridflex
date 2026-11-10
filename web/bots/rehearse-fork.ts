/**
 * Rehearsal of the real launch on a local fork of X Layer testnet: after
 * contracts/script/DeployDerivatives.s.sol has deployed to the fork and
 * build_feed_data.py has published the addresses to public/data/addresses.json,
 * this runs the three bots against those contracts the way the Worker would and
 * leaves one filled futures position and one filled option, so the /futures and
 * /options screens have live data to show.
 *
 *   anvil --fork-url https://testrpc.xlayer.tech/terigon --port 8547 --chain-id 1952
 *   node bots/rehearse-fork.ts [rpc url, default http://127.0.0.1:8547]
 *
 * Uses anvil's public test accounts (reporter = 1, quoter = 3, trader = 4,
 * keeper = 5, owner = 0), matching the roles given to the deploy script. Never
 * point it at a real network: it moves the fork's clock.
 */
import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

import { runKeeper, type PendingItem } from '../lib/keeper.ts';
import { runPriceBot, type Round } from '../lib/price-bot.ts';
import {
  runQuoteBot,
  upcomingExpiries,
  type QuoteVersion,
} from '../lib/quote-bot.ts';
import {
  livePriceFeedAbi,
  texasPowerOptionsAbi,
  texasPowerPerpAbi,
} from './abi.ts';

const rpc = process.argv[2] ?? 'http://127.0.0.1:8547';
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc))
  throw new Error('rehearse-fork only runs against a local fork');
const fork = defineChain({
  id: 1952,
  name: 'X Layer testnet fork',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const transport = http(rpc);
const chain = createPublicClient({ chain: fork, transport });
const testClient = createTestClient({ chain: fork, mode: 'anvil', transport });
if ((await chain.getChainId()) !== 1952) throw new Error('not a 1952 fork');

const addresses = JSON.parse(
  readFileSync('public/data/addresses.json', 'utf8'),
) as Record<string, string>;
const need = (name: string) => {
  const value = addresses[name];
  if (!value) throw new Error(`${name} missing from addresses.json`);
  return value as Address;
};
const feed = need('LivePriceFeed');
const perp = need('TexasPowerPerp');
const options = need('TexasPowerOptions');
const usdt = need('MockUSDT');

// anvil's public test mnemonic (no real keys)
const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';
const key = (index: number) =>
  createWalletClient({
    account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }),
    chain: fork,
    transport,
  });
const owner = key(0);
const reporter = key(1);
const quoter = key(3);
const trader = key(4);
const keeperKey = key(5);
const FEED_ID = keccak256(toBytes('ERCOT_HBNORTH_RT_5MIN'));
const log = (line: string) => console.log(`  ${line}`);
const wait = async (hash: Hex) => {
  const r = await chain.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted ${hash}`);
  return hash;
};
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const send = async (
  who: ReturnType<typeof key>,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) =>
  wait(
    await who.writeContract({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
    }),
  );

// ---- price bot: the last 25 minutes, then one more interval later
const latestEnd = async () => {
  const id = await chain.readContract({
    address: feed,
    abi: livePriceFeedAbi,
    functionName: 'latestRoundId',
    args: [FEED_ID],
  });
  if (id === 0n) return 0;
  return Number(
    (
      await chain.readContract({
        address: feed,
        abi: livePriceFeedAbi,
        functionName: 'getRound',
        args: [FEED_ID, id],
      })
    ).intervalEnd,
  );
};
const submit = async (round: Round) =>
  send(reporter, feed, livePriceFeedAbi, 'submitPrice', [
    FEED_ID,
    BigInt(round.intervalEnd),
    BigInt(round.priceCents),
    round.sourceHash,
  ]);
const block = await chain.getBlock();
const now = Number(block.timestamp) * 1000;
const lastEnd = Math.floor(now / 300_000) * 300_000;
const rows = [5, 4, 3, 2, 1].map((k, i) => ({
  interval_start_utc: new Date(lastEnd - k * 300_000).toISOString(),
  interval_end_utc: new Date(lastEnd - (k - 1) * 300_000).toISOString(),
  lmp: [43.1, 44.2, 45.3, 44.9, 46.05][i],
}));
console.log('price bot:');
await runPriceBot(
  { dryRun: false, log, latestEnd, fetchRows: async () => rows, submit },
  now,
);

// ---- pools: the owner seeds both (MockUSDT is freely mintable on testnet)
const SEED = 100_000_000_000n; // 100,000 mUSDT
await send(owner, usdt, erc20, 'mint', [owner.account.address, 2n * SEED]);
await send(owner, usdt, erc20, 'approve', [perp, 2n ** 255n]);
await send(owner, usdt, erc20, 'approve', [options, 2n ** 255n]);
await send(
  owner,
  perp,
  parseAbi(['function deposit(uint256) returns (uint256)']),
  'deposit',
  [SEED],
);
await send(
  owner,
  options,
  parseAbi(['function fundPool(uint256)']),
  'fundPool',
  [SEED],
);
console.log('pools seeded: 100,000 mUSDT each');

// ---- options: list and quote, a trader buys a $45 call
const quoteDeps = {
  dryRun: false,
  log,
  band: { floor: -50, cap: 300 },
  isListed: async (dayKey: number) =>
    (
      await chain.readContract({
        address: options,
        abi: texasPowerOptionsAbi,
        functionName: 'expiries',
        args: [dayKey],
      })
    )[0],
  openExpiry: async (plan: { dayKey: number; tradingCloseUtc: number }) =>
    send(quoter, options, texasPowerOptionsAbi, 'openExpiry', [
      plan.dayKey,
      BigInt(plan.tradingCloseUtc),
    ]),
  postQuotes: async (dayKey: number, v: QuoteVersion) =>
    send(quoter, options, texasPowerOptionsAbi, 'postQuotes', [
      dayKey,
      v.strikesCents.map(BigInt),
      v.quotes.map((q) => ({
        callAsk: BigInt(q.callAsk),
        callBid: BigInt(q.callBid),
        putAsk: BigInt(q.putAsk),
        putBid: BigInt(q.putBid),
      })),
    ]),
  history: async () => [41, 44, 47, 43, 39, 45, 46],
  dayAhead: async () => null,
};
console.log('quote bot:');
await runQuoteBot(quoteDeps, now);
const expiry = upcomingExpiries(now)[0];
if (!expiry) throw new Error('no open expiry');
const optRead = parseAbi([
  'function getQuote(uint32,uint64,int64) view returns ((uint64 callAsk,uint64 callBid,uint64 putAsk,uint64 putBid))',
  'function requestBuy(uint32,int64,bool,uint256,uint64) returns (uint256)',
  'function seriesId(uint32,int64,bool) pure returns (bytes32)',
  'function balanceOf(bytes32,address) view returns (uint256)',
]);
const [, , version] = await chain.readContract({
  address: options,
  abi: texasPowerOptionsAbi,
  functionName: 'expiries',
  args: [expiry.dayKey],
});
const quote = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'getQuote',
  args: [expiry.dayKey, version, 4500n],
});
await send(owner, usdt, erc20, 'mint', [
  trader.account.address,
  10_000_000_000n,
]);
await send(trader, usdt, erc20, 'approve', [options, 2n ** 255n]);
await send(trader, usdt, erc20, 'approve', [perp, 2n ** 255n]);
await send(trader, options, optRead, 'requestBuy', [
  expiry.dayKey,
  4500n,
  true,
  10_000n,
  quote.callAsk + 50n,
]);
console.log(
  `trader: buy 10 MWh $45 call on ${expiry.dayKey}, ask ${quote.callAsk}`,
);

// ---- futures: a 10 MWh long, filled at the next print
await send(
  trader,
  perp,
  parseAbi(['function requestOpen(bool,uint256,int64) returns (uint256)']),
  'requestOpen',
  [true, 10_000n, 29_999n],
);
console.log('trader: long 10 MWh futures order placed');

await testClient.increaseTime({ seconds: 420 });
await testClient.mine({ blocks: 1 });
const later = now + 420_000;
console.log('price bot, next interval:');
await runPriceBot(
  {
    dryRun: false,
    log,
    latestEnd,
    fetchRows: async () => [
      ...rows,
      {
        interval_start_utc: new Date(lastEnd).toISOString(),
        interval_end_utc: new Date(lastEnd + 300_000).toISOString(),
        lmp: 47,
      },
    ],
    submit,
  },
  later,
);
console.log('keeper:');
await runKeeper({
  dryRun: false,
  log,
  pending: async () => {
    const next = await chain.readContract({
      address: perp,
      abi: texasPowerPerpAbi,
      functionName: 'nextOrderId',
    });
    const items: PendingItem[] = [];
    for (let id = 1n; id < next; id++) {
      const order = await chain.readContract({
        address: perp,
        abi: texasPowerPerpAbi,
        functionName: 'getOrder',
        args: [id],
      });
      if (order.pending)
        items.push({
          kind: 'order',
          id: Number(id),
          createdAt: Number(order.createdAt),
        });
    }
    return items;
  },
  latestRoundId: async () =>
    Number(
      await chain.readContract({
        address: feed,
        abi: livePriceFeedAbi,
        functionName: 'latestRoundId',
        args: [FEED_ID],
      }),
    ),
  publishedAt: async (roundId) =>
    Number(
      (
        await chain.readContract({
          address: feed,
          abi: livePriceFeedAbi,
          functionName: 'getRound',
          args: [FEED_ID, BigInt(roundId)],
        })
      ).publishedAt,
    ),
  execute: async (item, roundId) =>
    send(keeperKey, perp, texasPowerPerpAbi, 'executeOrder', [
      BigInt(item.id),
      BigInt(roundId),
    ]),
});
console.log('quote bot, next run (fills the option order):');
await runQuoteBot(quoteDeps, later);

// ---- what the screens should now show
const position = await chain.readContract({
  address: perp,
  abi: parseAbi([
    'function getPosition(uint256) view returns ((address account,bool open,bool isLong,int64 entryPriceCents,uint256 size,uint256 collateral,uint256 reserve,uint256 fundingEntry,uint256 closeOrderId))',
  ]),
  functionName: 'getPosition',
  args: [1n],
});
const held = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'balanceOf',
  args: [
    await chain.readContract({
      address: options,
      abi: optRead,
      functionName: 'seriesId',
      args: [expiry.dayKey, 4500n, true],
    }),
    trader.account.address,
  ],
});
console.log(
  `futures position 1: open ${position.open}, long ${position.isLong}, entry ${position.entryPriceCents} cents, size ${position.size}`,
);
console.log(`option: trader holds ${held} (10 MWh = 10000) of the $45 call`);
if (!position.open || held !== 10_000n)
  throw new Error('rehearsal check failed');
console.log(`trader account for the screens: ${trader.account.address}`);
console.log('REHEARSAL OK');
