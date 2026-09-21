import { parseUnits } from 'viem';

export const BASIS_POINTS = 10_000n;
export const DEFAULT_SLIPPAGE_BPS = 50n;
export const DEFAULT_SWAP_TTL_SECONDS = 5n * 60n;
const MAX_UINT64 = (1n << 64n) - 1n;

export function parsePositiveTokenAmount(amount: string, decimals = 6): bigint {
  const normalised = amount.trim();
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(normalised)) {
    throw new Error(
      `Amount must be a positive decimal with no more than ${decimals} decimal places.`,
    );
  }

  const units = parseUnits(normalised, decimals);
  if (units <= 0n) throw new Error('Amount must be greater than zero.');
  return units;
}

export function minimumOutputForQuote(
  quotedOutput: bigint,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): bigint {
  if (quotedOutput <= 0n) throw new Error('Quoted output must be positive.');
  if (slippageBps < 0n || slippageBps >= BASIS_POINTS) {
    throw new Error('Slippage must be between 0 and 9,999 basis points.');
  }

  const minimumOutput =
    (quotedOutput * (BASIS_POINTS - slippageBps)) / BASIS_POINTS;
  if (minimumOutput <= 0n) {
    throw new Error(
      'Minimum output rounds to zero. Increase the trade amount.',
    );
  }
  return minimumOutput;
}

export function swapDeadline(
  blockTimestamp: bigint,
  ttlSeconds = DEFAULT_SWAP_TTL_SECONDS,
): bigint {
  if (blockTimestamp < 0n)
    throw new Error('Block timestamp cannot be negative.');
  if (ttlSeconds <= 0n) throw new Error('Swap lifetime must be positive.');

  const deadline = blockTimestamp + ttlSeconds;
  if (deadline > MAX_UINT64) throw new Error('Swap deadline exceeds uint64.');
  return deadline;
}
