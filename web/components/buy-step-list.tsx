'use client';

import { Loader2 } from 'lucide-react';

import type { BuyProgress, BuyStep } from '@/lib/buy-steps';
import { cn } from '@/lib/utils';

/**
 * A check mark drawn once when it mounts (terminal-draw in globals.css,
 * design-brief.md §13): a finished wallet prompt, a confirmed receipt.
 * The path is shorter than the 24-unit dash the animation draws.
 */
export function DrawnCheck({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path className="terminal-draw" d="M3 8.5l3.25 3.25L13 5" />
    </svg>
  );
}

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
    <div className="space-y-2 text-xs">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Wallet prompts
      </div>
      <ol className="space-y-1.5">
        {steps.map((step, i) => {
          const status = progress?.status[step.key] ?? 'upcoming';
          return (
            <li className="flex gap-2.5" key={step.key}>
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center rounded-[2px] border font-mono text-[10px] tabular-nums transition-colors duration-150',
                  status === 'current'
                    ? 'border-foreground text-foreground'
                    : status === 'done'
                      ? 'border-up/50 text-up'
                      : 'border-border text-muted-foreground',
                )}
              >
                {status === 'done' ? (
                  <DrawnCheck className="size-3" />
                ) : status === 'current' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="min-w-0 leading-[18px]">
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
