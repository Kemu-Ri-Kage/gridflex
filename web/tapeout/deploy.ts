/**
 * Puts GRIDFLEX's settlement comparator on TapeOut (X Layer mainnet), for the
 * OKX X Layer TapeOut Accelerate hackathon:
 *
 *   1. createCPU on TapeOut's factory: a GRIDFLEX processor (mint price 0);
 *      the factory charges its deploy fee in BEM (TapeOut's token, 8 decimals),
 *      so the script approves exactly that fee first
 *   2. mint the circuit's 130 NAND transistors on it
 *   3. tapeout(netlist, 32 inputs, 2 outputs)
 *   4. find the circuit id and check eval() against the local simulation
 *
 * Dry run by default: it reads the fees and prints the plan and the cost.
 * --live sends the transactions, signed by the key in TAPEOUT_PRIVATE_KEY,
 * which the person running it sets in their own terminal (never in a file
 * that is committed, never typed into a chat). It spends 0.1 BEM (the deploy
 * fee read on 9 Nov 2026; the wallet must already hold it) and a little OKB
 * for the transistors, the tape-out fee and gas.
 *
 * Run from web/:  node tapeout/deploy.ts [--live] [--rpc <url>]
 * The rehearsal on a local fork of X Layer: see tapeout/README.md.
 */
import { writeFileSync } from 'node:fs';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import {
  bitsOf,
  buildComparator,
  evaluate,
  inputBytes,
  toHex,
} from '../lib/tapeout-comparator.ts';

const FACTORY: Address = '0x1f09daefa827f02cbb40967cc91b259763760761';
/** BEM, the token the factory takes its deploy fee in (seen in a createCPU trace). */
const BEM: Address = '0x60e62Efa9405d6873C5deaBD4E6CC91c25363952';
/** A BEM holder on mainnet (the fee recipient), used only to fund the rehearsal account on a local fork. */
const REHEARSAL_BEM_SOURCE: Address =
  '0x571d447f4f24688eC35Ccf07f1D6993655F6aF15';
const args = process.argv.slice(2);
const live = args.includes('--live');
const rpc = args.includes('--rpc')
  ? args[args.indexOf('--rpc') + 1]
  : 'https://rpc.xlayer.tech';
const rehearsal = args.includes('--rehearsal'); // a local fork: signs with anvil's public test account

const xlayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const chain = createPublicClient({ chain: xlayer, transport: http(rpc) });

const factoryAbi = parseAbi([
  'function deployFee() view returns (uint256)',
  'function cpuCount() view returns (uint256)',
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) returns (address transistors, address circuits)',
  'event CPUCreated(address indexed transistors, address indexed circuits, string name, string symbol)',
]);
const circuitsAbi = parseAbi([
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function netlist(uint256 id) view returns (bytes)',
  'function transistors() view returns (address)',
]);
const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);
const transistorsAbi = parseAbi([
  'function mint(uint256 id, uint256 amount) payable',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
]);

const PROCESSOR = {
  name: 'GRIDFLEX',
  symbol: 'GRID',
  story:
    "Settlement logic for GRIDFLEX Texas power options: a 16-bit comparator that says whether the day's price pays a call (above the strike) or a put (below).",
  transistorSupply: 10_000n,
  mintPrice: 0n,
};

// the check vectors: (A, B) in cents above the -$50 floor, and what eval must say
const VECTORS: Array<[number, number]> = [
  [10_200, 9_500], // $52 vs a $45 strike: call pays
  [9_000, 9_500], // $40 vs $45: put pays
  [9_500, 9_500], // at the strike: neither
  [0, 500], // the floor vs a -$45 strike: put pays
  [35_000, 34_500], // the cap vs a $295 strike: call pays
];

const netlist = buildComparator();
const nlHex = toHex(netlist.bytes);

async function main() {
  const [deployFee, cpuCount] = await Promise.all([
    chain.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'deployFee',
    }),
    chain.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'cpuCount',
    }),
  ]);
  const feeSymbol = await chain.readContract({
    address: BEM,
    abi: erc20,
    functionName: 'symbol',
  });
  if (feeSymbol !== 'BEM')
    throw new Error(`expected BEM at ${BEM}, found ${feeSymbol}`);
  console.log(
    `TapeOut factory ${FACTORY}: ${cpuCount} processors, deploy fee ${Number(deployFee) / 1e8} BEM`,
  );
  console.log(
    `circuit: ${netlist.gates} NAND gates, ${netlist.transistors} transistors to mint, 32 inputs, 2 outputs, ${netlist.bytes.length} bytes`,
  );

  if (!live) {
    console.log(
      'dry run: nothing sent. --live sends with TAPEOUT_PRIVATE_KEY.',
    );
    console.log(`netlist ${nlHex.slice(0, 66)}...`);
    return;
  }

  const account = rehearsal
    ? mnemonicToAccount(
        'test test test test test test test test test test test junk',
      )
    : privateKeyToAccount(process.env.TAPEOUT_PRIVATE_KEY as Hex);
  if (!rehearsal && !process.env.TAPEOUT_PRIVATE_KEY)
    throw new Error('set TAPEOUT_PRIVATE_KEY in your terminal first');
  const wallet = createWalletClient({
    account,
    chain: xlayer,
    transport: http(rpc),
  });
  if (rehearsal) {
    // a local fork only: give the test account the BEM fee from a mainnet holder
    const fork = createTestClient({
      chain: xlayer,
      mode: 'anvil',
      transport: http(rpc),
    });
    // anvil's public test address has code on X Layer mainnet; a real wallet has none, so clear it on the fork
    await fork.setCode({ address: account.address, bytecode: '0x' });
    await fork.setBalance({ address: REHEARSAL_BEM_SOURCE, value: 10n ** 18n });
    await fork.impersonateAccount({ address: REHEARSAL_BEM_SOURCE });
    const source = createWalletClient({
      account: REHEARSAL_BEM_SOURCE,
      chain: xlayer,
      transport: http(rpc),
    });
    await chain.waitForTransactionReceipt({
      hash: await source.writeContract({
        address: BEM,
        abi: erc20,
        functionName: 'transfer',
        args: [account.address, deployFee + 10n ** 8n],
      }), // the fee plus 1 BEM for protocol fees
    });
    await fork.stopImpersonatingAccount({ address: REHEARSAL_BEM_SOURCE });
  }
  const bem = await chain.readContract({
    address: BEM,
    abi: erc20,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (bem < deployFee)
    throw new Error(
      `the wallet holds ${Number(bem) / 1e8} BEM; the deploy fee is ${Number(deployFee) / 1e8} BEM`,
    );
  const balanceBefore = await chain.getBalance({ address: account.address });
  const wait = async (hash: Hex, what: string) => {
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success')
      throw new Error(`${what} reverted in ${hash}`);
    console.log(`${what}: ${hash}`);
    return receipt;
  };

  // 1. the GRIDFLEX processor: approve exactly the BEM fee, then create it
  await wait(
    await wallet.writeContract({
      address: BEM,
      abi: erc20,
      functionName: 'approve',
      args: [FACTORY, deployFee],
    }),
    'approve the BEM deploy fee',
  );
  const created = await wait(
    await wallet.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'createCPU',
      args: [
        PROCESSOR.name,
        PROCESSOR.symbol,
        PROCESSOR.story,
        PROCESSOR.transistorSupply,
        PROCESSOR.mintPrice,
      ],
    }),
    'createCPU',
  );
  // the processor's two new contracts are the ones initialised in this transaction;
  // the circuits contract answers TAPEOUT_FEE() and names its transistors contract
  const fresh = [
    ...new Set(created.logs.map((l) => l.address.toLowerCase())),
  ].filter(
    (a) => a !== BEM.toLowerCase() && a !== FACTORY.toLowerCase(),
  ) as Address[];
  let circuits: Address | null = null;
  for (const candidate of fresh) {
    const fee = await chain
      .readContract({
        address: candidate,
        abi: circuitsAbi,
        functionName: 'TAPEOUT_FEE',
      })
      .catch(() => null);
    if (fee !== null) circuits = candidate;
  }
  if (!circuits) throw new Error('could not find the new circuits contract');
  const transistors = await chain.readContract({
    address: circuits,
    abi: circuitsAbi,
    functionName: 'transistors',
  });
  console.log(
    `processor GRIDFLEX: transistors ${transistors}, circuits ${circuits}`,
  );

  // 2. the transistors
  const [mintPrice, protocolFee, tapeoutFee] = await Promise.all([
    chain.readContract({
      address: transistors,
      abi: transistorsAbi,
      functionName: 'mintPrice',
    }),
    chain.readContract({
      address: transistors,
      abi: transistorsAbi,
      functionName: 'protocolFee',
    }),
    chain.readContract({
      address: circuits,
      abi: circuitsAbi,
      functionName: 'TAPEOUT_FEE',
    }),
  ]);
  const count = BigInt(netlist.transistors);
  // older processors take the protocol fee in OKB; newer ones in BEM: try OKB, else approve BEM
  const okbValue = count * mintPrice + protocolFee;
  const paysInOkb = await chain
    .simulateContract({
      account,
      address: transistors,
      abi: transistorsAbi,
      functionName: 'mint',
      args: [0n, count],
      value: okbValue,
    })
    .then(() => true)
    .catch(() => false);
  if (!paysInOkb) {
    await wait(
      await wallet.writeContract({
        address: BEM,
        abi: erc20,
        functionName: 'approve',
        args: [transistors, protocolFee],
      }),
      `approve the ${Number(protocolFee) / 1e8} BEM protocol fee`,
    );
  }
  await wait(
    await wallet.writeContract({
      address: transistors,
      abi: transistorsAbi,
      functionName: 'mint',
      args: [0n, count],
      value: paysInOkb ? okbValue : count * mintPrice,
    }),
    `mint ${count} NAND`,
  );

  // 3. tape out
  await wait(
    await wallet.writeContract({
      address: circuits,
      abi: circuitsAbi,
      functionName: 'tapeout',
      args: [nlHex, netlist.nIn, netlist.nOut],
      value: tapeoutFee,
    }),
    'tapeout',
  );

  // 4. find it and check it
  let id = 0n;
  for (let i = 1n; i <= 50n && id === 0n; i++) {
    const stored = await chain
      .readContract({
        address: circuits,
        abi: circuitsAbi,
        functionName: 'netlist',
        args: [i],
      })
      .catch(() => '0x');
    if (stored.toLowerCase() === nlHex.toLowerCase()) id = i;
  }
  if (id === 0n) throw new Error('the circuit was not found by its netlist');
  for (const [a, b] of VECTORS) {
    const out = await chain.readContract({
      address: circuits,
      abi: circuitsAbi,
      functionName: 'eval',
      args: [id, toHex(inputBytes(a, b))],
    });
    const got = Number.parseInt(out.slice(2, 4) || '0', 16);
    const [gt, lt] = evaluate(netlist, bitsOf(inputBytes(a, b), 32));
    const want = gt | (lt << 1);
    console.log(`eval(${id}, A=${a}, B=${b}) = ${got} (expected ${want})`);
    if (got !== want)
      throw new Error('the on-chain circuit disagrees with the simulation');
  }
  const spent =
    balanceBefore - (await chain.getBalance({ address: account.address }));
  console.log(
    `done: circuit ${id} on ${circuits}; spent ${formatEther(spent)} OKB including gas`,
  );
  if (!rehearsal) {
    writeFileSync(
      new URL('./deployed.json', import.meta.url),
      `${JSON.stringify({ chainId: 196, factory: FACTORY, transistors, circuits, circuitId: id.toString(), netlist: nlHex }, null, 2)}\n`,
    );
    console.log('saved tapeout/deployed.json');
  }
}

await main();
