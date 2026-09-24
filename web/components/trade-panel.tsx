'use client';

import * as React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { formatUnits } from 'viem';

import { BuyStepList, DrawnCheck } from '@/components/buy-step-list';
import {
  ConnectionHelp,
  useConnectFrom,
  WalletPromptHint,
} from '@/components/connection-help';
import { PositionSummary } from '@/components/position-summary';
import { SwitchPosition } from '@/components/switch-position';
import {
  CHIP_BUTTON,
  CountTo,
  CtaArrow,
  ctaClass,
  PRESSABLE,
  QUIET_BUTTON,
  TerminalTab,
  TerminalTabsList,
  Ticker,
} from '@/components/terminal-ui';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import {
  useWeb3,
  type BuyQuote,
  type TradeSide,
} from '@/components/web3-provider';
import { needsApproval } from '@/lib/allowance';
import { explorerTxUrl } from '@/lib/explorer';
import {
  formatCentsShort,
  formatSignedToken,
  formatToken,
} from '@/lib/format';
import { buySteps } from '@/lib/buy-steps';
import { fundingState } from '@/lib/funding-state';
import { marketName, strikeLabel, useMarkets } from '@/lib/markets';
import { orderGate, pendingOrderUnits } from '@/lib/pending-order';
import { oppositeBuyWarning, positionSummary } from '@/lib/position-summary';
import { redeemablePayout } from '@/lib/redeemable';
import { payoutFigures, type QuoteFigures } from '@/lib/ticket-figures';
import {
  onTicketPrefill,
  takeTicketPrefill,
  type TicketPrefill,
} from '@/lib/ticket-prefill';
import { ticketState } from '@/lib/ticket-state';
import { parsePositiveTokenAmount } from '@/lib/trade';
import { cn } from '@/lib/utils';

/** OKX's X Layer testnet faucet: paste an address, get 0.2 test OKB. */
const OKB_FAUCET_URL = 'https://web3.okx.com/xlayer/faucet/xlayerfaucet';

/** 1 mUSDT per token, 1e18-scaled: the YES and NO prices sum to it. */
const ONE_E18 = 10n ** 18n;

/** The quick amounts under the amount field, in mUSDT. */
const QUICK_AMOUNTS = [10, 50, 100, 500].map((amount) => ({
  label: String(amount),
  units: BigInt(amount) * 1_000_000n,
}));

/** A label over a figure, as the landing page's contract cards set it. */
const LABEL =
  'font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground';

/**
 * formatToken's output (up to 2 decimals, thousands separators) for a
 * plain number, so CountTo can count the payout between quotes. Module
 * level, because CountTo needs a stable format.
 */
function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function FaucetLink() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-mono text-xs">
      <span className="text-warning">No OKB for gas</span>
      <a
        className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
        href={OKB_FAUCET_URL}
        rel="noreferrer"
        target="_blank"
      >
        Get test OKB <ExternalLink className="size-3" />
      </a>
    </div>
  );
}

function tokenUnits(value: string): bigint | undefined {
  try {
    return parsePositiveTokenAmount(value);
  } catch {
    return undefined;
  }
}

function validTokenAmount(value: string): boolean {
  return tokenUnits(value) !== undefined;
}

/**
 * The order ticket for the selected market (design-brief.md §5: one
 * product, bought as YES or NO; labels and numbers only; §8: side buttons
 * with their prices, the amount, what the buy pays as one figure, then one
 * action in the side's colour). Every number is read from that market's
 * contract through the Web3Provider, which the order column points at the
 * selection. Buy opens a position; Switch position moves it between YES
 * and NO. There is no sell: the contract has no exit into mUSDT before
 * settlement, so the position block names the only exits and warns before
 * a buy that would open the other side.
 */
export function TradePanel() {
  const {
    account,
    configured,
    market,
    snapshot,
    pendingAction,
    error,
    connectError,
    connecting,
    walletRpcFailed,
    buyProgress,
    lastTransaction,
    failedTransaction,
    mintCollateral,
    quoteBuy,
    buy,
    pendingOrder,
    finishPendingOrder,
    keepBothSides,
    resolve,
    cancel,
    redeem,
  } = useWeb3();
  const connectFromTicket = useConnectFrom('ticket');
  const { markets, select, now } = useMarkets();
  const [tab, setTab] = React.useState('buy');
  const [side, setSide] = React.useState<TradeSide>('YES');
  const [amount, setAmount] = React.useState('100');
  const [quoteState, setQuoteState] = React.useState<{
    key: string;
    quote?: BuyQuote;
    unavailable: boolean;
  }>({ key: '', unavailable: false });
  const [heldQuote, setHeldQuote] = React.useState<QuoteFigures>();

  // An order loaded from another panel (lib/ticket-prefill.ts): one waiting
  // for this market when it's selected, or one sent while it is. It fills
  // the Buy tab in; only the viewer's own press of Buy sends anything.
  React.useEffect(() => {
    const load = (prefill: TicketPrefill) => {
      setTab('buy');
      setSide(prefill.side);
      setAmount(prefill.amount);
    };
    const waiting = takeTicketPrefill(market);
    if (waiting) load(waiting);
    return onTicketPrefill(() => {
      const next = takeTicketPrefill(market);
      if (next) load(next);
    });
  }, [market]);

  const ticket = ticketState(snapshot, market, Math.floor(now / 1000));
  const { ready, settled, closed, cancellable, tradingOpen } = ticket;
  const quoteKey = `${market ?? ''}:${side}:${amount}`;

  React.useEffect(() => {
    if (!tradingOpen || !validTokenAmount(amount)) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void quoteBuy(side, amount)
        .then((nextQuote) => {
          if (!cancelled) {
            setQuoteState({
              key: quoteKey,
              quote: nextQuote,
              unavailable: false,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setQuoteState({ key: quoteKey, unavailable: true });
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tradingOpen, quoteKey, quoteBuy, side, amount, snapshot.priceE18]);

  const validAmount = validTokenAmount(amount);
  const units = tokenUnits(amount);
  // The balance is checked again in buy(); here a wallet with no mUSDT or
  // no OKB is told before anything is sent (lib/funding-state.ts).
  const funding = fundingState({
    account,
    balanceAccount: snapshot.balanceAccount,
    balance: snapshot.collateralBalance,
    gasBalance: snapshot.gasBalance,
    units,
    tradingOpen,
  });
  const quote = quoteState.key === quoteKey ? quoteState.quote : undefined;
  const quoteUnavailable =
    quoteState.key === quoteKey && quoteState.unavailable;
  const busy = Boolean(pendingAction);
  // An unfinished order anywhere blocks every new one (lib/pending-order.ts).
  const gate = orderGate(pendingOrder, market);
  const pendingMarket = pendingOrder
    ? markets?.find(
        (m) => m.address.toLowerCase() === pendingOrder.market.toLowerCase(),
      )
    : undefined;
  const canBuy = Boolean(
    account &&
    tradingOpen &&
    validAmount &&
    funding.fundsReady &&
    quote &&
    !busy &&
    !gate.blocked,
  );
  const selectedMarket = markets?.find(
    (m) => m.address.toLowerCase() === (market ?? '').toLowerCase(),
  );
  // What the wallet holds here, netted into pairs and a side; buying the
  // other side adds pairs, it never closes the position.
  const position =
    account && ready && !settled
      ? positionSummary(snapshot.yesBalance, snapshot.noBalance)
      : undefined;
  const oppositeWarning = oppositeBuyWarning(position, side);
  // redeem() reverts with NothingToRedeem when this is zero: after a
  // YES-win redeem, the leftover NO pays nothing.
  const redeemable = redeemablePayout(
    snapshot,
    snapshot.yesBalance,
    snapshot.noBalance,
  );
  const canRedeem = redeemable > 0n;
  // The approvals this buy will prompt for, from the allowances already in
  // place (lib/allowance.ts); both listed until a read for this wallet and
  // market lands.
  const allowancesKnown =
    Boolean(account) &&
    snapshot.balanceAccount === account &&
    snapshot.address === market;
  const swapAllowance =
    side === 'YES' ? snapshot.noAllowance : snapshot.yesAllowance;
  const steps =
    buyProgress?.steps ??
    (units !== undefined
      ? buySteps(
          side,
          units,
          quote?.swapOut,
          allowancesKnown
            ? {
                collateral: needsApproval(snapshot.collateralAllowance, units),
                swap: needsApproval(swapAllowance, units),
              }
            : undefined,
        )
      : undefined);
  const prices = { YES: snapshot.priceE18, NO: ONE_E18 - snapshot.priceE18 };

  // What the buy pays in plain money (lib/ticket-figures.ts), redrawn with
  // every quote.
  const figures = payoutFigures({
    side,
    units,
    totalOut: quote?.totalOut,
    ready,
    tradingOpen,
    quoteUnavailable,
  });
  // The last quote stays mounted, hidden, while the next one loads, so a
  // new amount or side counts from it instead of appearing from nothing.
  // Set during render, React's pattern for state from the previous render.
  if (
    figures.kind === 'quote' &&
    (heldQuote?.receive !== figures.receive || heldQuote.pay !== figures.pay)
  ) {
    setHeldQuote(figures);
  }
  const shownQuote = figures.kind === 'quote' ? figures : heldQuote;
  // Waiting on the quote for a valid amount: the last figure stays on
  // screen, dimmed, and counts to the new one when it lands, rather than
  // blinking to "quoting…" on every chip or side change.
  const quoting =
    figures.kind === 'message' &&
    ready &&
    tradingOpen &&
    units !== undefined &&
    !quoteUnavailable &&
    heldQuote !== undefined;

  // Max buys the whole balance once it is read for this wallet; formatUnits
  // gives a plain decimal the amount parser accepts (no separators).
  const maxUnits =
    account && funding.balance !== undefined && funding.balance > 0n
      ? funding.balance
      : undefined;

  // The Buy button names the step in flight itself, so the status line
  // below only announces it to screen readers then (each fact once).
  const buyPending = busy && !(ready && !tradingOpen);
  const ctaShowsPending = buyPending && Boolean(account) && tab === 'buy';

  const connectButton = !account && (
    <div className="grid gap-2">
      <button
        className={cn(
          ctaClass('neutral'),
          connecting && 'disabled:cursor-progress disabled:opacity-100',
        )}
        disabled={connecting}
        onClick={connectFromTicket}
        type="button"
      >
        {connecting ? (
          'Check your wallet…'
        ) : (
          <>
            Connect wallet to trade
            <CtaArrow />
          </>
        )}
      </button>
      <WalletPromptHint origin="ticket" />
    </div>
  );

  return (
    <section
      aria-label="Order ticket"
      className="sticky top-3 rounded-[2px] border border-border bg-card"
    >
      <Tabs
        className="gap-0"
        onValueChange={(value) => setTab(String(value))}
        value={tab}
      >
        <TerminalTabsList className="px-4">
          <TerminalTab value="buy">Buy</TerminalTab>
          <TerminalTab value="switch">Switch position</TerminalTab>
        </TerminalTabsList>

        <div className="space-y-4 p-4">
          {/* First in the ticket: until the wallet's RPC answers, nothing
              below can be sent. */}
          {walletRpcFailed && <ConnectionHelp />}

          {!configured && (
            <div className="border-l-2 border-warning bg-warning/5 py-2 pr-3 pl-3 text-xs leading-5 text-warning">
              Contracts not configured.
            </div>
          )}

          {pendingOrder && (
            <div className="space-y-3 border-l-2 border-warning bg-warning/5 py-2.5 pr-3 pl-3 text-xs">
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-warning">
                  Unfinished order
                </div>
                {gate.elsewhere && (
                  <div className="mt-1.5 text-foreground">
                    {pendingMarket
                      ? marketName(pendingMarket)
                      : `${pendingOrder.market.slice(0, 6)}…${pendingOrder.market.slice(-4)}`}
                  </div>
                )}
                <div className="mt-1 font-mono text-muted-foreground">
                  Buy {pendingOrder.side} ·{' '}
                  {formatToken(pendingOrderUnits(pendingOrder))} mUSDT · YES +
                  NO held
                </div>
              </div>
              <div className="grid gap-2">
                {gate.elsewhere && pendingMarket && (
                  <button
                    className={cn(QUIET_BUTTON, 'w-full text-foreground')}
                    onClick={() => select(pendingMarket.address)}
                    type="button"
                  >
                    Go to market
                  </button>
                )}
                {!gate.elsewhere && (
                  <button
                    className={cn(
                      QUIET_BUTTON,
                      'h-auto w-full min-w-0 flex-col items-start gap-0.5 py-2 text-left text-foreground',
                    )}
                    disabled={busy}
                    onClick={() => void finishPendingOrder()}
                    type="button"
                  >
                    <span>Finish order</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      All into {pendingOrder.side}
                    </span>
                  </button>
                )}
                {(!gate.elsewhere || !pendingMarket) && (
                  <button
                    className={cn(
                      QUIET_BUTTON,
                      'h-auto w-full min-w-0 flex-col items-start gap-0.5 py-2 text-left text-foreground',
                    )}
                    disabled={busy}
                    onClick={keepBothSides}
                    type="button"
                  >
                    <span>Keep both sides</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      1 mUSDT per pair after resolve, either outcome
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}

          <TabsContent className="space-y-4" value="buy">
            {funding.needsMusdt && (
              <div className="space-y-3 rounded-[2px] border border-border bg-background p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={LABEL}>Balance</span>
                  <span className="font-mono text-xl leading-none text-foreground tabular-nums">
                    0 mUSDT
                  </span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Free test dollars for trying a trade.
                </p>
                {funding.needsGas && <FaucetLink />}
                <button
                  className={ctaClass('neutral')}
                  disabled={!configured || busy || funding.needsGas}
                  onClick={() => void mintCollateral()}
                  type="button"
                >
                  Get 1,000 test mUSDT
                  <CtaArrow />
                </button>
              </div>
            )}
            {/* Visible but dimmed until there is mUSDT to buy with. */}
            <div
              className={cn(
                'space-y-4 transition-opacity duration-150',
                funding.needsMusdt && 'opacity-60',
              )}
            >
              {/* The side buttons carry their own prices, as an exchange's
                  order buttons do (design-brief.md §8). */}
              <div className="grid grid-cols-2 gap-2">
                {(['YES', 'NO'] as const).map((option) => (
                  <button
                    aria-pressed={side === option}
                    className={cn(
                      'flex h-16 min-w-0 flex-col items-start justify-between rounded-[2px] border px-3 py-2.5 text-left',
                      PRESSABLE,
                      side !== option
                        ? 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground'
                        : option === 'YES'
                          ? 'border-up bg-up/10 text-up'
                          : 'border-down bg-down/10 text-down',
                    )}
                    key={option}
                    onClick={() => setSide(option)}
                    type="button"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
                      {option}
                    </span>
                    <span className="font-mono text-2xl leading-none tabular-nums">
                      {ready ? (
                        <Ticker
                          numeric={Number(prices[option])}
                          value={formatCentsShort(prices[option])}
                        />
                      ) : (
                        '—'
                      )}
                    </span>
                  </button>
                ))}
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <label className={LABEL} htmlFor="order-amount">
                    Amount
                  </label>
                  {account && !funding.needsMusdt && (
                    <span className="font-mono text-xs text-muted-foreground">
                      Balance{' '}
                      <span className="text-foreground tabular-nums">
                        {funding.balance === undefined
                          ? '—'
                          : `${formatToken(funding.balance)} mUSDT`}
                      </span>
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Input
                    aria-invalid={!validAmount}
                    className="h-12 rounded-[2px] border-border bg-background pr-20 font-mono text-xl text-foreground tabular-nums shadow-none focus-visible:border-foreground/50 focus-visible:ring-0 aria-invalid:ring-0 md:text-xl"
                    disabled={!tradingOpen}
                    id="order-amount"
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setAmount(event.target.value)}
                    step="0.01"
                    type="number"
                    value={amount}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                    mUSDT
                  </span>
                </div>
                <div className="mt-2 flex gap-1.5">
                  {QUICK_AMOUNTS.map((quick) => (
                    <button
                      aria-pressed={units === quick.units}
                      className={cn(CHIP_BUTTON, 'flex-1')}
                      disabled={!tradingOpen}
                      key={quick.label}
                      onClick={() => setAmount(quick.label)}
                      type="button"
                    >
                      {quick.label}
                    </button>
                  ))}
                  {maxUnits !== undefined && (
                    <button
                      aria-pressed={units === maxUnits}
                      className={cn(CHIP_BUTTON, 'flex-1')}
                      disabled={!tradingOpen}
                      onClick={() => setAmount(formatUnits(maxUnits, 6))}
                      type="button"
                    >
                      Max
                    </button>
                  )}
                </div>
                {funding.needsGas && !funding.needsMusdt && (
                  <div className="mt-2">
                    <FaucetLink />
                  </div>
                )}
                {funding.shortfall && !funding.needsGas && (
                  <p className="mt-2 text-xs leading-5 text-warning">
                    {funding.shortfall}{' '}
                    <button
                      className="font-semibold text-foreground underline underline-offset-4 disabled:opacity-50"
                      disabled={!configured || busy}
                      onClick={() => void mintCollateral()}
                      type="button"
                    >
                      Get 1,000 test mUSDT
                    </button>
                  </p>
                )}
              </div>

              {/* One figure: what the buy returns if its side wins. The
                  quoted figure keeps its place while a message shows, so
                  the block never changes height between states. */}
              <div className="border-t border-border pt-4">
                <div className={LABEL}>To win</div>
                <div className="relative mt-2">
                  <div
                    className={cn(
                      'transition-opacity duration-150',
                      figures.kind === 'quote'
                        ? undefined
                        : quoting
                          ? 'opacity-50'
                          : 'invisible',
                    )}
                  >
                    <div className="flex items-baseline gap-2.5 font-mono">
                      <CountTo
                        className={cn(
                          'text-3xl leading-none',
                          side === 'YES' ? 'text-up' : 'text-down',
                        )}
                        format={formatMoney}
                        value={
                          shownQuote ? Number(shownQuote.receive) / 1e6 : 0
                        }
                      />
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {shownQuote ? formatSignedToken(shownQuote.gain) : ''}
                      </span>
                    </div>
                    <div className="mt-2 font-mono text-xs text-muted-foreground tabular-nums">
                      Pay {shownQuote ? formatToken(shownQuote.pay) : '—'}{' '}
                      mUSDT · max loss{' '}
                      {shownQuote ? formatToken(shownQuote.pay) : '—'} mUSDT
                    </div>
                  </div>
                  {figures.kind === 'message' && !quoting && (
                    <div
                      className={cn(
                        'absolute inset-x-0 top-0 flex h-[30px] items-center font-mono text-muted-foreground',
                        ready ? 'text-sm' : 'text-3xl leading-none',
                      )}
                    >
                      {figures.text}
                    </div>
                  )}
                </div>
              </div>

              {account && tradingOpen && oppositeWarning && !buyProgress && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-warning bg-warning/5 py-2 pr-2 pl-3">
                  <p className="text-xs leading-5 text-warning">
                    {oppositeWarning}
                  </p>
                  <button
                    className={cn(QUIET_BUTTON, 'h-8')}
                    onClick={() => setTab('switch')}
                    type="button"
                  >
                    Switch to change sides
                  </button>
                </div>
              )}

              {account ? (
                <button
                  className={cn(
                    ctaClass(side === 'YES' ? 'up' : 'down'),
                    buyPending &&
                      'disabled:cursor-progress disabled:opacity-100',
                  )}
                  disabled={!canBuy}
                  onClick={() => void buy(side, amount)}
                  type="button"
                >
                  {ready && !tradingOpen ? (
                    'Trading closed'
                  ) : buyPending ? (
                    <>
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                      <span className="min-w-0 truncate">
                        {pendingAction}…
                      </span>
                    </>
                  ) : (
                    <>
                      {units === undefined
                        ? `Buy ${side}`
                        : `Buy ${side} · ${formatToken(units)} mUSDT`}
                      <CtaArrow />
                    </>
                  )}
                </button>
              ) : (
                connectButton
              )}

              <div className="space-y-1.5 font-mono text-xs">
                <dl className="space-y-1">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">You get</dt>
                    <dd className="text-foreground tabular-nums">
                      {quote ? `${formatToken(quote.totalOut)} ${side}` : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Minimum</dt>
                    <dd className="text-foreground tabular-nums">
                      {quote
                        ? `${formatToken(quote.minimumTotalOut)} ${side}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
                <div className="text-[11px] text-muted-foreground">
                  Slippage 0.5% · 5-min deadline
                  {quoteUnavailable && (
                    <span className="ml-2 text-warning">
                      Live quote unavailable.
                    </span>
                  )}
                </div>
              </div>

              {account && tradingOpen && steps && (
                <BuyStepList progress={buyProgress} steps={steps} />
              )}
            </div>
          </TabsContent>
          <TabsContent className="space-y-4" value="switch">
            {/* Keyed by market so a half-typed switch never carries over. */}
            <SwitchPosition
              blocked={gate.blocked}
              key={market}
              state={ticket}
            />
            {connectButton}
          </TabsContent>

          <div aria-live="polite" className="min-h-5 text-xs leading-5">
            {pendingAction && (
              <span
                className={cn(
                  'flex items-center gap-2 text-muted-foreground',
                  ctaShowsPending && 'sr-only',
                )}
              >
                <Loader2 className="size-3.5 animate-spin" /> {pendingAction}…
              </span>
            )}
            {!pendingAction &&
              (error ?? (!account ? connectError : undefined)) && (
                <span className="text-down">
                  {error ?? connectError}
                  {error && failedTransaction && (
                    <a
                      className="ml-1.5 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                      href={explorerTxUrl(failedTransaction)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View on OKLink <ExternalLink className="size-3" />
                    </a>
                  )}
                </span>
              )}
            {/* Keyed by the transaction, so each confirmation pops in with
                its check drawn once. */}
            {!pendingAction && !error && lastTransaction && (
              <div
                className="terminal-pop flex items-center gap-2 font-mono"
                key={lastTransaction}
              >
                <DrawnCheck className="size-3.5 shrink-0 text-up" />
                <span className="text-foreground">Confirmed</span>
                <a
                  className="ml-auto inline-flex items-center gap-1 text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                  href={explorerTxUrl(lastTransaction)}
                  rel="noreferrer"
                  target="_blank"
                >
                  View on OKLink <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </div>

          {position && selectedMarket && (
            <PositionSummary
              onSwitch={() => setTab('switch')}
              strike={strikeLabel(selectedMarket)}
              summary={position}
              tradingOpen={tradingOpen}
            />
          )}

          {/* Only the actions that can run now: redeem once settled with
              something to pay, resolve once trading has closed, cancel
              once the grace period has passed. */}
          {account && (
            <div className="grid gap-2">
              {settled && canRedeem && (
                <button
                  className={ctaClass('up')}
                  disabled={busy}
                  onClick={() => void redeem()}
                  type="button"
                >
                  Redeem {formatToken(redeemable)} mUSDT
                  <CtaArrow />
                </button>
              )}
              {closed && !settled && (
                <button
                  className={cn(QUIET_BUTTON, 'w-full')}
                  disabled={busy}
                  onClick={() => void resolve()}
                  type="button"
                >
                  Resolve market
                </button>
              )}
              {cancellable && !settled && (
                <button
                  className={cn(QUIET_BUTTON, 'w-full')}
                  disabled={busy}
                  onClick={() => void cancel()}
                  type="button"
                >
                  Cancel market
                </button>
              )}
              {/* Secondary once the wallet has mUSDT; with none, the Buy tab
                  leads with it instead. */}
              {!funding.needsMusdt && (
                <button
                  className={cn(QUIET_BUTTON, 'justify-self-start')}
                  disabled={!configured || busy || funding.needsGas}
                  onClick={() => void mintCollateral()}
                  type="button"
                >
                  Get 1,000 test mUSDT
                </button>
              )}
            </div>
          )}

          {/* The cancellation payout is stated as fact only once cancel() has
              run; before settlement it is conditional, and after resolution
              it no longer applies. */}
          {ready && !snapshot.resolved && (
            <div className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">
              {snapshot.cancelled
                ? 'Cancelled · 0.5 mUSDT per YES or NO'
                : 'If cancelled: 0.5 mUSDT per YES or NO'}
            </div>
          )}
        </div>
      </Tabs>
    </section>
  );
}
