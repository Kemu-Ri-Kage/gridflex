'use client';

import { Button } from '@/components/ui/button';
import { formatToken } from '@/lib/format';
import {
  pairsLabel,
  paysLabel,
  type PositionSummary as Summary,
} from '@/lib/position-summary';

/**
 * The wallet's position on the selected market, as the ticket states it:
 * what each part pays, and the only ways out. Matched YES + NO pairs are
 * netted, so a wallet holding both sides reads as pairs plus one net side.
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
  const rows: {
    label: string;
    value: string;
    detail: string;
    tone?: string;
  }[] = [];
  if (pairs > 0n) {
    rows.push({
      label: 'Matched pairs',
      value: formatToken(pairs),
      detail: pairsLabel(pairs),
    });
  }
  if (net) {
    rows.push({
      label: pairs > 0n ? 'Net' : 'Position',
      value: `${formatToken(net.amount)} ${net.side}`,
      detail: paysLabel(net.side, net.amount, strike),
      tone: net.side === 'YES' ? 'text-up' : 'text-down',
    });
  }

  return (
    <div className="space-y-2 rounded-[2px] border border-border bg-background p-3 text-xs">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{row.label}</span>
            <span
              className={`font-mono tabular-nums ${row.tone ?? 'text-foreground'}`}
            >
              {row.value}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-muted-foreground">
            {row.detail}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground">Exits</span>
        <span className="flex flex-wrap items-center gap-2 font-mono text-foreground">
          {tradingOpen && (
            <>
              <Button
                className="h-7 rounded-[2px] px-2.5 font-sans shadow-none"
                onClick={onSwitch}
                size="sm"
                variant="outline"
              >
                Switch side
              </Button>
              <span className="text-muted-foreground">·</span>
            </>
          )}
          Hold to settlement, redeem
        </span>
      </div>
    </div>
  );
}
