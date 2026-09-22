# GRIDFLEX design brief

**This file is the single source of truth for GRIDFLEX's design.** Every future
design prompt — landing page, terminal, a new component, a redesign of an
existing one — points at this file instead of restating taste. If a decision
isn't written down here, it isn't decided; add it here before building it,
don't invent it in the component.

Read alongside this file: `web/app/globals.css` (the tokens — never invent
new ones) and `shared/metrics.md` (unit definitions). The ownership rules
for the integration-sensitive components are in §12.

---

## 1. Principle

GRIDFLEX is a professional trading tool a specialist uses for hours — not a
crypto landing page, not something selling. Every screen is judged by that
standard, including the marketing page: it exists to earn trust in a
technical claim, not to hype a product.

**If an element carries no information, remove it.** Before adding anything
— an icon, a badge, a colour, a card, a line of copy — ask what it tells the
reader that they didn't already know. If the honest answer is "nothing,
it's decoration," it doesn't ship.

---

## 2. Visual patterns — banned

These read as generated, not designed. None of them appear anywhere in
GRIDFLEX, in any component, in any state:

- Gradients
- Glows
- Purple, cyan, neon lime — or any hue outside the palette in §4
- Emoji
- Decorative icons (an icon that isn't a control or a status indicator)
- Icon-in-a-rounded-square logos
- Rounded-xl cards (radius is 2px everywhere — see §4)
- Pill badges (fully rounded `border-radius: 9999px` chips)
- Glassmorphism and backdrop blur
- Stock-style illustrations, hero photography, abstract 3D renders
- Slogan headlines — "The future of…", "Unlock…", "Reimagining…", "Powering
  the next generation of…", or any headline that could be pasted onto an
  unrelated product unchanged

**No default component-library styling used as-is.** Every shadcn or
library component is restyled to this brief — no stock card, hero, button,
or badge look. The design comes from this brief, not from a tool's defaults.

**No logo, anywhere, ever.** `GRIDFLEX` is a text wordmark — mono, bold,
tight tracking, nothing beside it. Not a bolt icon, not a monogram, not a
mark-plus-wordmark lockup. If a design shows an icon next to the wordmark,
that design is wrong.

---

## 3. References — what to take from each, and nothing else

Four references. Each contributes exactly one thing. Copying anything else
from them — palette, copy voice, specific sequences, assets, sound — is out
of scope even if it looks good.

- **daqconsulting.com** → the landing page's *level of craft*, including its
  motion: pure black, large confident typography, numbered editorial
  sections in the form `01 / Section`, restraint, one interactive
  centrepiece per page, a text wordmark, smooth scrolling, sections
  revealing as you scroll, immediate feedback on hover and click, and its
  centrepiece diagram animating between stages. Take the quality of the
  motion and the technique behind it (§14); design GRIDFLEX's own
  sequences — never copy DAQ's actual design, copy, specific animation
  timings, or assets. No sound, anywhere. See §7 for GRIDFLEX's own numbers
  derived from studying it, §13 for the motion rules, §14 for the
  technique.
- **Bybit and OKX trading screens** → the terminal's *layout*: instrument
  bar, market list, chart, order ticket, bottom tabs. See §8.
- **TradingView** → the *chart*: Japanese candlesticks, a timeframe row, an
  OHLC legend, the price scale on the right, a crosshair, a neutral dark
  theme. See §9.
- **Interactive Brokers and Trading 212** → *density, table design, tabular
  numbers, clarity*. Rows are compact, numbers align on the decimal, nothing
  is oversized for effect.

---

## 4. Tokens

Every token below already exists in `web/app/globals.css`. Reference them
by name; do not invent new colours, radii, or spacing scales. If a design
need isn't covered by an existing token, that's a design-brief gap to raise,
not a license to add a one-off value in a component.

**Surfaces (near-black, not pure black in the app — pure black is DAQ's
landing-page move, see §7):**

| Token | Value | Use |
|---|---|---|
| `--background` | `#0a0b0d` | page background |
| `--card` | `#111318` | panels, cards, table rows |
| `--border` | `#262a33` | all dividers and 1px borders |
| `--foreground` | `#e7e9ed` | primary text, primary numbers |
| `--muted-foreground` | `#9aa1ac` | labels, secondary text, deemphasized numbers |

**Color only for meaning — never for decoration:**

| Token | Value | Meaning |
|---|---|---|
| `--up` | `#1fce7a` | price up, long, YES |
| `--down` | `#ef4444` | price down, short, NO |
| `--warning` | `#e8a33d` | dispute windows, pending states, the strike reference line |
| `--mismatch` | `#7f1d1d` (bg) / `--mismatch-foreground` `#ffe9e9` (text) / `--mismatch-accent` `#ff3b30` (left border) | a verification mismatch, and nothing else |

**MISMATCH is a solid filled block, never an inline badge, never the same
treatment as `--down`.** See `web/components/feed-panel.tsx`'s
`VerificationBadge` for the canonical implementation: `border-l-2
border-mismatch-accent bg-mismatch px-2 py-1 text-mismatch-foreground`. A
data mismatch must never be stylistically mistakable for a transient check
failure or a passing verification pill — this is a correctness rule, not a
stylistic preference.

**Dataviz series (chart lines/areas that aren't up/down-coded), neutral:**
`--chart-1` `#5b8def`, `--chart-2` `#9aa1ac`, `--chart-3` `#e8a33d`,
`--chart-4` `#1fce7a`, `--chart-5` `#ef4444`.

**Type:** `--font-geist-sans` for prose and UI labels, `--font-geist-mono`
(Geist Mono) for every number, every address, every hash, every metricId,
every ticker-like string. Numbers use the `tabular-nums` utility everywhere
— a price, a balance, a countdown, a row of table figures. Never
proportional digits in a column of numbers.

**Structure:** radius is `--radius: 0.125rem` (2px) everywhere — buttons,
cards, inputs, badges. Borders are 1px, `--border` coloured. **No
`box-shadow` anywhere** — depth comes from a 1px border and a background
step (`--card` on `--background`), never a shadow.

---

## 5. Language — plain English a finance student understands instantly

The audience is a trader or a finance student, not a Solidity developer.
Every label is written for that reader first; the technical detail is
still present, just demoted to small mono type.

- **"Strike", never "Threshold."**
- **YES price and NO price, in cents** (`67.3¢`), never "liquidity", never
  "reserve" in primary UI. Pool depth / reserves are real numbers that
  belong in a details panel, not the primary quote.
- **One product, asked as a question.** The public site sells exactly one
  thing: "Will Texas power cost more than $X on [date]?" Every listed
  market is named that way — `"Will Texas power cost more than $30 on 8
  Sep?"` — with one line underneath stating what it pays and when: "Pays
  1 mUSDT per YES if the Texas power price for 8 Sep 2026 settles above
  $30.00/MWh." The name, strike, day and pay line are built from the
  contract's own reads (§6) — see `marketName()`/`payLine()` in
  `web/lib/markets.tsx`. Only Texas power price markets are listed; a
  market on any other metric exists on chain but never appears on a
  public page.

### Dictionary

Display words on public pages (`/` and `/trade`). These are display words
only — metric IDs, contract names, function names and events stay exactly
as they are in code and on chain.

| Internal term | On a public page |
|---|---|
| North Hub day-ahead average (`ERCOT_HBNORTH_DA_AVG`) | **Texas power price** |
| ERCOT | Only in the landing page's *How we verify* section, as "ERCOT, Texas's official grid price" |
| $/MWh | Kept as the unit on every figure; explained once on the landing page as roughly what a thousand homes use in an hour |
| Digital option, binary market, `BinaryMarket` | **YES/NO question** (the contract itself: "Contract") |
| Mint set, swap | **Buy YES**, **Buy NO** |
| `sourceHash`, verification | **Verified** |
| `dayKey` | The date, e.g. `8 Sep 2026` |
| Basis, hub, dispute window, finalize | **Never shown** |

**Kept exactly as they are:** Strike, YES and NO price in cents, resolve,
settle, redeem, oracle, MockUSDT, collateral, X Layer testnet.

Two things are data, not words, and don't count as removed terms: contract
names beside their addresses (the footer's `GridOracle`,
`MarketFactory`, `MockUSDT`), and the source file names in *How we
verify*, shown verbatim because they are the hash inputs anyone needs to
reproduce the hash (they contain the dataset and hub codes).

The Texas power price is a daily figure: the average of the day's 24
hourly day-ahead prices. The terminal's candlestick chart shows the live
real-time price, which is not the same number — its caption says so in
one line: "Live prices, for reference · markets settle on the verified
daily Texas power price" (§6).
- **Units follow `shared/metrics.md` exactly, per metric** (only the
  first is shown on a public page — see the dictionary above):
  - `ERCOT_HBNORTH_DA_AVG` — USD/MWh, a price level. No `+` sign, ever
    (e.g. `$39.57/MWh`).
  - `ERCOT_WEST_NORTH_DA_BASIS` — USD/MWh, a signed spread. `+` shown only
    when positive (e.g. `+$4.74/MWh`, `-$10.32/MWh`). **The `+` sign is
    reserved for this one metric** — it is never applied to a price level.
  - `ERCOT_LOAD_WEIGHTED_DA_INDEX` — USD/MWh, a price level, feed only. No
    `+` sign.
  - `ERCOT_HBWEST_NEG_INTERVALS` — a plain integer count, 0–96, unit
    "intervals". **Never rendered with a dollar sign, never scaled** — it
    is a count, not a currency figure, even though it sits next to metrics
    that are.
  - `ERCOT_FUELMIX_<FUEL>` — a percentage share, feed only, display ratio.
- **Never "tokenised energy."** GRIDFLEX is a derivatives venue; nothing is
  redeemable for electricity. This is a product-accuracy rule as much as a
  copy rule.
- **Never "real money."** State plainly: this is **X Layer testnet**,
  settled in **MockUSDT**. Say the chain and the collateral by name rather
  than reaching for a euphemism in either direction — once per page, per
  the copy budget below.

### Copy budget

Every sentence tells the reader something they need and don't already
know. Cut repetition, the obvious, and anything written to sound
impressive.

- **Each fact once per page.** If the header, hero, or instrument bar has
  already said it, nothing below repeats it. Rows in a data table are
  exempt: a table lists every record, so a row may repeat a figure stated
  elsewhere on the page (e.g. the Proof table's 8 Sep price also shown in
  *How we verify*).
- **The one required disclaimer.** "X Layer testnet" and "MockUSDT" appear
  exactly once per page, together, as one small line. No other disclaimer
  line, banner, or footnote. Contract names in the address footer
  (`GridOracle`, `MarketFactory`, `MockUSDT` beside their addresses) are
  data, not disclaimers, and don't count toward this rule.
- **No event branding.** No "OKX Dev Day 2026", no hackathon name, no track
  name, no "built for…" line.
- **No defensive negations.** State what the product is, never what it
  isn't — "Cash-settled in MockUSDT", not "No electricity is delivered."
  The "never tokenised energy" rule above is met by describing the product
  accurately, not by denying the wrong description on the page.
- **Landing page (`/`):** hero headline 10 words or fewer; one supporting
  line of 20 words or fewer; each section introduced in at most one
  sentence; no paragraph over two sentences.
- **Terminal (`/trade`):** labels and numbers only. Only empty states and
  errors may be sentences — one short sentence each.
- **Where a label can replace a sentence, use the label.** `Strike $30.00`,
  not "The strike for this market is $30."

---

## 6. Honesty

These rules exist because a data-mismatch or a fabricated market state is
a worse failure mode here than almost any UI bug elsewhere in the product.

- **No illustrative or placeholder data, anywhere** — not a skeleton chart
  with fake candles, not a sample order book, not lorem-ipsum copy staged
  as if it were live. If data doesn't exist yet, **show an honest empty
  state that says so** in one short sentence — e.g. "No trades yet." —
  not a spinner that never resolves or a table quietly populated with
  invented rows.
- **Every contract fact is read from the chain, never typed into copy.** A
  market's name, strike, day, status, outcome, prices and trades come from
  its `BinaryMarket`'s own reads and events (`web/lib/markets.tsx`); the
  only non-chain input is the list of market addresses published from
  `shared/addresses.json`. For each market day, one of three states:
  - **No `BinaryMarket` exists** — show the oracle reading directly, as a
    fact about the reading, never as a market outcome: "Texas power price settled
    at $39.57/MWh." No strike is stated — without a contract there isn't
    one.
  - **A `BinaryMarket` exists but hasn't resolved** — trading until
    `resolveAfter`, then **awaiting resolution**. The reading may be shown
    with the contract's strike ("…, above the $30 strike."), but never as
    an outcome.
  - **`resolved()` is true** — show the outcome from `yesWon()`:
    "Resolved · YES". `cancelled()` shows as cancelled.
  Wrong in every state: "SETTLED · YES" before `resolved()` says so, or any
  line asserting that no market is deployed.
- **Live ERCOT prices are labelled market data, visually and textually
  distinct from on-chain verified readings.** The candlestick chart (real
  `ercot_spp_real_time_15_min` prices, not yet submitted to the oracle) and
  the feed page's verified-readings table (a committed file plus a live
  `getReading()` check) are two different trust levels and must never be
  presented as interchangeable. Caption the chart as live prices for
  reference, and name what markets settle on instead — the verified daily
  Texas power price — rather than implying the chart carries the same
  on-chain-verified status as a published price. The dataset name and its hash stay in the
  candle file (and the caption's tooltip), not in visible copy — per the
  dictionary (§5), the hub code is never shown.

---

## 7. Page 1 — the landing page at `/`

Header: wordmark top-left (see §2), a minimal nav, and an "Open terminal"
button — no wallet button on this page; connecting a wallet is a terminal
action, not a marketing-page one.

**Hero — opens with the daily swing.** The headline states, plainly, the
cheapest and dearest hour of the latest day in the data ("Texas power
cost $21.68 at 9am and $105.52 at 7pm."), with a small mono line giving
the date, Central time and the unit. One supporting line states the
product: trade YES or NO on whether Texas power will cost more than the
strike on a given day. The numbers come from `build_feed_data.py`'s
`write_price_summary()` (`web/public/data/price-summary.json`), computed
from the exact hashed source files of the latest published daily price,
held to the same 24-hour completeness check, and cross-checked against
that day's published value. The page's one disclaimer line (X Layer
testnet · MockUSDT, §5) is the hero eyebrow, not a footnote.

**01 / Normal range.** One sentence explains $/MWh (roughly what a
thousand homes use in an hour) — the only place it's explained. Two
stats: the normal range (the middle 80% of published days, 10th to 90th
percentile) and the exception — **26 January 2026, $694.03/MWh**, about
**25×** the median day. Below them, the page's main chart: the daily
Texas power price over time, the normal range shaded. It defaults to the
last 90 published days, where the normal range is legible, with a toggle
to the full year, which shows the 26 January peak, marked. Each number
appears once, in the stats — the chart shows shape.

**02 / How we verify — the page's centrepiece, and its most carefully
made element, and the one place ERCOT is named.** An interactive
four-stage diagram:

1. **Source** — ERCOT, Texas's official grid price, via GridStatus.
2. **Compute** — the average of 24 hourly prices, SHA-256-hashed with its
   inputs.
3. **Publish** — the price is written to the oracle on X Layer.
4. **Settle** — YES/NO questions settle against the published price.

Each stage shows **real evidence** on hover or tap — never illustrative
placeholder content (§6): a real source filename from `sourceFiles`, the
real SHA-256 source hash, the real `GridOracle` address with a real transaction
link to the X Layer explorer, and a real published reading. See
`web/components/landing/data-path-diagram.tsx` for the canonical
implementation and its data sources (`web/public/data/evidence-demo-day.json`,
`web/public/data/addresses.json`, `/data/ERCOT_HBNORTH_DA_AVG.json`).

**03 / Proof.** Every published Texas power price — date, price, its live
Verified state (§4's MISMATCH rule applies here too) and its oracle
transaction.

**04 / Open terminal.** The call to action, restated once, not repeated
elsewhere on the page. It names the listed YES/NO questions from chain
state (§6).

**Spacing, type scale, and rhythm — DAQ's standard, given concrete
numbers** (derived from studying daqconsulting.com, not copied from it —
these are GRIDFLEX's own values):

- Container: `max-w-[1440px]`, horizontal padding `px-4 sm:px-6 lg:px-8`.
- Section rhythm: every major section (`01`–`04`) is separated by a 1px
  `border-border` hairline and `py-16 sm:py-24` of vertical padding —
  roughly 64px on mobile, 96px at desktop widths. The hero gets more:
  `py-20 sm:py-28 lg:py-36` (80/112/144px).
- Section numeral heading: the `01 /` numeral in `font-mono text-sm
  text-muted-foreground`, the title beside it in `text-2xl sm:text-3xl
  font-semibold tracking-tight text-foreground`, laid out on one baseline
  with a small gap — numeral visibly lighter than the title, never the
  same weight or colour.
- Hero headline: `text-4xl sm:text-6xl lg:text-7xl font-semibold
  leading-[1.05] tracking-tight` (36/60/72px).
- Body/supporting copy: `text-lg leading-8 text-muted-foreground` (18px,
  32px line height) for de-emphasized prose; `text-foreground` only where
  a sentence needs the reader's full attention.

---

## 8. Page 2 — the terminal at `/trade`

Bybit/OKX layout. **No marketing copy anywhere on this page** — every
string is either a number, a label, or an honest status.

- **Top:** instrument bar — plain-English name, current underlying price,
  strike, settlement date, status. See §5 for naming, §6 for the
  settled-state rule.
- **Left:** market selector — every listed Texas power price question,
  named and labelled from its own contract state (§5, §6). With none
  listed, an honest empty state; never a list padded with placeholders.
- **Centre:** the chart (§9), with the selected question's strike line.
- **Right:** a compact settlement summary (labels and numbers the
  instrument bar doesn't already show), plus the order ticket
  (`trade-panel.tsx` — see §12) when the ticket is configured for the
  selected market.
- **Bottom:** tabs — positions (the connected wallet's mUSDT, YES and NO
  balances for the selected market), history (the market's real trades,
  from its `Swapped` events, shown as Buy YES / Buy NO, or "No trades
  yet."), settlement (the full on-chain evidence).
  The summary and the evidence are never the same panel shown twice.

Dense, per Interactive Brokers / Trading 212 (§3): compact rows, numbers
aligned, no element sized for visual effect rather than legibility.

---

## 9. The chart

TradingView's **Lightweight Charts** library, on real ERCOT real-time
data only — never day-ahead hourly data reshaped to look like a candle
series, and never synthetic data (§6). Two datasets, by timeframe:

- **`15m` and `1H`** come from the 5-minute dataset
  (`ercot_lmp_by_settlement_point`). A 15-minute settlement price is one
  number per 15 minutes, so a 15m candle built from it has open = high =
  low = close — a flat line, not a candle — and a 1H candle has only four
  points. The 5-minute prices give each 15m candle three points and each
  1H candle twelve.
- **`4H`, `1D` and `1W`** stay on the 15-minute settlement dataset
  (`ercot_spp_real_time_15_min`), which has enough points per candle.

The candle file records which dataset built each timeframe (`sources`);
the caption's tooltip carries the hash of the one on screen.

- **Japanese candlesticks**, up/down coloured with `--up` / `--down` (§4) —
  body, wick, and border all use the same up/down pair, no separate chart
  palette for candles.
- **Timeframe row:** `15m`, `1H`, `4H`, `1D`, `1W`, in that order.
- **No hub switcher.** The chart shows the Texas power price's hub only;
  hubs are never shown (§5).
- **OHLC legend, top-left**, updating live as the crosshair moves: open,
  high, low, close for the hovered bar, in tabular mono type, coloured by
  that bar's up/down state.
- **Price scale on the right.**
- **Crosshair** enabled, both axes.
- **The strike as a labelled horizontal line** on the chart, in `--warning`,
  dashed, with its dollar value in the axis label.
- **Neutral dark theme**: chart background transparent over `--background`,
  grid lines in `--border` at low opacity, axis text in
  `--muted-foreground`, mono font family read from the same
  `--font-geist-mono` custom property the rest of the app uses — never a
  hardcoded font string.
- **TradingView attribution** stays enabled (Lightweight Charts' default
  attribution mark) as its license requires — it is not removed for a
  cleaner look.

---

## 10. Responsive

Both pages work at phone width. A judge may open the product link on one.
**390px is the floor** — nothing overflows horizontally, nothing requires
a horizontal scroll except a table/chart in its own contained
`overflow-x: auto` region.

**Landing page (`/`):** sections stack as already laid out (they're
single-column by design even at desktop past the hero); the type scale in
§7 already steps down at the `sm` breakpoint. The interactive diagram's
four stages stack `grid-cols-2` on mobile rather than four across.

**Terminal (`/trade`) — collapse order, top to bottom, below the `lg`
breakpoint:**

1. Instrument bar stays at the top, full width, unchanged.
2. The market selector collapses out of a fixed left column into a
   dropdown/expandable row directly under the instrument bar — it does not
   sit beside the chart on a narrow screen.
3. The chart takes full width next, at a reduced but still legible height.
4. The order ticket (`trade-panel.tsx`) moves below the chart,
   full width — never squeezed into a narrow side column on mobile.
5. The bottom tabs (positions/history/settlement) remain a single
   horizontally-scrollable tab strip, full width.

This is a deliberate stacking order, not "whatever the grid does by
default" — a trader on a phone wants context, then the chart, then the
action, in that order.

---

## 11. Acceptance checklist

Grade any page or component against this list, item by item. A page ships
only when every item is a pass.

1. No banned visual pattern from §2 is present anywhere on the page.
2. No logo — the wordmark is text-only, everywhere it appears.
3. No word appears that a finance student wouldn't understand on first
   read (no unexplained "reserve", "liquidity" as a primary label, no
   metricId anywhere, etc. — see §5).
4. Every number on the page is real — sourced from a committed file, a
   live chain read, or a live ERCOT fetch — never illustrative, sample, or
   placeholder data (§6).
5. Every number is set in tabular mono type (`tabular-nums`, `font-mono`).
6. Colour is used only for meaning (§4) — no colour choice exists purely for
   visual variety or brand feel.
7. MISMATCH, where it appears, is the filled dark-red block treatment —
   never an inline badge, never visually similar to a transient failure.
8. Radius is 2px and borders are 1px everywhere; no `box-shadow` appears
   anywhere on the page.
9. "Strike" is used, never "Threshold."
10. YES/NO are quoted in cents as the primary figure; reserves/pool depth
    only appear in a details panel, never as the headline number.
11. Every listed market is named as the question "Will Texas power cost
    more than $X on [date]?", and no metricId is shown.
12. YES/NO questions are called YES/NO questions — never digital options
    or binary markets (§5 dictionary).
13. Units match `shared/metrics.md` per metric exactly, including that the
    `+` sign appears only on the basis spread and negative intervals are
    never shown with a dollar sign.
14. The word "tokenised" never appears describing GRIDFLEX's product.
15. The phrase "real money" never appears; the page states X Layer testnet
    and MockUSDT by name, exactly once, as one small line (§5 copy budget).
16. No empty/loading state is silently blank or spinner-forever — every
    such state has honest copy explaining why there's nothing to show.
17. Every contract fact is read from chain, in one of §6's three states:
    no `BinaryMarket` → the oracle reading only; unresolved → trading or
    awaiting resolution; `resolved()` → the outcome from `yesWon()`. No
    line claims that no market is deployed.
18. Live ERCOT market-data (the chart) is visually/textually distinguished
    from on-chain verified readings (the feed table) — they are never
    presented as the same trust level.
19. The chart shows Japanese candlesticks in `--up`/`--down`, a `15m 1H 4H
    1D 1W` timeframe row, no hub switcher, a top-left OHLC legend that
    updates with the crosshair, the price scale on the right, and a
    crosshair.
20. The strike appears on the chart as a labelled horizontal line.
21. Lightweight Charts' TradingView attribution mark is present, not
    removed.
22. The page works at 390px width: no horizontal overflow of the page
    itself, and the terminal's regions collapse in the order specified in
    §10.
23. The terminal page (`/trade`) contains no marketing copy — every string
    is a number, a label, or an honest status.
24. Changes to `web/components/{trade-panel,wallet-button,web3-provider,
    market-live-data}.tsx` follow the integration ownership rule in §12.
25. Landing-page scroll-triggered reveals and the diagram's stage-to-stage
    animation animate only `transform` and `opacity`; landing-page hover/
    press micro-interactions may additionally animate `color` (text/
    border only) — no other property, and no exception on `/trade` (§13).
26. The terminal (`/trade`) has no decorative motion anywhere on it (§13).
27. `prefers-reduced-motion` disables all animation and smooth scrolling
    completely, on both pages (§13).
28. No motion on either page causes layout shift or delays content
    appearing (§13).
29. Nothing on either page loops or moves on its own while idle (§13).
30. No component on either page shows a default/stock library look — every
    shadcn or library component is restyled to this brief (§2).
31. Every interactive element on the landing page (buttons, links, the
    nav, the diagram's stage tiles, feed table rows) has a 150–250ms
    hover/press transition, and the diagram's active stage additionally
    lifts subtly on hover (§13).
32. The hero headline reveals word by word on load, once, using only
    `transform`/`opacity` — it does not replay on scroll-back or resize
    (§13).
33. Every sentence tells the reader something they need and don't already
    know — nothing repeated, obvious, or written to impress (§5 copy
    budget).
34. No fact is stated twice on the page, outside rows of a data table
    (§5 copy budget).
35. "X Layer testnet" and "MockUSDT" each appear exactly once, in the same
    single small line; no other disclaimer exists on the page. The address
    footer's contract names are data and don't count (§5).
36. No event branding — "OKX Dev Day 2026" or any hackathon, track, or
    "built for" line — appears anywhere.
37. No defensive negation — no sentence says what GRIDFLEX isn't or doesn't
    do.
38. Landing page: hero headline ≤ 10 words; one supporting line ≤ 20
    words; each section intro ≤ 1 sentence; no paragraph > 2 sentences.
39. Terminal: every string is a label or a number, except empty states and
    errors, which are one short sentence each.
40. No sentence remains where a label would carry the same information.
41. No removed term (§5 dictionary) appears on a public page: no "North
    Hub", no "ERCOT" outside *How we verify*, no "digital option" or
    "binary market", no "mint", "set" or "swap" as a trading term, no
    "sourceHash", no "dayKey", no basis, hub, dispute window or finalize.
    Contract names beside addresses and the verbatim source file names in
    *How we verify* are data and don't count.

---

## 12. Ownership

`web/components/trade-panel.tsx`, `web/components/wallet-button.tsx`,
`web/components/web3-provider.tsx`, and `web/components/market-live-data.tsx`
form one integration-owned surface. Design changes to those four files are
specified here and implemented together so transaction behaviour, wallet
state and live-data assumptions remain consistent. Everything else in
`web/` may be built directly against this brief.

---

## 13. Motion

Motion rules differ sharply by page, because the two pages have different
jobs (§1). See §14 for which libraries implement this and why.

**Landing page (`/`):**

- Scroll-triggered section reveals, animating **only `transform` and
  `opacity`** — no other CSS property is animated on scroll-in (not
  `height`, not `color`, not `filter`).
- Duration **400–700ms**, gentle easing (an ease-out curve — quick start,
  soft settle, no bounce, no overshoot).
- Smooth momentum scrolling is on for this page.
- The four-stage diagram (§7) **animates between stages** when a stage is
  clicked or hovered, so the data visibly flows from Source to Settle —
  the transition itself is part of what teaches the reader the pipeline's
  shape, not just a state swap.
- **Micro-interactions.** Every interactive element on the page — buttons,
  links, the nav, the diagram's stage tiles, the feed table's rows —
  responds to hover and press with a **150–250ms** transition, no
  perceptible delay between the pointer action and the transition
  starting. This is the one place on the landing page where the
  transform/opacity-only rule above gets a narrow, deliberate exception:
  a hover/press transition may animate `transform`, `opacity`, **or
  `color`** (text or border colour only — never a background, a gradient,
  a glow, or a box-shadow, all still banned by §2/§4). Scroll-triggered
  reveals and the diagram's stage-to-stage animation are not part of this
  exception and stay `transform`/`opacity`-only as specified above. The
  diagram's active stage additionally lifts subtly on hover — a small
  `translateY`, layered on top of its existing highlight, never a shadow.
- **Hero headline reveal.** The hero headline reveals word by word on
  load — `transform`/`opacity` only, per the rule above, since this is an
  entrance sequence rather than a hover response. It runs once, on the
  first load; it does not replay on scroll-back, resize, or re-hover.

**Terminal (`/trade`):**

- **No decorative motion at all.** Nothing animates for the sake of
  animating.
- Price updates and state changes are **instant or under 150ms** — a
  trader never waits for an animation to see a number change.
- Smooth momentum scrolling is **off** on this page; scrolling is native
  and immediate.

**Both pages:**

- `prefers-reduced-motion` disables all animation and smooth scrolling
  completely — with it set, content appears instantly and the page
  scrolls natively, with no exception.
- Motion never causes layout shift and never delays content from
  appearing — an element is never invisible-then-revealed in a way that
  makes the reader wait for it; it animates in place, already occupying
  its final layout position.
- Nothing loops or moves on its own while idle. Every animation is a
  direct response to a scroll position, a hover, or a click — never a
  background loop, a pulse, or an idle-state flourish.

---

## 14. Technique

**What daqconsulting.com is actually built with**, found by inspecting its
loaded scripts, DOM, and runtime globals (not guessed from how it looks):

- **Next.js** (Turbopack bundler), **Tailwind CSS** with a handful of CSS
  Modules for a few bespoke components, **Inter** loaded via `next/font`.
- **Smooth scrolling: Lenis** — confirmed directly (`<html
  class="lenis lenis-smooth lenis-stopped">`, a `lenisVersion` runtime
  global). **License: MIT.**
- **Scroll-linked animation: GSAP 3.14.2** — confirmed directly
  (`window.gsapVersions`, GSAP's own console warnings firing at runtime),
  almost certainly paired with its **ScrollTrigger** plugin to sync
  animation progress to Lenis's scroll position — the standard, documented
  way these two libraries are combined. **License: GreenSock's standard
  license** — as of GSAP joining Webflow in 2024, the core library and
  every plugin (ScrollTrigger, SplitText, Flip, and the rest) is free for
  all use, including commercial products. Not an OSI-approved open-source
  license, but explicitly free and unrestricted for this use — confirmed
  from GreenSock's own published licensing terms.
- **Pinning is plain CSS `position: sticky`**, not a JS-computed fixed
  position: viewport-height (`h-[100svh]`) content sits sticky inside a
  much taller wrapping section (`h-[250vh]`, `calc(100svh + 215vw)`), the
  standard "scrollytelling" shape — GSAP/ScrollTrigger only drives the
  *progress-based animation* as the sticky content scrolls through, not
  the pin itself.
- **The word-by-word headline reveal is very likely GSAP's SplitText
  plugin**: an `html[data-intro="play"]` attribute plus `overflow:hidden`
  on `<html>` gate scrolling until the entrance sequence finishes, and by
  the time either was inspected after that sequence completed, both had
  cleared and the headline had reverted to plain text with zero wrapper
  spans — consistent with SplitText's documented pattern of splitting
  text to animate it, then calling `.revert()` to restore clean semantic
  HTML afterward. Not caught mid-animation directly; inferred from GSAP's
  confirmed presence plus this reversion signature.
- **The hover-to-inspect diagram has no separate library signature** —
  most plausibly built with the same GSAP tweens as the rest of the page's
  motion, not a distinct tool.

**What GRIDFLEX uses, and why:** the same two libraries, because both
licenses explicitly permit this use and both are already the right tool
for the job specified in §13 — this is "same libraries," not just "same
class of technique," exactly where the license allows it.

- **Lenis** (MIT) for the landing page's smooth momentum scrolling (§13).
  Not loaded on `/trade` at all — the terminal's scrolling is native.
- **GSAP, with ScrollTrigger**, for the landing page's scroll-triggered
  reveals and the four-stage diagram's stage-to-stage animation (§13).
  **SplitText** is available under the same free license if a future
  headline treatment calls for a word- or character-level reveal — not
  required by the current brief, but licensed and ready if a design
  decision here later needs it.
- Neither library is loaded on `/trade`. The terminal has no decorative
  motion (§13), so it carries none of this dependency weight — state
  changes there are plain, instant DOM/React updates.
- What is never taken from DAQ, regardless of library: its specific
  animation sequences, timings tuned to its own copy and layout, its
  assets, its colours, or its actual copy. The libraries and the class of
  technique are shared; the design is GRIDFLEX's own, built to §13's
  rules.
