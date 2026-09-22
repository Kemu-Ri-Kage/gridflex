# `trade-panel.tsx` — proposed copy changes (for David)

These are proposals, not edits: `web/components/trade-panel.tsx` is David's
file (design-brief.md §12) and hasn't been touched. Each change brings the
order ticket in line with the design brief's §5 copy budget — on `/trade`,
every string is a label or a number, and only empty states and errors may
be sentences (one short sentence each). Line numbers are for the file as it
stands on `feat/terminal-integration`.

## Copy

| Line | Current | Proposed | Why |
|---|---|---|---|
| 106 | Order ticket | Keep | Label |
| 109 | Mint a complete set, then swap into the side you want. | Cut | A sentence on the terminal; the buttons below already say it |
| 115–116 | Demo preview — contract addresses will activate after the X Layer deployment. | `Contracts not configured.` | One short status sentence; the old line promises a deployment that has happened |
| 127–128 | `YES 67.3¢` (button) | `YES 67.3¢ · 67% implied` | The implied probability as a label, not the sentence "the market prices a 67% chance" |
| 136 | `NO 32.7¢` (button) | `NO 32.7¢ · 33% implied` | Same, for NO |
| 145 | Complete set amount | Keep | Label |
| 191 | Connect wallet to trade | Keep | Button |
| 201 | Get 1,000 demo mUSDT | Keep | Button |
| 208 | Mint YES + NO set | Keep | Button |
| 216 | Trade input | `Amount` | Shorter label, and matches the mint field |
| 238 | Estimated output | Keep | Label |
| 244 | Minimum received | Keep | Label |
| 252 | 0.50% slippage protection · 5-minute deadline | Keep | Labels |
| 255 | Live quote unavailable. | Keep | One short error sentence |
| 267 | Swap towards YES / NO | `Swap toward YES` / `NO` | "Toward" matches the rest of the app (`Swapping toward …` in web3-provider.tsx) |
| 282, 296, 309 | Resolve · Cancel · Redeem | Keep | Buttons |
| 337–338 | Cash-settled demo market. No electricity, stock, or physical asset is delivered. Cancelled markets pay 0.5 mUSDT per YES or NO token. | `Cancelled: 0.5 mUSDT per YES or NO` | The first two sentences are a disclaimer and a defensive negation (§5); the page's one disclaimer is the header's `X Layer testnet · MockUSDT`. The cancellation payout becomes a label. |

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
  `block.timestamp >= resolveAfter`, but the Mint and Swap buttons stay
  enabled, so the user only finds out from a failed transaction. Proposal:
  read `resolveAfter()` alongside the other snapshot fields and disable
  Mint/Swap from that time on (Resolve/Cancel/Redeem stay as they are).

## How the page uses the ticket now

`web/components/order-column.tsx` (not David's file) renders the ticket
only when `NEXT_PUBLIC_DEMO_MARKET_ADDRESS` is the market selected in the
market list — the ticket trades that one address, so it must never sit
beside a different market's name. Above it, a compact settlement summary
shows the selected market's chain state. Nothing in `trade-panel.tsx`
needed to change for that.
