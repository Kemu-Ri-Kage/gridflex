'use client';

import { Check, Loader2 } from 'lucide-react';

import type { BuyProgress, BuyStep } from '@/lib/buy-steps';

/**
 * The wallet prompts a buy raises, in order (lib/buy-steps.ts). Before the
 * buy it previews them, leaving out approvals already in place; during the
 * buy it marks each one done, skipped or waiting, so the step the screen
 * names is always the prompt the wallet is showing.
 */
export function BuyStepList({
  steps,
  progress,
}: {
  steps: BuyStep[];
  progress?: BuyProgress;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="text-muted-foreground">Wallet prompts</div>
      <ol className="space-y-1.5">
        {steps.map((step, i) => {
          const status = progress?.status[step.key] ?? 'upcoming';
          return (
            <li className="flex gap-2" key={step.key}>
              <span className="flex w-4 shrink-0 justify-center pt-0.5 font-mono text-muted-foreground">
                {status === 'done' ? (
                  <Check className="size-3.5 text-up" />
                ) : status === 'current' ? (
                  <Loader2 className="size-3.5 animate-spin text-foreground" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="min-w-0">
                <span
                  className={
                    status === 'current'
                      ? 'font-semibold text-foreground'
                      : status === 'upcoming' && progress
                        ? 'text-muted-foreground'
                        : status === 'skipped'
                          ? 'text-muted-foreground line-through'
                          : 'text-foreground'
                  }
                >
                  {step.label}
                </span>
                {status === 'skipped' && (
                  <span className="text-muted-foreground">
                    {' '}
                    · already approved
                  </span>
                )}
                {step.note && (status === 'current' || !progress) && (
                  <span className="block text-muted-foreground">
                    {step.note}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
