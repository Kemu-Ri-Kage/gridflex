import { createPublicClient, getAddress, keccak256, toBytes, type Hash } from 'viem';

import { binaryMarketAbi, gridOracleAbi, xLayerTestnet, xLayerTransport } from '@/lib/contracts';
import type { CommittedRecord } from '@/lib/feed-data';
import { PRICE_METRIC_ID, readBoard, type MarketSnapshot } from '@/lib/price-api';
import type { DemoDayEvidence, PublicAddresses } from '@/lib/site-data';
import addressesJson from '@/public/data/addresses.json';
import recordsJson from '@/public/data/ERCOT_HBNORTH_DA_AVG.json';
import evidenceJson from '@/public/data/evidence-demo-day.json';

/**
 * The API's inputs. The committed price data is imported at build time,
 * the same files /data/ serves, so every deploy answers with the data it
 * shipped with; market and oracle state is read from X Layer per request.
 */

export const records = recordsJson as CommittedRecord[];
export const evidence = evidenceJson as DemoDayEvidence;
const addresses = addressesJson as PublicAddresses;
export const oracleAddress = getAddress(addresses.GridOracle);

const client = createPublicClient({ chain: xLayerTestnet, transport: xLayerTransport() });

export function readOracle(dayKey: number): Promise<unknown> {
  return client.readContract({
    address: oracleAddress,
    abi: gridOracleAbi,
    functionName: 'getReading',
    args: [keccak256(toBytes(PRICE_METRIC_ID)), dayKey],
  });
}

const listed = (addresses.markets ?? []).map((m) => ({
  market: getAddress(m.market),
  createTxHash: m.createTxHash as Hash,
}));

// /markets and /hedge-quote are usually called back to back; one board
// read serves both for a few seconds. Only a finished read is kept: a
// Worker must not share a pending promise between requests.
const BOARD_TTL_MS = 5_000;
let board: { at: number; value: MarketSnapshot[] } | null = null;

export async function readMarkets(): Promise<MarketSnapshot[]> {
  if (board && Date.now() - board.at < BOARD_TTL_MS) return board.value;
  const value = await readBoard(
    (contracts) => client.multicall({ contracts, allowFailure: false }),
    binaryMarketAbi,
    listed,
  );
  board = { at: Date.now(), value };
  return value;
}
