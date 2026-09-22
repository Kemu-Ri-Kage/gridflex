# `trade-panel.tsx` — proposed copy changes (for David)

These are proposals, not edits: `web/components/trade-panel.tsx` and
`web/components/web3-provider.tsx` are David's files (design-brief.md §12)
and haven't been touched. Each change brings the order ticket in line with
the design brief's §5: the display dictionary (the public site sells one
product, "Will Texas power cost more than $X on [date]?") and the copy
budget (on `/trade`, every string is a label or a number; only empty states
and errors may be sentences, one short sentence each). Line numbers are for
the files as they stand on `feat/terminal-integration`.

Display words only — `mintSet`, `swap`, `BinaryMarket` and the metric IDs
stay exactly as they are in code and on chain.

## The dictionary change: "Buy YES" and "Buy NO"

§5 replaces "mint set" and "swap" with **Buy YES** and **Buy NO**. Today
the ticket exposes the mechanism as two steps — mint a YES + NO set, then
swap toward a side. The proposal is two buttons, **Buy YES** and **Buy
NO**, each taking one mUSDT amount and doing both steps: `mintSet(amount)`,
then swap the unwanted side into the wanted one (the existing slippage
guard and deadline unchanged). That is a behaviour change, not just a
relabel, so it's David's call how to sequence the transactions; the labels
below assume it.

## Copy

| File:line | Current | Proposed | Why |
|---|---|---|---|
| trade-panel 106 | Order ticket | Keep | Label |
| trade-panel 109 | Mint a complete set, then swap into the side you want. | Cut | A sentence on the terminal, and uses two removed terms (§5) |
| trade-panel 115–116 | Demo preview — contract addresses will activate after the X Layer deployment. | `Contracts not configured.` | One short status sentence; the old line promises a deployment that has happened |
| trade-panel 127–128 | `YES 67.3¢` (button) | `YES 67.3¢ · 67% implied` | The implied probability as a label, not a sentence |
| trade-panel 136 | `NO 32.7¢` (button) | `NO 32.7¢ · 33% implied` | Same, for NO |
| trade-panel 145 | Complete set amount | `Amount` | "Set" is a removed term (§5); one amount field serves both buttons |
| trade-panel 191 | Connect wallet to trade | Keep | Button |
| trade-panel 201 | Get 1,000 demo mUSDT | Keep | Button |
| trade-panel 208 | Mint YES + NO set | `Buy YES` / `Buy NO` | §5: "mint set" becomes Buy YES / Buy NO — see above |
| trade-panel 216 | Trade input | Cut | Folded into the one `Amount` field |
| trade-panel 238 | Estimated output | Keep | Label |
| trade-panel 244 | Minimum received | Keep | Label |
| trade-panel 252 | 0.50% slippage protection · 5-minute deadline | Keep | Labels |
| trade-panel 255 | Live quote unavailable. | Keep | One short error sentence |
| trade-panel 267 | Swap towards YES / NO | Cut | Replaced by `Buy YES` / `Buy NO` (§5: "swap" is a removed term) |
| trade-panel 282, 296, 309 | Resolve · Cancel · Redeem | Keep | Buttons; "resolve" and "redeem" are kept terms (§5) |
| trade-panel 337–338 | Cash-settled demo market. No electricity, stock, or physical asset is delivered. Cancelled markets pay 0.5 mUSDT per YES or NO token. | `Cancelled: 0.5 mUSDT per YES or NO` | The first two sentences are a disclaimer and a defensive negation (§5); the page's one disclaimer is the header's `X Layer testnet · MockUSDT`. The cancellation payout becomes a label. |
| web3-provider 366 | Minting YES + NO set | `Buying YES` / `Buying NO` | Pending status shown in the ticket; "mint set" is a removed term |
| web3-provider 420, 446 | Could not prepare the protected swap: … | `Could not prepare the order: …` | Error shown in the ticket; "swap" is a removed term |
| web3-provider 451 | Swapping toward YES / NO | Folded into `Buying YES` / `Buying NO` | Same |
| web3-provider 341 | Minting test collateral | `Getting demo mUSDT` | Matches the button that triggers it |
| web3-provider 481 | Cancelling unresolvable market | `Cancelling` | Status label |

Suggested implementation for the implied-probability label (line 127 and
line 136), rounding to a whole percent the same way the price is shown:

```tsx
YES <span className="ml-auto font-mono">{yesPrice.toFixed(1)}¢ · {Math.round(yesPrice)}% implied</span>
NO <span className="ml-auto font-mono">{noPrice.toFixed(1)}¢ · {Math.round(noPrice)}% implied</span>
```

## Two behaviour notes (not copy)

- **The ticket's balance grid (lines 165–184) repeats the Positions tab.**
  The bottom panel's Positions tab now shows the connected wallet's mUSDT,
  YES and NO balances for the selected market, read from chain. With the
  ticket visible, the same three numbers appear twice on the page (§5:
  each fact once). Proposal: drop the grid from the ticket.
- **The ticket doesn't know when trading has closed.** `BinaryMarket`
  reverts `mintSet` and `swap` with `TradingClosed()` once
  `block.timestamp >= resolveAfter`, but the trade buttons stay enabled,
  so the user only finds out from a failed transaction. Proposal: read
  `resolveAfter()` alongside the other snapshot fields and disable
  Buy YES / Buy NO from that time on (Resolve/Cancel/Redeem stay as they
  are).

## How the page uses the ticket now

`web/components/order-column.tsx` (not David's file) renders the ticket
only when `NEXT_PUBLIC_DEMO_MARKET_ADDRESS` is the market selected in the
market list — the ticket trades that one address, so it must never sit
beside a different market's name. The market list shows only Texas power
price markets (§5), so the configured market must be one of those for the
ticket to appear. Above it, a compact settlement summary shows the
selected market's chain state. Nothing in `trade-panel.tsx` needed to
change for that.
