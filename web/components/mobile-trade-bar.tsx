'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { useWeb3 } from '@/components/web3-provider';
import { formatCentsE18 } from '@/lib/format';
import { dayLabel, strikeLabel, useMarkets } from '@/lib/markets';
import { ticketState } from '@/lib/ticket-state';

/** The id OrderColumn puts on its outer element. */
const ORDER_COLUMN_ID = 'order-ticket';

const E18 = 10n ** 18n;

/**
 * Below `lg` the order ticket sits under the market list and the chart, a
 * long scroll away. While it is out of view this bar keeps the selected
 * market's YES and NO prices at the foot of the screen, with a button
 * that scrolls to the ticket; it hides once the ticket is in view, and
 * never trades itself.
 */
export function MobileTradeBar() {
  const { selected, now } = useMarkets();
  const { market, snapshot } = useWeb3();
  const [ticketInView, setTicketInView] = React.useState(true);

  React.useEffect(() => {
    const column = document.getElementById(ORDER_COLUMN_ID);
    if (!column) return;
    const observer = new IntersectionObserver(([entry]) => {
      setTicketInView(entry.isIntersecting);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  if (!selected || ticketInView) return null;

  const { ready } = ticketState(snapshot, market, Math.floor(now / 1000));
  const toTicket = () => {
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    document.getElementById(ORDER_COLUMN_ID)?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <>
      {/* Room at the foot of the page, so the bar never covers its end. */}
      <div
        aria-hidden="true"
        className="h-[calc(3.5rem_+_max(0.5rem,env(safe-area-inset-bottom)))] lg:hidden"
      />
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pt-2 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] lg:hidden">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 font-mono text-xs">
            <div className="truncate text-muted-foreground">
              Strike {strikeLabel(selected)} · {dayLabel(selected.dayKey)}
            </div>
            <div className="mt-0.5 flex gap-3 tabular-nums">
              <span className="text-up">
                YES {ready ? formatCentsE18(snapshot.priceE18) : '—'}
              </span>
              <span className="text-down">
                NO {ready ? formatCentsE18(E18 - snapshot.priceE18) : '—'}
              </span>
            </div>
          </div>
          <Button
            className="h-10 shrink-0 rounded-[2px] bg-primary px-5 text-primary-foreground shadow-none hover:bg-primary/85"
            onClick={toTicket}
          >
            Trade
          </Button>
        </div>
      </div>
    </>
  );
}
