'use client';

import * as React from 'react';

import {
  CtaArrow,
  ctaClass,
  prefersReducedMotion,
  SplitBar,
  Ticker,
} from '@/components/terminal-ui';
import { useWeb3 } from '@/components/web3-provider';
import { formatDollarsShort } from '@/lib/format';
import { dayLabel, shownYesPriceE18, strikeLabel, useMarkets } from '@/lib/markets';
import { ticketState } from '@/lib/ticket-state';
import { cn } from '@/lib/utils';

/** The id OrderColumn puts on its outer element. */
const ORDER_COLUMN_ID = 'order-ticket';

const E18 = 10n ** 18n;

/**
 * Below `lg` the order ticket sits under the market list and the chart, a
 * long scroll away. While it is out of view this bar keeps the selected
 * contract's Long and Short prices at the foot of the screen, with a
 * button that scrolls to the ticket; it hides once the ticket is in view,
 * and never trades itself. The prices tick as the pool moves, and Long's
 * share edges the bar's top as the instrument bar's two-colour split. Once
 * trading has closed the button reads View, and a settled market shows
 * what each side paid, as the landing cards do.
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

  const { ready, settled, tradingOpen } = ticketState(snapshot, market, Math.floor(now / 1000));
  const yesPriceE18 = shownYesPriceE18(snapshot);
  const noPriceE18 = E18 - yesPriceE18;
  const toTicket = () => {
    document.getElementById(ORDER_COLUMN_ID)?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <>
      {/* Room at the foot of the page, so the bar never covers its end;
          a settled market's bar is a line taller (labels over prices). */}
      <div
        aria-hidden="true"
        className={cn(
          settled
            ? 'h-[calc(4.5rem_+_max(0.5rem,env(safe-area-inset-bottom)))]'
            : 'h-[calc(3.75rem_+_max(0.5rem,env(safe-area-inset-bottom)))]',
          'lg:hidden',
        )}
      />
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] lg:hidden">
        <SplitBar
          className="absolute inset-x-0 top-0 rounded-none"
          yesPercent={ready && tradingOpen ? Number(yesPriceE18) / 1e16 : undefined}
        />
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1 font-mono">
            <div className="truncate text-xs text-muted-foreground">
              {strikeLabel(selected)} strike · {dayLabel(selected.dayKey)}
            </div>
            {/* "Long paid" / "Short paid" are too wide to sit beside their
                prices at phone width next to the button, so once settled
                each label sits over its price. */}
            <div className="mt-1.5 flex items-baseline gap-5 tabular-nums">
              <span className={settled ? 'flex flex-col gap-1' : 'flex items-baseline gap-1.5'}>
                <span className="text-[11px] leading-none whitespace-nowrap uppercase tracking-[0.14em] text-muted-foreground">
                  {settled ? 'Long paid' : 'Long'}
                </span>
                <Ticker
                  className="text-xl leading-none text-up"
                  numeric={ready ? Number(yesPriceE18) : undefined}
                  value={ready ? formatDollarsShort(yesPriceE18) : '—'}
                />
              </span>
              <span className={settled ? 'flex flex-col gap-1' : 'flex items-baseline gap-1.5'}>
                <span className="text-[11px] leading-none whitespace-nowrap uppercase tracking-[0.14em] text-muted-foreground">
                  {settled ? 'Short paid' : 'Short'}
                </span>
                <Ticker
                  className="text-xl leading-none text-down"
                  numeric={ready ? Number(noPriceE18) : undefined}
                  value={ready ? formatDollarsShort(noPriceE18) : '—'}
                />
              </span>
            </div>
          </div>
          <button
            className={cn(ctaClass('neutral'), 'h-10 w-auto shrink-0 px-5')}
            onClick={toTicket}
            type="button"
          >
            {ready && !tradingOpen ? 'View' : 'Trade'}
            <CtaArrow />
          </button>
        </div>
      </div>
    </>
  );
}
