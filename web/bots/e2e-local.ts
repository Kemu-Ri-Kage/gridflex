/**
 * End-to-end check of both bots against the real contracts on a local
 * anvil chain (http://127.0.0.1:8546), with anvil's public test accounts.
 * Run from web/: node bots/e2e-local.ts <contracts/out with LivePriceFeed and TexasPowerOptions built>
 * Not part of the deployed Worker.
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

import { runPriceBot, type Round } from '../lib/price-bot.ts';
import {
  runQuoteBot,
  upcomingExpiries,
  type QuoteVersion,
} from '../lib/quote-bot.ts';
import { livePriceFeedAbi, texasPowerOptionsAbi } from './abi.ts';

const [artifacts] = process.argv.slice(2);
const local = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8546'] } },
});
const transport = http('http://127.0.0.1:8546');
const chain = createPublicClient({ chain: local, transport });
const testClient = createTestClient({ chain: local, mode: 'anvil', transport });
// anvil's public test accounts, from its published test mnemonic (no real keys)
const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';
const key = (index: number) =>
  createWalletClient({
    account: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }),
    chain: local,
    transport,
  });
const owner = key(0);
const reporter = key(1);
const quoter = key(3);
const trader = key(4);
const FEED_ID = keccak256(toBytes('ERCOT_HBNORTH_RT_5MIN'));
const log = (line: string) => console.log(`  ${line}`);
const wait = async (hash: Hex) => {
  const r = await chain.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted ${hash}`);
  return hash;
};
const artifact = (name: string) =>
  JSON.parse(readFileSync(`${artifacts}/${name}.sol/${name}.json`, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };

// ---- deploy the token, oracle and options
const usdtArt = artifact('MockUSDT');
const usdt = (
  await chain.waitForTransactionReceipt({
    hash: await owner.deployContract({
      abi: usdtArt.abi,
      bytecode: usdtArt.bytecode.object,
    }),
  })
).contractAddress!;
const oracleArt = artifact('GridOracle');
const oracle = (
  await chain.waitForTransactionReceipt({
    hash: await owner.deployContract({
      abi: oracleArt.abi,
      bytecode: oracleArt.bytecode.object,
      args: [reporter.account.address, 3600n],
    }),
  })
).contractAddress!;
const feedArt = artifact('LivePriceFeed');
const feed: Address = (
  await chain.waitForTransactionReceipt({
    hash: await owner.deployContract({
      abi: feedArt.abi,
      bytecode: feedArt.bytecode.object,
      args: [
        owner.account.address,
        reporter.account.address,
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        300n,
        -25_100n,
        500_000n,
      ],
    }),
  })
).contractAddress!;
const optArt = artifact('TexasPowerOptions');
const options = (
  await chain.waitForTransactionReceipt({
    hash: await owner.deployContract({
      abi: optArt.abi,
      bytecode: optArt.bytecode.object,
      args: [
        owner.account.address,
        quoter.account.address,
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        usdt,
        oracle,
        keccak256(toBytes('ERCOT_HBNORTH_RT_AVG')),
        -5000n,
        30000n,
        500n,
      ],
    }),
  })
).contractAddress!;
console.log(`deployed options ${options}, feed ${feed}`);

// ---- price bot, live, with GridStatus replaced by fixed rows for the last 25 minutes
const now = Date.now();
const lastEnd = Math.floor(now / 300_000) * 300_000;
const rows = [5, 4, 3, 2, 1].map((k, i) => ({
  interval_start_utc: new Date(lastEnd - k * 300_000).toISOString(),
  interval_end_utc: new Date(lastEnd - (k - 1) * 300_000).toISOString(),
  lmp: [43.1, 44.2, 45.3, 44.9, 46.05][i],
}));
console.log('price bot:');
const published = await runPriceBot(
  {
    dryRun: false,
    log,
    latestEnd: async () => {
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
    },
    fetchRows: async () => rows,
    submit: async (round: Round) =>
      wait(
        await reporter.writeContract({
          address: feed,
          abi: livePriceFeedAbi,
          functionName: 'submitPrice',
          args: [
            FEED_ID,
            BigInt(round.intervalEnd),
            BigInt(round.priceCents),
            round.sourceHash,
          ],
        }),
      ),
  },
  now,
);
const feedRead = parseAbi([
  'function latestIndex(bytes32,uint256) view returns (int64,uint64,uint64)',
]);
const [index, roundId] = await chain.readContract({
  address: feed,
  abi: feedRead,
  functionName: 'latestIndex',
  args: [FEED_ID, 3600n],
});
console.log(
  `  on chain: round ${roundId}, index ${index} cents (expect ${Math.trunc((4530 + 4490 + 4605) / 3)})`,
);
if (
  published.length !== 3 ||
  index !== BigInt(Math.trunc((4530 + 4490 + 4605) / 3))
)
  throw new Error('price bot check failed');

// ---- quote bot, live: lists 7 days and posts quotes; then a trade fills at the next post
const erc20 = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
await wait(
  await owner.writeContract({
    address: usdt,
    abi: erc20,
    functionName: 'mint',
    args: [owner.account.address, 1_000_000_000_000n],
  }),
);
await wait(
  await owner.writeContract({
    address: usdt,
    abi: erc20,
    functionName: 'approve',
    args: [options, 2n ** 255n],
  }),
);
await wait(
  await owner.writeContract({
    address: options,
    abi: parseAbi(['function fundPool(uint256)']),
    functionName: 'fundPool',
    args: [1_000_000_000_000n],
  }),
);

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
    wait(
      await quoter.writeContract({
        address: options,
        abi: texasPowerOptionsAbi,
        functionName: 'openExpiry',
        args: [plan.dayKey, BigInt(plan.tradingCloseUtc)],
      }),
    ),
  postQuotes: async (dayKey: number, v: QuoteVersion) =>
    wait(
      await quoter.writeContract({
        address: options,
        abi: texasPowerOptionsAbi,
        functionName: 'postQuotes',
        args: [
          dayKey,
          v.strikesCents.map(BigInt),
          v.quotes.map((q) => ({
            callAsk: BigInt(q.callAsk),
            callBid: BigInt(q.callBid),
            putAsk: BigInt(q.putAsk),
            putBid: BigInt(q.putBid),
          })),
        ],
      }),
    ),
  history: async () => [41, 44, 47, 43, 39, 45, 46],
  dayAhead: async () => null,
};
console.log('quote bot, first run:');
await runQuoteBot(quoteDeps, now);

const tomorrow = upcomingExpiries(now)[0].dayKey;
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
  args: [tomorrow],
});
const quote = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'getQuote',
  args: [tomorrow, version, 4500n],
});
console.log(
  `  ${tomorrow} v${version}: $45 call ask ${quote.callAsk} cents, bid ${quote.callBid}`,
);

await wait(
  await owner.writeContract({
    address: usdt,
    abi: erc20,
    functionName: 'mint',
    args: [trader.account.address, 10_000_000_000n],
  }),
);
await wait(
  await trader.writeContract({
    address: usdt,
    abi: erc20,
    functionName: 'approve',
    args: [options, 2n ** 255n],
  }),
);
await wait(
  await trader.writeContract({
    address: options,
    abi: optRead,
    functionName: 'requestBuy',
    args: [tomorrow, 4500n, true, 10_000n, quote.callAsk + 50n],
  }),
);
const before = await chain.readContract({
  address: usdt,
  abi: erc20,
  functionName: 'balanceOf',
  args: [trader.account.address],
});
await testClient.increaseTime({ seconds: 300 });
await testClient.mine({ blocks: 1 });

console.log('quote bot, second run (fills the order):');
await runQuoteBot(quoteDeps, now + 300_000);
const id = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'seriesId',
  args: [tomorrow, 4500n, true],
});
const held = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'balanceOf',
  args: [id, trader.account.address],
});
const after = await chain.readContract({
  address: usdt,
  abi: erc20,
  functionName: 'balanceOf',
  args: [trader.account.address],
});
const [, , v2] = await chain.readContract({
  address: options,
  abi: texasPowerOptionsAbi,
  functionName: 'expiries',
  args: [tomorrow],
});
const fillQuote = await chain.readContract({
  address: options,
  abi: optRead,
  functionName: 'getQuote',
  args: [tomorrow, v2, 4500n],
});
const refund = after - before;
const paid = 10_000n * (quote.callAsk + 50n) * 10n - refund;
console.log(
  `  trader holds ${held} (10 MWh), paid ${paid} units = 10 MWh x ${fillQuote.callAsk} cents x 10 = ${10_000n * fillQuote.callAsk * 10n}`,
);
if (held !== 10_000n || paid !== 10_000n * fillQuote.callAsk * 10n)
  throw new Error('quote bot fill check failed');
console.log('END-TO-END OK');
