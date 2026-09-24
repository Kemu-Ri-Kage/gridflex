import { formatToken } from './format.ts';

/**
 * The wallet prompts one buy can raise, in order, worded to match what the
 * wallet shows (design-brief.md §5: labels, plain words). A buy mints a
 * complete YES + NO set and swaps the unwanted side into the wanted one, so
 * the wallet shows the other side's tokens mid-buy; the mint step says so.
 * Kept free of React for the node tests.
 */

type Side = 'YES' | 'NO';

export type BuyStepKey = 'approveCollateral' | 'mint' | 'approveSwap' | 'swap';

export type BuyStepStatus = 'upcoming' | 'current' | 'done' | 'skipped';

export interface BuyStep {
  key: BuyStepKey;
  label: string;
  /** Shown under the label; only the mint step has one. */
  note?: string;
  /** Sent only when the allowance doesn't already cover it. */
  approval: boolean;
}

export interface BuyProgress {
  steps: BuyStep[];
  status: Record<BuyStepKey, BuyStepStatus>;
}

/** The four steps of buying `side` with `amountIn` mUSDT; `swapOut` from the quote. */
export function buySteps(
  side: Side,
  amountIn: bigint,
  swapOut?: bigint,
): BuyStep[] {
  const other: Side = side === 'YES' ? 'NO' : 'YES';
  const amount = formatToken(amountIn);
  return [
    {
      key: 'approveCollateral',
      label: `Approve ${amount} mUSDT`,
      approval: true,
    },
    {
      key: 'mint',
      label: `Mint ${amount} YES + ${amount} NO`,
      note: `Your wallet shows ${other} tokens here; that's expected.`,
      approval: false,
    },
    {
      key: 'approveSwap',
      label: `Approve ${amount} ${other} for the swap`,
      approval: true,
    },
    {
      key: 'swap',
      label:
        swapOut === undefined
          ? `Swap ${amount} ${other} into ${side}`
          : `Swap ${amount} ${other} for ~${formatToken(swapOut)} ${side}`,
      approval: false,
    },
  ];
}

export function startBuyProgress(steps: BuyStep[]): BuyProgress {
  return {
    steps,
    status: {
      approveCollateral: 'upcoming',
      mint: 'upcoming',
      approveSwap: 'upcoming',
      swap: 'upcoming',
    },
  };
}

/**
 * Set `key`'s status. Making a step current marks the one before it done,
 * so the list never shows two steps waiting at once.
 */
export function markBuyStep(
  progress: BuyProgress,
  key: BuyStepKey,
  status: BuyStepStatus,
): BuyProgress {
  const next = { ...progress.status };
  if (status === 'current') {
    for (const step of progress.steps) {
      if (next[step.key] === 'current') next[step.key] = 'done';
    }
  }
  next[key] = status;
  return { ...progress, status: next };
}

/** "Step 2 of 4 · Mint 100 YES + 100 NO": the spinner's words for `key`. */
export function buyStepLabel(steps: BuyStep[], key: BuyStepKey): string {
  const index = steps.findIndex((step) => step.key === key);
  return `Step ${index + 1} of ${steps.length} · ${steps[index].label}`;
}
