# GRIDFLEX demo markets

Seven markets, all on the one public product — the Texas power price,
`ERCOT_HBNORTH_DA_AVG` (see `shared/design-brief.md` §5). They come in two
kinds, and `create_markets.py` reads the kind of each one from the
Summary table below:

- **Live**: a future market day that people can trade now. No reading exists
  when the market is created, and none can. Trading closes at **12:30 Texas
  time on the day before the market day**. That is one hour before ERCOT
  publishes that day's day-ahead price at 13:30 Central, so nobody can
  trade on a price that has already been published.
- **Replay**: a market day that has already settled, so the video can show
  the whole cycle (mint → trade → close → resolve → redeem) in one take.
  Its reading must already be **published and finalized** on-chain. Trading
  stays open for **45 minutes from the moment the market is created**, and
  after that `resolve()` works straight away.

Every close below is shown in Texas and London time. `create_markets.py`
prints the same two clocks in its dry run and in its live confirmation.

---

## How a close is enforced

`resolveAfter` is the trading close, and the contract enforces it.
`contracts/src/BinaryMarket.sol` reverts `mintSet`, `swap` and `seedPool`
with `TradingClosed()` once `block.timestamp >= resolveAfter`, and
`resolve()` reverts `ResolveTooEarly` before it. Outcome tokens are still
ordinary ERC-20s after the close, so wallet-to-wallet transfers keep
working, but nothing new can be minted and nothing can go through the pool.

**Dispute window, by kind.** `cancel()` voids a market that has no
published reading once `resolveAfter + disputeWindow` has passed.

- **Replay: 0.** Its reading is already published, so `cancel()` can never
  succeed. This is the past-day-demo value from `shared/deployment.md`.
- **Live: 7 days.** A live market's reading can't be on-chain at its close.
  `fetch_ercot.py` can only reach day D once the UTC date has moved past
  D, which is at least ~30 hours after close, and publish/finalize are
  manual runs after that. With 0, anyone could void a live market in that
  gap. Seven days leaves room for a missed run while still letting a market
  whose data never arrives be cancelled in the end.

The dispute window only delays `cancel()`. `resolve()` never reads it: it
works as soon as `resolveAfter` has passed and the oracle reports the
reading final (`isFinal`). The oracle's own wait between publish and
finalize is separate, set in `GridOracle`.

---

## Replay markets

Two, so a failed take can be redone: the second is a spare, created only
if the first one's take fails. In live mode `create_markets.py` creates a
replay market only when its row is named with `--market`, so running it
without `--market` can never start a replay clock by accident.

### 1. Texas power, 11 September 2025, above $25

> **"Did Texas power cost more than $25 on September 11, 2025?"**

- Metric: `ERCOT_HBNORTH_DA_AVG`, **`dayKey 20250911`**
- Strike: $25.00/MWh (on-chain threshold `2500`)
- Reading: **$26.38/MWh** (`2638`), already published and finalized
  (`data/metrics/ERCOT_HBNORTH_DA_AVG__2025-09-11.json`) — **YES wins**
- Trading close: 45 minutes after creation. `resolveAfter` is computed just
  before `createMarket` is sent, not when the operator types `yes`, so the
  whole 45 minutes counts from creation.
- Resolvable as soon as trading closes. Record the video within that
  window: trade, wait for the close, resolve, redeem.
- Create with `python3 create_markets.py --market 1 --live`.

### 5. Spare: Texas power, 10 September 2025, above $20

> **"Did Texas power cost more than $20 on September 10, 2025?"**

- Metric: `ERCOT_HBNORTH_DA_AVG`, **`dayKey 20250910`**
- Strike: $20.00/MWh (on-chain threshold `2000`)
- Reading: **$22.62/MWh** (`2262`), already published and finalized
  (`data/metrics/ERCOT_HBNORTH_DA_AVG__2025-09-10.json`) — **YES wins**
- Trading close: 45 minutes after creation, the same as market 1.
- Why this day: it's the only other Texas power price day with a published,
  finalized reading and no market. The third, 8 September 2026, already
  has a market. `create_markets.py` creates at most one market per metric,
  day and strike.
- Create **only if market 1's take fails**, with
  `python3 create_markets.py --market 5 --live`.

---

## Live markets

Markets 2–4 share a strike of **$45/MWh** (threshold `4500`) and differ by
market day. Markets 6 and 7 add a second, lower strike on 30 September and
2 October, so each of those days shows a strike ladder on the same
underlying: $40 and $45 on 30 September, $38 and $45 on 2 October. Why
those strikes: see "Choosing the ladder strikes" below.

### 2. Texas power, 26 September 2026

> **"Will Texas power cost more than $45 on September 26, 2026?"**

- **`dayKey 20260926`**
- Trading close: **2026-09-25 12:30 CDT (Texas) / 18:30 BST (London)**.
  That is the evening of the submission day in London.

### 3. Texas power, 30 September 2026

> **"Will Texas power cost more than $45 on September 30, 2026?"**

- **`dayKey 20260930`**
- Trading close: **2026-09-29 12:30 CDT (Texas) / 18:30 BST (London)**

### 4. Texas power, 2 October 2026

> **"Will Texas power cost more than $45 on October 2, 2026?"**

- **`dayKey 20261002`**
- Trading close: **2026-10-01 12:30 CDT (Texas) / 18:30 BST (London)**.
  It stays open for trading through the judges' review period, which runs
  until 30 September.
- Resolution: `fetch_ercot.py` stops at "yesterday in UTC", so 2 October
  can be fetched once UTC reaches 2026-10-03 (08:00 SGT on 3 October; see
  the note at the end). After that come publish and finalize, and then
  `resolve()` works. That leaves time for it to settle before the
  6 October finale.

### 6. Texas power, 30 September 2026, above $40

> **"Will Texas power cost more than $40 on September 30, 2026?"**

- **`dayKey 20260930`**, strike $40.00/MWh (threshold `4000`). The lower
  rung of the ladder beside market 3 ($45) on the same day.
- Trading close: **2026-09-29 12:30 CDT (Texas) / 18:30 BST (London)**, the
  same as market 3.
- Settles on the same reading as market 3, so both resolve together.

### 7. Texas power, 2 October 2026, above $38

> **"Will Texas power cost more than $38 on October 2, 2026?"**

- **`dayKey 20261002`**, strike $38.00/MWh (threshold `3800`). The lower
  rung beside market 4 ($45) on the same day.
- Trading close: **2026-10-01 12:30 CDT (Texas) / 18:30 BST (London)**, the
  same as market 4.
- Settles on the same reading as market 4.

---

## Summary table

| # | Metric | Question threshold | dayKey | Date | Kind | Trading close |
|---|---|---|---|---|---|---|
| 1 | `ERCOT_HBNORTH_DA_AVG` | > $25 | `20250911` | 2025-09-11 (past, $26.38 — YES) | replay | 45 min after creation |
| 2 | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20260926` | 2026-09-26 | live | 2026-09-25 12:30 CDT (Texas) / 18:30 BST (London) |
| 3 | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20260930` | 2026-09-30 | live | 2026-09-29 12:30 CDT (Texas) / 18:30 BST (London) |
| 4 | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20261002` | 2026-10-02 | live | 2026-10-01 12:30 CDT (Texas) / 18:30 BST (London) |
| 5 | `ERCOT_HBNORTH_DA_AVG` | > $20 | `20250910` | 2025-09-10 (past, $22.62 — YES; spare) | replay | 45 min after creation |
| 6 | `ERCOT_HBNORTH_DA_AVG` | > $40 | `20260930` | 2026-09-30 | live | 2026-09-29 12:30 CDT (Texas) / 18:30 BST (London) |
| 7 | `ERCOT_HBNORTH_DA_AVG` | > $38 | `20261002` | 2026-10-02 | live | 2026-10-01 12:30 CDT (Texas) / 18:30 BST (London) |

`create_markets.py` and `finalize.py --verify` both parse this table, so
keep its seven-column shape. Metric is column 2, threshold column 3, dayKey
column 4 and Kind column 6. The # column is the row's position: new rows go
at the bottom so existing numbers never change. A market is one metric, day
and strike, so a day may appear once per strike but never twice with the
same strike. The Trading close column is written for humans, and
`tests/test_create_markets.py` checks it against the close the script
computes.

None of these dayKeys is a DST changeover day. Contracts can't settle on
those days (see `shared/metrics.md`).

---

## Calibration: how often $45 has been crossed

The data runs from 2025-09-10 to 2026-09-09 and covers 363 published days.

- **Over the whole year:** 27 of 363 days closed above $45, which is
  **7.4%**.
- **17 September to 6 October 2025**, the calendar match for the demo
  window: **0 of 20** days. Every day in that window fell between $22.48
  and $36.01. The same days last year were 26 Sep $28.54, 30 Sep $33.30 and
  2 Oct $30.07, all NO.
- **Latest days in the dataset:** $39.57 on 8 Sep and $45.18 on 9 Sep 2026.
  Prices have been running higher than they did a year earlier, and 9 Sep
  crossed $45.

By the history alone, $45 points strongly to NO. The earlier plan used $30
for this metric because it was the one round strike that looked uncertain
in both the annual data (41.0%) and the demo-window match (50.0%). $45 was
chosen for these markets anyway. These numbers are here so the choice is
made knowingly. They describe what has already happened and don't predict
these dates.

---

## Choosing the ladder strikes

Worked from `data/metrics` on 23 September 2026, with the latest reading
for 22 September. Each share uses the contract's own test: strictly
greater than the strike.

### 30 September: $40

- The **30-day median is $37.52** and the **7-day median is $44.10**. $40
  sits between them.
- Two ways of reading the last year, each applied from 22 September to a
  day 8 days later:
  - **Persistence** (prices stay near the recent 7-day level): **63%**
    of outcomes above $40.
  - **Reversion** (history since September 2025 after the 7-day median ran
    more than 1.25× the 90-day median, as it does now): **35%** above
    $40.
  - The midpoint is **near 50%**, which is what a strike meant to be
    uncertain should give.
- Low confidence. If the current run holds (6 of the last 7 days were
  above $40), YES is close to certain; if it breaks as the late-August run
  did, prices fall back to $30–35 and NO is close to certain.

### 2 October: $38

- $2 below 30 September, for two reasons:
  - **Fridays run below mid-week.** Over the last 30 days the Friday
    median is **$36.71** against **$42.47** for Wednesdays. 30 September
    is a Wednesday; 2 October is a Friday.
  - **Two more days to revert** from the current run.
- No cut for the season. In 2025, October was no lower than September:
  1–15 October averaged $30.77 against $31.43 for 15–30 September, and the
  medians were level.

### What these numbers can't tell us

- **One year of history can't establish seasonality.** There is exactly
  one September-to-October transition in the data. It shows no decline,
  but one year can neither confirm nor rule one out.
- **The 7-day and 30-day evidence disagree by about $6** ($44.10 against
  $37.52). That gap is the real uncertainty in both strikes, more than any
  single percentage above.
- The reversion figure rests on only a handful of separate episodes, one
  of them the January storm.

---

## Markets created under the earlier plan (already on chain)

The earlier six-market plan created two markets, and both are recorded in
`shared/addresses.json` → `markets`. Their trading closed on 2026-09-21. They
are no longer in the Summary table, so `create_markets.py` won't touch them
and `finalize.py --verify` no longer checks them by default. Use
`--verify --metric … --day-key …` to check one.

| Metric | Threshold | dayKey | Outcome |
|---|---|---|---|
| `ERCOT_HBNORTH_DA_AVG` | > $30 | `20260908` | $39.57 — YES |
| `ERCOT_WEST_NORTH_DA_BASIS` | > $0 | `20260812` | −$10.32 — NO |

---

## Note: why a market day D can't resolve on day D

`fetch_ercot.py`'s own date arithmetic:

```python
end_date = datetime.now(timezone.utc).date()
start_date = end_date - timedelta(days=args.days)
```

`end_date` is always *today in UTC*, and the fetch window excludes that
end. So the pipeline only reaches "yesterday" relative to its own UTC run
time. ERCOT publishes day D's prices at 13:30 Central on D−1, but the
pipeline can't include D until UTC reaches D+1 00:00. Anchoring the cutoff
to when Central data is available would remove this gap. That is a
post-hackathon change: this arithmetic decides which market days exist at
all, and it deserves its own testing pass, not a same-week retrofit.
