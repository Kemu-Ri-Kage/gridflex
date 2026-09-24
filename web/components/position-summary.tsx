'use client';

import { QUIET_BUTTON, Ticker } from '@/components/terminal-ui';
import { formatToken } from '@/lib/format';
import {
  pairsLabel,
  paysLabel,
  type PositionSummary as Summary,
} from '@/lib/position-summary';
import { cn } from '@/lib/utils';

/**
 * The wallet's position on the selected market, as the ticket states it:
 * what each part pays, and the only ways out. Matched YES + NO pairs are
 * netted, so a wallet holding both sides reads as pairs plus one net side.
 * The net side leads as one large figure that ticks when a trade moves it.
 * Labels and numbers only (design-brief.md §5).
 */
export function PositionSummary({
  summary,
  strike,
  tradingOpen,
  onSwitch,
}: {
  summary: Summary;
  strike: string;
  tradingOpen: boolean;
  onSwitch: () => void;
}) {
  const { pairs, net } = summary;
  // With YES equal to NO there is no net side; the pairs lead instead.
  const lead = net
    ? {
        amount: net.amount,
        unit: net.side,
        detail: paysLabel(net.side, net.amount, strike),
        tone: net.side === 'YES' ? 'text-up' : 'text-down',
      }
    : {
        amount: pairs,
        unit: 'YES + NO',
        detail: pairsLabel(pairs),
        tone: 'text-foreground',
      };

  return (
    <div className="space-y-3 rounded-[2px] border border-border bg-background p-3 text-xs">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Your position
      </div>
      <div>
        <div
          className={cn(
            'flex items-baseline gap-2 font-mono text-2xl leading-none tabular-nums',
            lead.tone,
          )}
        >
          <Ticker numeric={Number(lead.amount)} value={formatToken(lead.amount)} />
          <span className="text-sm">{lead.unit}</span>
        </div>
        <div className="mt-2 font-mono text-muted-foreground">
          {lead.detail}
        </div>
      </div>
      {net && pairs > 0n && (
        <div className="border-t border-border pt-2 font-mono">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Matched pairs</span>
            <span className="text-foreground tabular-nums">
              {formatToken(pairs)}
            </span>
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {pairsLabel(pairs)}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <span className="font-mono text-muted-foreground">Exits</span>
        <span className="flex flex-wrap items-center gap-2 font-mono text-foreground">
          {tradingOpen && (
            <>
              <button
                className={cn(QUIET_BUTTON, 'h-7 px-2.5')}
                onClick={onSwitch}
                type="button"
              >
                Switch side
              </button>
              <span className="text-muted-foreground">·</span>
            </>
          )}
          Hold to settlement, redeem
        </span>
      </div>
    </div>
  );
}
