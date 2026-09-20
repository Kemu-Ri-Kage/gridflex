# GRIDFLEX demo markets

Six candidate markets for the hackathon demo — three per contract metric
(`ERCOT_HBNORTH_DA_AVG`, `ERCOT_WEST_NORTH_DA_BASIS`) — built from the full
year of data in `data/metrics/` (2025-09-10 through 2026-09-09, 363
published days per metric; the two DST changeover days have no data and no
market may resolve on them).

**Read the seasonal-patterns section before the thresholds below.** One of
them — `ERCOT_WEST_NORTH_DA_BASIS` — behaves so differently in the exact
calendar window the demo happens in that the annually-obvious threshold
would be a dead market on demo day. The threshold recommendations already
account for this; this isn't a footnote, it changed the actual numbers
chosen.

---

## Seasonal patterns that matter for this demo

The hackathon's dates only exist once in the dataset: build 17–25 September
2026 and the Singapore finale 6 October 2026 have exactly one historical
analog, **17 September – 6 October 2025** (20 published days). Everything
"seasonal" below is that 20-day window compared to the full 363-day year —
a real pattern, but a small sample (one day = 5 percentage points of the
window's rate), stated with that precision in mind, not more.

**`ERCOT_HBNORTH_DA_AVG` shifts up, but not enough to break a $30 threshold.**
Annual median $28.24, window median ~$29.95 (min $22.48, max $36.01, all 20
days clustered in a $22–36 band — no summer or winter-storm spikes in this
window at all). A few annually-fine thresholds stop working here: $26 and
$28 both cross on 75–90% of window days — reading as "obviously yes" to
anyone watching the demo rather than a real market. **$30 survives both
checks** (annual 41.0%, window 50.0%) and is the only round number in the
tested range that does. That's not a coincidence to route around — it's
why $30 is used for all three `ERCOT_HBNORTH_DA_AVG` markets below.

**`ERCOT_WEST_NORTH_DA_BASIS` is where the seasonal effect is real and
large.** Annual median is $0.50 — close to the $0 line, which is exactly
why $0 looked like the obvious threshold. But in the 17 Sep – 6 Oct window,
basis was **positive on all 20 of 20 days** (min +$2.10, max +$8.64, mean
+$4.60) — not one day below zero. A market asking "will basis exceed $0"
listed for any day in the actual demo window would have resolved YES on
every single analogous day last year. That is a dead market, not a
tradeable one, and it's the same trap `ERCOT_HBWEST_NEG_INTERVALS` was
rejected for (see `shared/metrics.md`) — just discovered by season instead
of by metric.

The likely mechanism, consistent with what `basis_spread()`'s own comment
says (negative basis = West oversupplied relative to transmission, i.e.
wind/solar curtailment): late September/early October is a shoulder
season — past summer peak demand, before winter's wind ramp-up and storm
risk (the +$180 to +$694 day-ahead spikes in `data/metrics/` all cluster in
January 2026). Less curtailment pressure on the West side shows up directly
as basis staying positive. This is a real seasonal regime, not noise — see
the fuller year-round shape in `shared/metrics.md`'s data if you want the
month-by-month picture.

**Consequence for market design:** the two `ERCOT_WEST_NORTH_DA_BASIS`
markets that actually resolve inside the demo window use **$4**, not $0 —
tuned to the window (60.0% crossed) rather than the annual rate (17.1%,
which is *not* independently in the 35–65% band — deliberately overridden
here because the annual rate is the wrong number for a market that is
guaranteed to resolve on a specific date already known to fall in this
season). The one `ERCOT_WEST_NORTH_DA_BASIS` market that resolves on a past
date outside this window uses the annual-calibrated $0, which is
appropriate there because that date isn't subject to the seasonal effect.

---

## `ERCOT_HBNORTH_DA_AVG` — three markets

All three use **$30/MWh**, validated above as the one round threshold that
is genuinely uncertain both annually (41.0%) and in the exact demo-week
analog (50.0%). Varying the resolution date rather than the threshold is
deliberate, not a shortcut — see above.

### 1. Live full-lifecycle demo (past dayKey)

> **"Did the ERCOT North Hub day-ahead average exceed $30/MWh on September
> 8, 2026?"**

- Threshold: $30.00/MWh
- Resolves on: **`dayKey 20260908`** (2026-09-08) — already settled
- Historical base rate: 41.0% of the past year's days closed above $30
  (149/363)
- Actual outcome: **$39.57/MWh — YES.** Use this one to run the whole
  lifecycle live: list it as if trading were still open, place a trade,
  then resolve and redeem against the real, already-computed
  `data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-08.json` record — no waiting
  for tomorrow's data.

### 2. Demo-day market

> **"Will the ERCOT North Hub day-ahead average exceed $30/MWh on
> September 24, 2026?"**

- Threshold: $30.00/MWh
- Resolves on: **`dayKey 20260924`** (2026-09-24, inside the build window,
  ahead of the 25 Sep submission)
- Historical base rate: 41.0% annual, 50.0% in the exact 17 Sep–6 Oct
  analog window — genuinely live either way at the time this is listed
- Outcome: unknown at listing time, by construction — this is the one
  meant to actually be uncertain when the audience sees it

### 3. Eve-of-finale market (Singapore) — moved from 20261006, see note below

> **"Will the ERCOT North Hub day-ahead average exceed $30/MWh on
> October 5, 2026?"**

- Threshold: $30.00/MWh
- Resolves on: **`dayKey 20261005`** (2026-10-05, the day before the live
  finale)
- Historical base rate: same 41.0% / 50.0% split as the rest of this
  metric's markets — 5 October falls inside the same 17 Sep–6 Oct analog
  window already used to calibrate $30, so no recalculation was needed
- 5 October 2025's own analog was $22.48 — a NO. Worth saying out loud on
  stage: this specific historical day would have resolved NO, which is the
  honest answer to "so is $30 actually uncertain here" — yes, both
  outcomes really happen in this window, not just the YES cited for market
  1.
- Good closing-moment market: list it days ahead, let it trade through the
  finale build-up, resolve on stage using the metric file computed the
  afternoon before — see the timing note below for why it isn't the finale
  day itself.

---

## `ERCOT_WEST_NORTH_DA_BASIS` — three markets

### 1. Live full-lifecycle demo (past dayKey)

> **"Did the West–North day-ahead basis exceed $0/MWh on August 12,
> 2026?"**

- Threshold: $0.00/MWh
- Resolves on: **`dayKey 20260812`** (2026-08-12) — already settled
- Historical base rate: 55.4% of the past year's days closed with positive
  basis (201/363) — this date is outside the Sep/Oct seasonal window, so
  the annual rate is the right calibration here
- Actual outcome: **West $13.78, North $24.10, basis −$10.32 — NO.**
  West traded at a steep discount to North that day (real congestion, the
  regime $0 as a threshold is actually testing). Pairs well with market 1
  above: one live-demoed market resolves YES, the other NO, showing the
  redemption path works both directions, not just the convenient one.

### 2. Demo-day market

> **"Will the West–North day-ahead basis exceed $4/MWh on September 24,
> 2026?"**

- Threshold: $4.00/MWh — **not $0.** See "Seasonal patterns" above: $0
  resolved YES on all 20 days of the 2025 analog window, which is not a
  market, it's a foregone conclusion.
- Resolves on: **`dayKey 20260924`** (2026-09-24)
- Historical base rate: 60.0% in the 17 Sep–6 Oct analog window (12/20).
  Flag honestly: annual rate for $4 is only 17.1% — this threshold is
  deliberately tuned to the season this market actually resolves in, not
  to the full year, because the full year includes winter/spring months
  this market cannot land in.

### 3. Eve-of-finale market (Singapore) — moved from 20261006, see note below

> **"Will the West–North day-ahead basis exceed $4/MWh on October 5,
> 2026?"**

- Threshold: $4.00/MWh
- Resolves on: **`dayKey 20261005`** (2026-10-05, the day before the live
  finale)
- Historical base rate: same 60.0% window rate as above — 5 October falls
  inside the same 17 Sep–6 Oct analog window, so the rate is unchanged, no
  recalculation needed
- 5 October 2025's own analog was +$3.74 — a NO, and a close one: $0.26
  short of the $4 line. Almost the mirror image of the old 6 October
  citation (a narrow YES) — still exactly the kind of close call that makes
  for a good on-stage resolution moment, just landing the other way

---

## Summary table

| # | Metric | Question threshold | dayKey | Date | Base rate used | Basis for rate |
|---|---|---|---|---|---|---|
| 1 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20260908` | 2026-09-08 (past) | 41.0% | annual |
| 2 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20260924` | 2026-09-24 | 41.0% / 50.0% | annual + window agree |
| 3 | `ERCOT_HBNORTH_DA_AVG` | > $30 | `20261005` | 2026-10-05 | 41.0% / 50.0% | annual + window agree (unchanged, see note) |
| 4 | `ERCOT_WEST_NORTH_DA_BASIS` | > $0 | `20260812` | 2026-08-12 (past) | 55.4% | annual (outside seasonal window) |
| 5 | `ERCOT_WEST_NORTH_DA_BASIS` | > $4 | `20260924` | 2026-09-24 | 60.0% | **window** (annual rate, 17.1%, does not apply here) |
| 6 | `ERCOT_WEST_NORTH_DA_BASIS` | > $4 | `20261005` | 2026-10-05 | 60.0% | **window** (annual rate, 17.1%, does not apply here; unchanged, see note) |

Markets 1 and 4 are already-settled `dayKey`s with real `data/metrics/`
records behind them — both usable today for a live trade → resolve →
redeem walkthrough without waiting for a future date to arrive. Neither
`dayKey` in the full set of six falls on a DST changeover day.

### Note: why markets 3 and 6 moved from 20261006 to 20261005

Both originally targeted `dayKey 20261006` — the finale date itself. That
doesn't work, and not because of ERCOT's publication schedule (real
day-ahead prices for 6 October post around 1:30pm Central on 5 October,
well before the demo). The blocker is `fetch_ercot.py`'s own date
arithmetic:

```python
end_date = datetime.now(timezone.utc).date()
start_date = end_date - timedelta(days=args.days)
```

`end_date` is always *today in UTC*, and the fetch window is exclusive at
that end — the pipeline only ever reaches through "yesterday" relative to
its own UTC run-time, never "today." The demo window, 10:00–14:00 SGT on 6
October, is 02:00–06:00 UTC on 6 October — the UTC calendar date is already
`2026-10-06` for the entire demo. Running the pipeline at any point in that
window, with any `--days` value, therefore stops at Central midnight 6
October: it caps out at **5 October's** market day. 6 October is
structurally excluded, not just late — the earliest the pipeline could ever
include it is when UTC reaches `2026-10-07`, i.e. **2026-10-07 08:00 SGT**,
a full day after the demo ends.

`dayKey 20261005` doesn't have this problem: its data has been complete
since the afternoon of 4 October, and the pipeline's own arithmetic makes
it fetchable starting UTC `2026-10-06 00:00` — **2026-10-06 08:00 SGT**,
two hours before the demo even starts, and it stays fetchable throughout.
Because 5 October falls inside the same 17 Sep–6 Oct 2025 analog window
already used to calibrate both metrics' thresholds, none of the crossing
rates needed to change — only the specific-day analog citations did (now
$22.48/NO for `ERCOT_HBNORTH_DA_AVG`, +$3.74/NO for
`ERCOT_WEST_NORTH_DA_BASIS`, in each market's own section above).

**Post-hackathon improvement, not a pre-hackathon fix:** the cutoff could
be anchored to Central data availability instead of the UTC clock, which
would let a market like this resolve on the finale day itself. That change
is not happening before the hackathon — this arithmetic decides which
market days exist at all, and changing it now, this close to the
submission and demo dates, is exactly the kind of edit that should get its
own dedicated testing pass, not a same-week retrofit under time pressure.

## Caveats

- The seasonal window is 20 days from a single year — real and large
  enough to change a threshold recommendation (see the basis case), but
  not enough data to say more precisely than "roughly 50–65%," and it
  should be re-checked once a second year of data exists.
- All six base rates are historical, not predictive — same caveat as any
  metric in `shared/metrics.md`: this describes what has already happened
  under real ERCOT market conditions, not a guarantee about the specific
  dates above, which is what makes them real markets rather than reruns.
