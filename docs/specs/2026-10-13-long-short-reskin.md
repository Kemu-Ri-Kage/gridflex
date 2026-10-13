# For David, 13 Oct 2026: Long / Short reskin

The founder repositioned the site today as "on-chain energy derivatives, no broker, hedge from a
wallet". Each market is now presented as a cash-settled digital option. The UI shows **Long** for
YES (a digital call: pays 1 mUSDT per contract if the day settles strictly above the strike,
`reading.value > threshold` in `BinaryMarket.resolve()`) and **Short** for NO (a digital put: pays
if it settles at or below). Only the front end's words changed.

## Untouched

- `contracts/`, `data/`, every Python script, `shared/addresses.json`, `web/app/api/**`.
- The machine API (`lib/price-api.ts`) still returns YES/NO field names and the `question` text.
  `marketName()` in `lib/market-facts.ts` is kept for that field only. The site no longer uses it.
- Your files: `web3-provider.tsx`, `wallet-button.tsx` and `market-live-data.tsx` were not
  edited. The founder approved touching `trade-panel.tsx` today; its structure is unchanged.
- No redeploys. Token symbols on chain stay `YES` / `NO`, and the ticket says so in one line:
  "Long is held as the market's YES token in your wallet; Short as its NO token."
- `'YES' | 'NO'` is still each side's identity in code (`TradeSide`, prefill, pending order, ledger).
  Only the labels changed.

## Your two §2 fixes from `2026-10-13-for-david.md` are in

1. `trade-panel.tsx`: `const connectButton = !account && !(ready && !tradingOpen) && (`. A closed
   market no longer shows "Connect wallet to trade", in either the Buy tab or the Switch tab.
2. `trade-panel.tsx`: the ticket prices come from `shownYesPriceE18(snapshot)`. A resolved market
   shows $1.00 / $0.00 instead of the frozen pool's $0.50 / $0.50, and a cancelled one shows
   $0.50 / $0.50.

## What changed in `trade-panel.tsx` (copy only, apart from the two fixes)

- Side buttons: LONG / SHORT with dollar prices (`formatDollarsShort`, "$0.52" instead of "52¢").
- "To win" is now "Max payout". The line under it is now "Premium X mUSDT · Max loss X mUSDT".
- The CTA reads "Buy Long · 100 mUSDT". "You get" and "Minimum" are counted in Long or Short.
- The pending-order box and the cancellation line now use the new words.
- `pendingAction` and `error` strings from your provider pass through `inSideWords()`
  (`lib/sides.ts`) when they are shown. That rewrites the upper-case words YES/NO as
  Long/Short, so "Switching to NO" displays as "Switching to Short". The provider itself is
  unchanged.

## Other files

- New: `web/lib/sides.ts` (`sideLabel`, `inSideWords`).
- `lib/market-facts.ts`: adds `instrumentName` ("Texas Power · $50 strike"), `instrumentCode`
  ("TX-POWER · 14 OCT 2026 · DAILY"), `contractLabel`, `expiryLabel`, and a new `payLine`
  ("Long pays 1 mUSDT per contract if 14 Oct settles above $50.00/MWh. Short pays if it settles at
  or below."). `statusLabel` now returns "Settled · Long", "Settled · Short" and "Awaiting
  settlement". The West–North spread follows the same pattern (`TX-WN-SPREAD`, "+$4 strike").
- `lib/format.ts`: `formatCentsE18` / `formatCentsShort` are replaced by `formatDollarsE18`
  ("$0.500") and `formatDollarsShort` ("$0.50").
- `lib/buy-steps.ts`, `lib/position-summary.ts`, `lib/ticket-figures.ts`, `lib/position.ts`: new
  wording. The approve step still names the token the wallet will show ("Approve the NO token
  (Short) …").
- Components:
  - `instrument-bar` shows the code line, the instrument headline and the payout rule.
    A settled market reads "Settled: Long" or "Settled: Short".
  - `market-panel` is now an options chain: expiry, then strike rows with Long and Short
    columns ("Long paid" / "Short paid" once settled).
  - Also changed: `mobile-trade-bar`, `bottom-panel` (Positions, History), `portfolio`,
    `hedge-calculator`, `settlement-panel` (adds "Contract type" and "Payout rule"),
    `switch-position`, `position-summary`.
  - Landing page: hero, cards, data path, open-terminal. Page metadata in `app/layout.tsx`.
- Tests were updated for the new strings: format, market-facts, buy-steps, position-summary,
  ticket-figures.

## Still yours

- **§1**: wire `OpenInWalletApp` into `wallet-button.tsx` (the two lines in the 13 Oct note).
- **§3**: cash-out (`mergeSet` plus an atomic `sell`, with a redeploy). When it lands, the
  wording that says there is no exit before settlement needs updating too.
- Optional, in your provider: the raw labels still say YES/NO ("Approving YES", "Switching to NO",
  "Minting the YES + NO pair", "Swapping NO into YES"). They display correctly through
  `inSideWords()`, but renaming them at the source would be cleaner.
- `market-live-data.tsx` still exports an unused `MarketProbability`. Nothing renders it. It can
  go whenever you next touch that file.
