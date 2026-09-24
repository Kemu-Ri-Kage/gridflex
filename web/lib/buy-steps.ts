import { approvalTarget } from './allowance.ts';
import { formatToken } from './format.ts';

/**
 * The wallet prompts one buy can raise, in order, worded to match what the
 * wallet shows (design-brief.md §5: labels, plain words). A buy mints a
 * complete YES + NO set and swaps the unwanted side into the wanted one, so
 * the wallet shows the other side's tokens mid-buy; the mint step says so.
 * An approval the allowance already covers is left out (lib/allowance.ts),
 * so the list is the prompts this particular buy will raise.
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

/** Which approvals a buy still needs; both when the allowances are unknown. */
export interface ApprovalNeeds {
  collateral: boolean;
  swap: boolean;
}

const ALL_APPROVALS: ApprovalNeeds = { collateral: true, swap: true };

/**
 * The steps of buying `side` with `amountIn` mUSDT; `swapOut` from the
 * quote. Four on a first buy on a market, two once both approvals are in.
 */
export function buySteps(
  side: Side,
  amountIn: bigint,
  swapOut?: bigint,
  needs: ApprovalNeeds = ALL_APPROVALS,
): BuyStep[] {
  const other: Side = side === 'YES' ? 'NO' : 'YES';
  const amount = formatToken(amountIn);
  const steps: BuyStep[] = [];
  if (needs.collateral) {
    steps.push({
      key: 'approveCollateral',
      label: `Approve ${formatToken(approvalTarget('collateral', amountIn))} mUSDT for this market`,
      approval: true,
    });
  }
  steps.push({
    key: 'mint',
    label: `Mint ${amount} YES + ${amount} NO`,
    note: `Your wallet shows ${other} tokens here; that's expected.`,
    approval: false,
  });
  if (needs.swap) {
    steps.push({
      key: 'approveSwap',
      label: `Approve ${other} for this market (one time)`,
      approval: true,
    });
  }
  steps.push({
    key: 'swap',
    label:
      swapOut === undefined
        ? `Swap ${amount} ${other} into ${side}`
        : `Swap ${amount} ${other} for ~${formatToken(swapOut)} ${side}`,
    approval: false,
  });
  return steps;
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

/**
 * "Step 2 of 4 · Mint 100 YES + 100 NO": the spinner's words for `key`.
 * An approval left out of the list but needed after all (an allowance
 * revoked since the list was built) is named without a number.
 */
export function buyStepLabel(steps: BuyStep[], key: BuyStepKey): string {
  const index = steps.findIndex((step) => step.key === key);
  if (index === -1) {
    return key === 'approveCollateral'
      ? 'Approving mUSDT'
      : 'Approving the swap';
  }
  return `Step ${index + 1} of ${steps.length} · ${steps[index].label}`;
}
