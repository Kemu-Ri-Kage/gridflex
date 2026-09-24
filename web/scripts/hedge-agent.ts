/**
 * The GRIDFLEX hedging agent, a prototype: it asks the Texas power price
 * API for the price, the markets and a hedge quote, paying $0.01 in USDT0
 * per call over x402 when the API charges, prints the plan, and with
 * --execute buys each rung's YES from its own testnet wallet exactly as
 * the order ticket does. Run from the repo root:
 *
 *   node web/scripts/hedge-agent.ts [--base URL] [--mw 10] [--hours 24]
 *     [--day YYYY-MM-DD] [--protect-to 80] [--fund] [--execute]
 *
 * The wallet is a throwaway X Layer testnet key kept in
 * web/.agent-wallet.json (git-ignored, mode 600), or AGENT_PRIVATE_KEY.
 * The key is never printed.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ExactEvmScheme, toClientEvmSigner } from '@okxweb3/x402-evm';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@okxweb3/x402-fetch';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { approvalTarget, needsApproval, type ApprovalKind } from '../lib/allowance.ts';
import { runBuy } from '../lib/buy-flow.ts';
import {
  binaryMarketAbi,
  mockUsdtAbi,
  outcomeTokenAbi,
  xLayerTestnet,
  xLayerTransport,
} from '../lib/contracts.ts';
import { explorerAddressUrl, explorerTxUrl } from '../lib/explorer.ts';
import { formatToken } from '../lib/format.ts';
import {
  MIN_GAS_WEI,
  USAGE,
  buyUnits,
  hedgeLine,
  marketsLine,
  nextTradingDay,
  parseAgentArgs,
  planLines,
  preflightProblems,
  priceLine,
  receiptLine,
  type AgentOptions,
  type CallPayment,
  type HedgeAnswer,
  type PriceAnswer,
} from '../lib/hedge-agent.ts';
import type { MarketRow, PaymentInfo } from '../lib/price-api.ts';
import type { PublicAddresses } from '../lib/site-data.ts';
import {
  minimumOutputForQuote,
  parsePositiveTokenAmount,
  swapDeadline,
} from '../lib/trade.ts';

const WALLET_FILE = fileURLToPath(new URL('../.agent-wallet.json', import.meta.url));

const log = (line = '') => console.log(line);

function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** The agent's key: AGENT_PRIVATE_KEY, the saved wallet, or a new one saved now. */
function loadKey(): { key: Hex; source: string } {
  const valid = (key: unknown): key is Hex =>
    typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key);
  const fromEnv = process.env.AGENT_PRIVATE_KEY;
  if (fromEnv) {
    if (!valid(fromEnv)) throw new Error('AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.');
    return { key: fromEnv, source: 'AGENT_PRIVATE_KEY' };
  }
  if (existsSync(WALLET_FILE)) {
    const saved = (JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as { privateKey?: unknown }).privateKey;
    if (!valid(saved)) throw new Error(`${WALLET_FILE} has no valid privateKey.`);
    return { key: saved, source: 'web/.agent-wallet.json' };
  }
  const key = generatePrivateKey();
  const saved = {
    note: 'Throwaway X Layer testnet key for web/scripts/hedge-agent.ts. Never send it real assets.',
    privateKey: key,
  };
  writeFileSync(WALLET_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(WALLET_FILE, 0o600);
  return { key, source: 'new, saved to web/.agent-wallet.json' };
}

async function main(options: AgentOptions) {
  const { key, source } = loadKey();
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: xLayerTestnet, transport: xLayerTransport() });
  const walletClient = createWalletClient({
    account,
    chain: xLayerTestnet,
    transport: xLayerTransport(),
  });
  log(`Agent wallet ${account.address} (${source})`);

  const indexResponse = await fetch(`${options.base}/api/v1`, {
    headers: { Accept: 'application/json' },
  });
  if (!indexResponse.ok) throw new Error(`${options.base}/api/v1 answered ${indexResponse.status}.`);
  const index = (await indexResponse.json()) as { network: string; payment: PaymentInfo };
  const charging = index.payment.mode === 'x402';
  log(
    charging
      ? `GRIDFLEX API at ${options.base}: ${index.payment.price} in ${index.payment.asset} a call on ${index.network}, paid to ${index.payment.payTo}`
      : `GRIDFLEX API at ${options.base}: free for now (payments are not switched on)`,
  );

  const paidFetch = charging
    ? wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [
          {
            network: index.network as `${string}:${string}`,
            client: new ExactEvmScheme(toClientEvmSigner(account, publicClient)),
          },
        ],
      })
    : fetch;

  async function call<T>(path: string): Promise<{ body: T; payment: CallPayment }> {
    const response = await paidFetch(`${options.base}${path}`, {
      headers: { Accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}${body.error ? `: ${body.error}` : ''}`);
    }
    const receipt = response.headers.get('PAYMENT-RESPONSE');
    const paid = charging || response.headers.get('X-GRIDFLEX-Payment') === 'x402';
    const payment: CallPayment = paid
      ? { paid: true, tx: receipt ? decodePaymentResponseHeader(receipt).transaction || null : null }
      : { paid: false };
    return { body, payment };
  }
  const report = (line: string, payment: CallPayment) => {
    log(line);
    const receipt = receiptLine(payment);
    if (receipt) log(receipt);
  };

  const price = await call<PriceAnswer>('/api/v1/price');
  report(priceLine(price.payment, price.body), price.payment);

  const markets = await call<{ markets: MarketRow[] }>('/api/v1/markets');
  const today = new Date().toISOString().slice(0, 10);
  const day = options.day ?? nextTradingDay(markets.body.markets, today);
  report(marketsLine(markets.payment, markets.body.markets, day), markets.payment);
  if (!day) {
    log('No market is trading after today, so there is nothing to hedge.');
    return;
  }

  const query = new URLSearchParams({
    mw: String(options.mw),
    hours: String(options.hours),
    day,
    protectTo: String(options.protectTo),
  });
  const quote = await call<HedgeAnswer>(`/api/v1/hedge-quote?${query}`);
  report(hedgeLine(quote.payment, quote.body), quote.payment);
  log();
  for (const line of planLines(quote.body)) log(line);
  log();
  for (const note of quote.body.notes) log(`· ${note}`);
  log();

  if (!options.fund && !options.execute) {
    log('Dry run: nothing sent. --fund mints test mUSDT to the agent; --execute buys the plan.');
    return;
  }

  const addressesResponse = await fetch(`${options.base}/data/addresses.json`);
  if (!addressesResponse.ok) throw new Error('Could not read the contract addresses from the site.');
  const collateral = getAddress(((await addressesResponse.json()) as PublicAddresses).MockUSDT);

  const musdtBalance = async () =>
    (await publicClient.readContract({
      address: collateral,
      abi: mockUsdtAbi,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;

  /** Sends one transaction and waits for it; true only once it confirmed. */
  async function send(
    label: string,
    request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  ): Promise<boolean> {
    try {
      const hash = await walletClient.writeContract(request);
      log(`  ${label}: ${explorerTxUrl(hash)}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        log(`  ${label} reverted.`);
        return false;
      }
      return true;
    } catch (error) {
      log(`  ${label} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Approves `spender` only when the allowance doesn't cover `amount`, as the ticket does. */
  async function ensureAllowance(
    label: string,
    kind: ApprovalKind,
    token: Address,
    abi: Abi,
    spender: Address,
    amount: bigint,
  ): Promise<boolean> {
    try {
      const allowance = (await publicClient.readContract({
        address: token,
        abi,
        functionName: 'allowance',
        args: [account.address, spender],
      })) as bigint;
      if (!needsApproval(allowance, amount)) return true;
    } catch {
      // Fall through and approve; a failed read must not block the buy.
    }
    return send(label, {
      address: token,
      abi,
      functionName: 'approve',
      args: [spender, approvalTarget(kind, amount)],
    });
  }

  const gas = await publicClient.getBalance({ address: account.address });
  if (options.fund) {
    if (gas < MIN_GAS_WEI) {
      log(preflightProblems(account.address, gas, 0n, 0n)[0]);
      process.exitCode = 1;
      return;
    }
    log('Getting 1,000 test mUSDT');
    const minted = await send('Getting test mUSDT', {
      address: collateral,
      abi: mockUsdtAbi,
      functionName: 'mint',
      args: [account.address, parsePositiveTokenAmount('1000')],
    });
    if (!minted) {
      process.exitCode = 1;
      return;
    }
    log(`  The agent holds ${formatToken(await musdtBalance())} mUSDT.`);
  }
  if (!options.execute) return;

  const needed = quote.body.rungs.reduce((sum, rung) => sum + buyUnits(rung.cost), 0n);
  const problems = preflightProblems(
    account.address,
    await publicClient.getBalance({ address: account.address }),
    await musdtBalance(),
    needed,
  );
  if (problems.length > 0) {
    for (const problem of problems) log(problem);
    log(`Agent wallet on OKLink: ${explorerAddressUrl(account.address)}`);
    process.exitCode = 1;
    return;
  }

  for (const rung of quote.body.rungs) {
    const market = getAddress(rung.market);
    const units = buyUnits(rung.cost);
    const quoteSwap = async () =>
      (await publicClient.readContract({
        address: market,
        abi: binaryMarketAbi,
        functionName: 'quoteSwap',
        args: [false, units],
      })) as bigint;
    log(`Buying YES on the $${rung.strike} strike with ${formatToken(units)} mUSDT`);
    const outcome = await runBuy(units, {
      readBalance: musdtBalance,
      quoteMinimumSwapOut: async () => minimumOutputForQuote(await quoteSwap()),
      approveCollateral: () =>
        ensureAllowance('Approving mUSDT', 'collateral', collateral, mockUsdtAbi, market, units),
      mintPair: () =>
        send('Minting the YES + NO pair', {
          address: market,
          abi: binaryMarketAbi,
          functionName: 'mintSet',
          args: [units],
        }),
      // Buying YES sends the minted NO into the pool (yesForNo = false).
      swap: async (minimumSwapOut) => {
        try {
          const noToken = (await publicClient.readContract({
            address: market,
            abi: binaryMarketAbi,
            functionName: 'noToken',
          })) as Address;
          const approved = await ensureAllowance(
            'Approving NO',
            'outcome',
            noToken,
            outcomeTokenAbi,
            market,
            units,
          );
          if (!approved) return false;
          if ((await quoteSwap()) < minimumSwapOut) {
            log('  Stopped: the price moved beyond the 0.50% tolerance since the quote.');
            return false;
          }
          const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
          return send('Swapping NO into YES', {
            address: market,
            abi: binaryMarketAbi,
            functionName: 'swap',
            args: [false, units, minimumSwapOut, swapDeadline(latestBlock.timestamp)],
          });
        } catch (error) {
          log(`  Could not prepare the swap: ${errorMessage(error)}`);
          return false;
        }
      },
      recordPendingOrder: () => {},
      forgetPendingOrder: () => {},
      fail: (message, cause) => log(`  Stopped: ${message}${cause ? `: ${errorMessage(cause)}` : ''}`),
    });
    if (outcome === 'pending') {
      log('  The YES + NO pair is minted but the swap did not confirm, so the agent holds both sides.');
    }
    if (outcome !== 'bought') {
      process.exitCode = 1;
      return;
    }
    log(`  Bought: YES on the $${rung.strike} strike.`);
  }
  log(`Hedge placed. Agent wallet on OKLink: ${explorerAddressUrl(account.address)}`);
}

let options: AgentOptions;
try {
  options = parseAgentArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${errorMessage(error)}\n\n${USAGE}`);
  process.exit(2);
}
try {
  await main(options);
} catch (error) {
  console.error(`Stopped: ${errorMessage(error)}`);
  process.exitCode = 1;
}
