/**
 * Whether a failed wallet request looks like the wallet's own RPC endpoint
 * for X Layer failing, as opposed to the user declining or the contract
 * reverting. The wallet sends transactions through the RPC it has saved for
 * chain 1952, which this site can't see or change; this only decides when
 * to offer the connection help (components/connection-help.tsx).
 *
 * Errors arrive as viem errors wrapping the wallet's EIP-1193 error, so the
 * whole `cause` chain is checked. One trap: for a contract write, viem
 * reads code -32603 as a revert and rewraps it as ContractFunctionRevertedError
 * ("reverted with the following reason: Internal JSON-RPC error."),
 * dropping the wallet's error. A real revert differs: it carries revert
 * data (`raw`) or the node's "execution reverted" text. Kept free of
 * imports for the node tests.
 */

/** EIP-1193 / JSON-RPC codes a wallet uses when its RPC endpoint fails. */
const RPC_FAILURE_CODES = new Set([
  -32603, // Internal JSON-RPC error (MetaMask's code for a failed upstream call)
  -32002, // Resource unavailable
  -32005, // Limit exceeded / too many requests
]);

/** The user said no, or the chain did answer: not an endpoint problem. */
const NOT_RPC_FAILURE =
  /user (rejected|denied)|rejected the request|execution reverted|insufficient funds|nonce too low|gas required exceeds/i;

const RPC_FAILURE_MESSAGE =
  /internal json-rpc error|failed to fetch|fetch failed|network ?error|could not fetch|rpc endpoint|endpoint returned|too many errors|timed? ?out|timeout|bad gateway|service unavailable|econnrefused|\b50[234]\b/i;

/** viem's decoded revert data: present only when the contract really reverted. */
function hasRevertData(record: Record<string, unknown>): boolean {
  return typeof record.raw === 'string' && record.raw.length > 2;
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error;
  while (
    current &&
    typeof current === 'object' &&
    chain.length < 10 &&
    !chain.includes(current as Record<string, unknown>)
  ) {
    const record = current as Record<string, unknown>;
    chain.push(record);
    const data = record.data;
    if (data && typeof data === 'object' && 'message' in data) {
      chain.push(data as Record<string, unknown>);
    }
    current = record.cause;
  }
  return chain;
}

function text(record: Record<string, unknown>): string {
  return ['message', 'shortMessage', 'details', 'reason']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

export function isWalletRpcFailure(error: unknown): boolean {
  const chain = errorChain(error);
  if (chain.some((record) => Number(record.code) === 4001)) return false;
  const messages = chain.map(text).join(' ');
  if (NOT_RPC_FAILURE.test(messages) || chain.some(hasRevertData)) return false;
  return (
    chain.some((record) => RPC_FAILURE_CODES.has(Number(record.code))) ||
    RPC_FAILURE_MESSAGE.test(messages)
  );
}
