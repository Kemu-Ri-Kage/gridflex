/**
 * The local chain for the market simulation: starts its own anvil, sends
 * transactions from anvil's unlocked test accounts at block times the
 * simulation chooses, decodes reverts, and records gas per action.
 *
 * Refuses anything but a local anvil it started itself (chain 31337): it
 * moves the chain's clock, and anvil's test accounts are public.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

export const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function loadArtifact(outDir: string, name: string): Artifact {
  const json = JSON.parse(
    readFileSync(`${outDir}/${name}.sol/${name}.json`, 'utf8'),
  ) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  logIndex: number;
}

export interface TxResult {
  ok: boolean;
  hash: Hex;
  gasUsed: bigint;
  /** Block time, unix seconds. */
  ts: number;
  block: bigint;
  logs: DecodedLog[];
  /** The revert, decoded: "ErrorName(arg, ...)", "Panic(0x01)" or a message. */
  error?: string;
  errorName?: string;
}

export interface TxRequest {
  from: Address;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  gas?: bigint;
}

const DEFAULT_GAS = 3_000_000n;

function describeArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(describeArg).join(',')}]`;
  return String(v);
}

export class Chain {
  readonly url: string;
  readonly pub;
  private process: ChildProcess | null = null;
  private allAbi: Abi = [];
  /** Block time of the latest block, unix seconds. */
  lastTs = 0;
  readonly gas = new Map<string, bigint[]>();
  txCount = 0;
  revertCount = 0;
  private rpcId = 0;

  constructor(port: number) {
    this.url = `http://127.0.0.1:${port}`;
    this.pub = createPublicClient({
      transport: http(this.url, { batch: { wait: 0, batchSize: 500 } }),
    });
  }

  /** Starts anvil with `accounts` funded test accounts and its clock at `startTs`. */
  async start(accounts: number, startTs: number): Promise<void> {
    const port = new URL(this.url).port;
    this.process = spawn(
      'anvil',
      [
        '--port', port,
        '--chain-id', '31337',
        '--accounts', String(accounts),
        '--balance', '1000000',
        '--mnemonic', ANVIL_MNEMONIC,
        '--base-fee', '0',
        '--gas-price', '0',
        '--disable-min-priority-fee',
        // room for a burst of hundreds of orders in one block
        '--gas-limit', '400000000',
        '--auto-impersonate',
        '--timestamp', String(startTs),
        '--order', 'fifo',
        // blocks are mined by the simulation, one per transaction (or one per burst)
        '--no-mining',
        // keep only the latest states: each kept state is a full copy, and old ones on disk slow every block
        '--prune-history', '2',
        '--transaction-block-keeper', '8',
        '--silent',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    for (let i = 0; i < 300; i++) {
      try {
        const id = await this.rpc<Hex>('eth_chainId', []);
        if (Number(id) !== 31337) throw new Error(`not anvil: chain ${id}`);
        this.lastTs = startTs;
        return;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('not anvil'))
          throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('anvil did not start (is foundry installed?)');
  }

  stop() {
    this.process?.kill();
  }

  /** Every ABI whose events and errors the chain should decode. */
  registerAbi(abi: Abi) {
    this.allAbi = [...this.allAbi, ...abi];
  }

  /** Milliseconds spent waiting on anvil, per method. */
  readonly timing = new Map<string, { calls: number; ms: number }>();

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const started = performance.now();
    try {
      return await this.rpcOnce<T>(method, params);
    } finally {
      const t = this.timing.get(method) ?? { calls: 0, ms: 0 };
      t.calls++;
      t.ms += performance.now() - started;
      this.timing.set(method, t);
    }
  }

  private async rpcOnce<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async accounts(): Promise<Address[]> {
    return this.rpc<Address[]>('eth_accounts', []);
  }

  async deploy(from: Address, art: Artifact, args: readonly unknown[], ts: number) {
    const { encodeDeployData } = await import('viem');
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    const hash = await this.rpc<Hex>('eth_sendTransaction', [
      { from, data, gas: '0x' + (12_000_000).toString(16), gasPrice: '0x0' },
    ]);
    await this.mine(ts);
    const receipt = await this.receipt<{ contractAddress: Address; status: Hex }>(hash);
    if (receipt.status !== '0x1') throw new Error('deploy reverted');
    this.registerAbi(art.abi);
    return receipt.contractAddress;
  }

  /** Mines one block with everything sent since the last one, at `ts` (or a second after the last block). */
  private async mine(ts: number) {
    const next = Math.max(ts, this.lastTs + 1);
    await this.rpc('evm_mine', [next]);
    this.lastTs = next;
    return next;
  }

  /** Sends one transaction in its own block at block time `ts` (or one second after the last block). */
  async send(req: TxRequest, ts: number, label?: string): Promise<TxResult> {
    const data = encodeFunctionData({
      abi: req.abi,
      functionName: req.functionName,
      args: req.args,
    } as never);
    const hash = await this.rpc<Hex>('eth_sendTransaction', [
      {
        from: req.from,
        to: req.to,
        data,
        gas: '0x' + (req.gas ?? DEFAULT_GAS).toString(16),
        gasPrice: '0x0',
      },
    ]);
    const blockTs = await this.mine(ts);
    const result = await this.finish(hash, blockTs, req);
    this.record(label ?? req.functionName, result);
    return result;
  }

  /**
   * Sends many transactions into ONE block at block time `ts`, in the order
   * given, as if they all arrived at the same moment.
   */
  async burst(
    reqs: { req: TxRequest; label?: string }[],
    ts: number,
  ): Promise<TxResult[]> {
    const hashes: Hex[] = [];
    {
      for (const { req } of reqs) {
        const data = encodeFunctionData({
          abi: req.abi,
          functionName: req.functionName,
          args: req.args,
        } as never);
        hashes.push(
          await this.rpc<Hex>('eth_sendTransaction', [
            {
              from: req.from,
              to: req.to,
              data,
              gas: '0x' + (req.gas ?? DEFAULT_GAS).toString(16),
              gasPrice: '0x0',
            },
          ]),
        );
      }
      await this.mine(ts);
    }
    const results: TxResult[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const result = await this.finish(hashes[i], this.lastTs, reqs[i].req);
      this.record(reqs[i].label ?? reqs[i].req.functionName, result);
      results.push(result);
    }
    return results;
  }

  private async finish(hash: Hex, ts: number, req: TxRequest): Promise<TxResult> {
    const receipt = await this.receipt<{
      status: Hex;
      gasUsed: Hex;
      blockNumber: Hex;
      logs: { address: Address; topics: Hex[]; data: Hex; logIndex: Hex }[];
    }>(hash);
    this.txCount++;
    const ok = receipt.status === '0x1';
    const result: TxResult = {
      ok,
      hash,
      gasUsed: BigInt(receipt.gasUsed),
      ts,
      block: BigInt(receipt.blockNumber),
      logs: [],
    };
    if (ok) {
      const parsed = parseEventLogs({
        abi: this.allAbi,
        logs: receipt.logs.map((l) => ({
          ...l,
          blockHash: null,
          blockNumber: null,
          transactionHash: null,
          transactionIndex: null,
          logIndex: Number(l.logIndex),
          removed: false,
        })) as never,
      }) as unknown as {
        address: Address;
        eventName: string;
        args: Record<string, unknown>;
        logIndex: number;
      }[];
      result.logs = parsed.map((l) => ({
        address: l.address.toLowerCase() as Address,
        eventName: l.eventName,
        args: l.args,
        logIndex: l.logIndex,
      }));
    } else {
      this.revertCount++;
      const decoded = await this.revertReason(req);
      result.error = decoded.text;
      result.errorName = decoded.name;
    }
    return result;
  }

  /** anvil mines right away, but the receipt can lag the send by a moment. */
  private async receipt<T>(hash: Hex): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const r = await this.rpc<T | null>('eth_getTransactionReceipt', [hash]);
      if (r) return r;
      await new Promise((res) => setTimeout(res, i < 20 ? 1 : 20));
    }
    throw new Error(`no receipt for ${hash}`);
  }

  /**
   * Why a mined transaction reverted: the same call again on top of its block. A reverted
   * transaction changes no state (gas is free here), and its block is the latest, so the
   * call sees what the transaction saw (tracing would replay a pruned chain, far slower).
   */
  private async revertReason(req: TxRequest): Promise<{ name: string; text: string }> {
    const r = await this.check(req);
    return r.ok ? { name: 'reverted', text: 'reverted (passes when re-run)' } : r;
  }

  decodeError(data: Hex): { name: string; text: string } {
    if (data.startsWith('0x4e487b71'))
      return {
        name: 'Panic',
        text: `Panic(0x${BigInt('0x' + data.slice(10)).toString(16).padStart(2, '0')})`,
      };
    try {
      const e = decodeErrorResult({ abi: this.allAbi, data });
      return {
        name: e.errorName,
        text: `${e.errorName}(${(e.args ?? []).map(describeArg).join(', ')})`,
      };
    } catch {
      return { name: 'unknown', text: data.slice(0, 10) };
    }
  }

  /** Runs a call without sending it, at the latest block; returns the revert if it would fail. */
  async check(req: TxRequest): Promise<{ ok: true } | { ok: false; name: string; text: string }> {
    const started = performance.now();
    try {
      return await this.checkOnce(req);
    } finally {
      this.time('eth_call (check)', started);
    }
  }

  private time(label: string, started: number) {
    const t = this.timing.get(label) ?? { calls: 0, ms: 0 };
    t.calls++;
    t.ms += performance.now() - started;
    this.timing.set(label, t);
  }

  private async checkOnce(req: TxRequest): Promise<{ ok: true } | { ok: false; name: string; text: string }> {
    const data = encodeFunctionData({
      abi: req.abi,
      functionName: req.functionName,
      args: req.args,
    } as never);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.rpcId,
        method: 'eth_call',
        params: [{ from: req.from, to: req.to, data, gas: '0x2faf080' }, 'latest'],
      }),
    });
    const body = (await response.json()) as {
      result?: Hex;
      error?: { message: string; data?: Hex };
    };
    if (!body.error) return { ok: true };
    if (body.error.data && body.error.data !== '0x')
      return { ok: false, ...this.decodeError(body.error.data) };
    return { ok: false, name: 'reverted', text: body.error.message };
  }

  async read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    return (await this.pub.readContract({
      address,
      abi,
      functionName,
      args,
    } as never)) as T;
  }

  /** Many view calls in one HTTP request (answers matched by id, since anvil runs a batch in any order). */
  async readMany(calls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[]) {
    const first = this.rpcId + 1;
    const body = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: first + i,
      method: 'eth_call',
      params: [
        { to: c.address, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never) },
        'latest',
      ],
    }));
    this.rpcId += calls.length;
    const started = performance.now();
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answers = (await response.json()) as { id: number; result?: Hex; error?: { message: string } }[];
    this.time('eth_call (batch of reads)', started);
    const byId = new Map(answers.map((a) => [a.id, a]));
    return calls.map((c, i) => {
      const a = byId.get(first + i)!;
      if (a.error || !a.result) throw new Error(`${c.functionName}: ${a.error?.message}`);
      return decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: a.result } as never) as unknown;
    });
  }

  private record(label: string, result: TxResult) {
    const key = result.ok ? label : `${label} [reverted]`;
    const list = this.gas.get(key) ?? [];
    list.push(result.gasUsed);
    this.gas.set(key, list);
  }

  async snapshot(): Promise<Hex> {
    return this.rpc<Hex>('evm_snapshot', []);
  }

  async revert(id: Hex, lastTs: number): Promise<void> {
    const ok = await this.rpc<boolean>('evm_revert', [id]);
    if (!ok) throw new Error(`could not revert to ${id}`);
    this.lastTs = lastTs;
  }
}
