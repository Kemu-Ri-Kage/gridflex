# GRIDFLEX metrics methodology

`fetch_ercot.py` produces four metrics. **Two are contract metrics** — the
only two things GRIDFLEX markets settle against — **and two are feed data**:
published, shown on the site, never used to resolve a market.

| metricId | Status |
|---|---|
| `ERCOT_HBNORTH_DA_AVG` | **Contract** |
| `ERCOT_WEST_NORTH_DA_BASIS` | **Contract** |
| `ERCOT_LOAD_WEIGHTED_DA_INDEX` | Feed only. A contract on this is the next listing after the hackathon, not part of the MVP. |
| `ERCOT_HBWEST_NEG_INTERVALS` | Feed only. Rejected as a contract metric — sits at zero on ~61% of days, so no threshold gives a genuinely uncertain question. |
| `ERCOT_FUELMIX_<FUEL>` | Feed only, display ratio. Covered only briefly here — see "Out of scope" below. |

Everything below was checked against the actual implementation in
`fetch_ercot.py` and against real, regenerated metric files as of
2026-09-10 — including running the hash-reproduction and schema checks by
hand and confirming they match. Where the code does something less clean
than it sounds, that's written down as a limitation rather than smoothed
over.

**Methodology changelog:**
- **2026-09-10, sourceHash fix:** `ERCOT_WEST_NORTH_DA_BASIS`'s `sourceHash`
  used to cover only its `HB_WEST` leg; fixed to `sha256(hash_west +
  hash_north)`. `sourceFile` used to be a truncated `"N chunk(s): <first>
  .. <last>"` label; fixed to `sourceFiles`, the full ordered file list.
- **2026-09-10, schema fix (this revision):** `periodStart`/`periodEnd` are
  removed entirely, replaced by `dayKey`/`marketDay`/`marketDayStartUtc`/
  `marketDayEndUtc`. See "Metric file schema" below for why.

---

## Metric file schema (all four metrics)

Every metric file, regardless of which of the four metrics it's for, has
this shape:

```json
{
  "metricId": "ERCOT_HBNORTH_DA_AVG",
  "dayKey": 20260908,
  "marketDay": "2026-09-08",
  "marketDayStartUtc": 1788843600,
  "marketDayEndUtc": 1788930000,
  "value": 3957,
  "sourceHash": "75999d01...",
  "sourceFiles": ["ercot_spp_day_ahead_hourly__HB_NORTH__2026-06-12__2026-07-01.json", "..."],
  "hashAlgorithm": "sha256",
  "computedAt": "2026-09-10T16:49:17.976165+00:00"
}
```

(Real example: `data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-08.json`.)
Plus metric-specific extras — `hoursUsed`, `westAvg`/`northAvg`,
`intervalsUsed`, `loadWeights` — covered in each metric's section below.

### Why there's no `periodStart`/`periodEnd`, and never will be again

The previous schema stored `periodStart` as midnight UTC of the Central
calendar date: `datetime.combine(day, time.min, tzinfo=utc).timestamp()`.
That is **not the same instant as Central midnight**. For the market day 8
September 2026, `periodStart` was `2026-09-08 00:00 UTC` — which converts
back to `2026-09-07 19:00` in Central time. Anything that took
`periodStart` and converted it to Central time to find out what day it was
would get 7 September, not 8 September. In a system that settles money on
a specific day, that's a one-day error waiting to happen, and it's not a
theoretical risk — it's what the field literally did on every single row.
`periodEnd` had the same problem, plus a second one: it was always
`periodStart + 86400`, which is wrong on both DST transition days (see
below).

**The fix separates "which day is this" from "what instant is that":**

- **`dayKey`** — `uint32`, `YYYYMMDD` (`day_key()` in `fetch_ercot.py`),
  e.g. `20260908`. This is the identifier the oracle stores and markets
  look up. It is not a timestamp and carries no timezone, so there is
  nothing to convert and therefore nothing that can shift by a day. Python
  and Solidity read it identically because it's just an integer — parsing
  it back into a date is string slicing, not timezone arithmetic.
- **`marketDay`** — the ISO date string (`"2026-09-08"`), for humans reading
  the file.
- **`marketDayStartUtc` / `marketDayEndUtc`** — the *true* UTC unix
  timestamps of Central midnight to Central midnight, computed by
  `day_bounds_from_df()` from the actual `interval_start_utc` /
  `interval_end_utc` values GridStatus returned for that day's rows — not
  assumed as a fixed 86400-second span. Verified against the real,
  regenerated file for 2026-09-08:

  ```
  $ python3 -c "
  import pandas as pd
  print(pd.Timestamp(1788843600, unit='s', tz='UTC').tz_convert('US/Central'))
  print(pd.Timestamp(1788930000, unit='s', tz='UTC').tz_convert('US/Central'))
  "
  2026-09-08 00:00:00-05:00
  2026-09-09 00:00:00-05:00
  ```

  Exactly Central midnight to Central midnight, and `marketDayStartUtc`
  converted to Central lands on the same date (`2026-09-08`) that `dayKey`
  (`20260908`) encodes — the specific property the old scheme broke.

Because `marketDayStartUtc`/`marketDayEndUtc` come from real interval
boundaries rather than an assumed offset, they are correct on DST
transition days too: `end_utc - start_utc` is 23 hours on the
spring-forward day and 25 on the fall-back day, not 24. In practice this
never shows up in a published contract-metric file, because both DST days
fail the completeness check and are skipped entirely (see "Known
limitation: DST days" below) — but the bounds-computation function itself
is correct on those days regardless, which is what
`tests/test_market_day.py` proves directly, independent of whether the day
ends up published.

**`tests/test_market_day.py`** (`python3 -m unittest tests.test_market_day
-v`, 7 tests, all passing) proves, against synthetic data shaped like the
real feed:
1. `dayKey` round-trips to the same calendar date with zero timezone
   conversion, for ordinary dates and both DST transition dates.
2. `marketDayStartUtc`, converted to Central time, lands on the exact same
   calendar date that `dayKey` encodes — for an ordinary day and both DST
   transition days.
3. A spring-forward day's `marketDayEndUtc - marketDayStartUtc` is exactly
   23 hours; a fall-back day's is exactly 25 — not 24 in either case.
4. The old bug is actually gone: the old (wrong) `periodStart` value for 8
   September 2026 converts to Central as 7 September, and the new
   `marketDayStartUtc` is demonstrably not that value.

### Hash mechanism (unchanged by the schema fix)

`sourceHash` is SHA-256 over the raw bytes of every chunk file the metric's
computation depended on, concatenated in the order listed in
`sourceFiles`. For a metric derived from a single dataset+location (e.g.
`ERCOT_HBNORTH_DA_AVG`), that's one `fetch()` call's chunks. For a
metric derived from more than one dataset or location (`ERCOT_WEST_NORTH_DA_BASIS`,
`ERCOT_LOAD_WEIGHTED_DA_INDEX`), the leg hashes are combined —
`sha256(hash_a + hash_b + ...)` — and `sourceFiles` lists every leg's
files, so no leg's raw data can change without changing the recorded hash.
See each metric's section for a verified, real reproduction.

**Reproduction pitfall, still true:** `data/raw/` accumulates chunk files
from every run ever made, with different `--days` windows producing
different, overlapping-but-not-identical chunk boundaries in the same
folder. Always hash exactly the files listed in a metric's own
`sourceFiles`, in order — never glob `<dataset>__<location>__*.json` and
hash "everything for this hub," which gives a different (wrong) hash. This
was demonstrated directly in an earlier revision of this document; the
mechanics haven't changed.

---

## Contract metric: `ERCOT_HBNORTH_DA_AVG`

**What it measures.** The mean of the 24 hourly day-ahead settlement point
prices at ERCOT hub `HB_NORTH` for one market day.

**Dataset and settlement point.** GridStatus dataset
`ercot_spp_day_ahead_hourly`, filtered to `location = HB_NORTH`, price
column `spp`. Computed in `day_ahead_average()`.

**Unit and scaling.** Signed integer, USD/MWh × 100:
`value = round(mean_price * 100)`. `3957` means $39.57/MWh. `hoursUsed` is
always 24 for a published value.

**Market day and why Central time.** ERCOT defines a market day as a
Central Prevailing Time calendar day, not UTC. `timezone="US/Central"` is
passed to the API so `start`/`end` mean Central midnights, and
`to_central_day()` converts each row's `interval_start_utc` to a Central
calendar date before grouping. Grouping by UTC date would cut every day at
00:00 UTC (6 or 7pm Central) and average across two different ERCOT market
days.

**Completeness rule.** Exactly 24 rows required
(`EXPECTED_ROWS["ercot_spp_day_ahead_hourly"] = 24`) — an equality check,
not a tolerance band. Any other count and the day is skipped, logged to
stdout, no metric file written. This permanently excludes the two DST
transition days every year (25 rows on fall-back, 23 on spring-forward) —
see "Known limitation: DST days," below.

**Why a partial day is never averaged.** A mean over 20 of 24 hours because
4 were missing is a different, silently wrong number, and whoever is on the
wrong side of a contract settled on it is paying for a data gap they had no
way to see. There is no partial-average code path — only "24 rows, or
nothing gets written."

**A real edge case the rule doesn't catch:** completeness is a row *count*,
not a check that all 24 distinct hours are present. If the feed ever
returned hour 3 twice and omitted hour 17, `len(group)` would still be 24
and the day would pass with a mean computed over the wrong hours. Not
observed, but the code doesn't rule it out.

**Source hash — verified reproduction**, current file
`data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-08.json`:

```
$ cd data/raw && cat ercot_spp_day_ahead_hourly__HB_NORTH__2026-06-12__2026-07-01.json \
      ercot_spp_day_ahead_hourly__HB_NORTH__2026-07-01__2026-08-01.json \
      ercot_spp_day_ahead_hourly__HB_NORTH__2026-08-01__2026-09-01.json \
      ercot_spp_day_ahead_hourly__HB_NORTH__2026-09-01__2026-09-10.json \
      | shasum -a 256
75999d0173983de904ad23e09e4b2de1536fa0929e23ae4700359d53593913c4  -
```

Matches `sourceHash` exactly. This is the file's actual `sourceFiles` list,
in order — not a subset or a glob.

**Known limitations, `ERCOT_HBNORTH_DA_AVG`:**
- DST transition days are permanently unpublishable — see below.
- `sourceHash` commits to an entire `fetch()` call's pulled range, not the
  individual day; the same day's value can carry a different `sourceHash`
  across two pipeline runs with different `--days` windows, purely from
  different chunk boundaries. `sourceFiles` makes this provable (you can
  see the file sets differ) rather than hidden.
- Completeness is row-count equality, not hour-identity verification (edge
  case above).
- `fetch()` never re-fetches a chunk whose cache file already exists — a
  later ERCOT/GridStatus revision to an already-cached period is invisible
  unless someone manually deletes the affected cache file and re-runs.

---

## Contract metric: `ERCOT_WEST_NORTH_DA_BASIS`

**What it measures.** Day-ahead basis spread: mean day-ahead price at
`HB_WEST` minus mean day-ahead price at `HB_NORTH`, per market day.
Negative means West Texas cleared cheaper than North (more wind/solar than
the transmission out of the region can carry); positive means that
congestion isn't binding or has reversed. Real-market analog: a congestion
rights spread.

**Dataset and settlement points.** `ercot_spp_day_ahead_hourly` at two
locations: `HB_WEST` (own `fetch()` call) and `HB_NORTH` (reused from the
`ERCOT_HBNORTH_DA_AVG` fetch in the same run — not re-fetched). Computed in
`basis_spread()`.

**Unit and scaling.** Signed integer, USD/MWh × 100:
`value = round((west_mean - north_mean) * 100)`. `westAvg`/`northAvg`
(raw, 2-decimal) are carried for audit, not used in settlement.

**Market day and Central time.** Same mechanism as `ERCOT_HBNORTH_DA_AVG`.
`marketDayStartUtc`/`marketDayEndUtc` are computed from the `HB_NORTH` leg
(`basis_spread(df_west, df_north)` uses `day_bounds_from_df(df_north)`),
since both hubs share the same hourly grid and should agree.

**Completeness rule.** Each side independently requires exactly 24 rows;
the published day set is the **intersection**
(`set(west_daily) & set(north_daily)`) — a day is skipped if *either* hub's
feed was incomplete, even if the other was fine. Both DST days are skipped
here too, independently on each leg.

**Why a partial day is never averaged.** Same reasoning as
`ERCOT_HBNORTH_DA_AVG` — the intersection rule specifically prevents an
incomplete West day from pairing with a complete North day (or vice versa)
and publishing as if it meant something.

**Source hash — both legs, combined.** `sourceHash =
sha256(hash_west + hash_north)`; `sourceFiles` lists both legs' chunks (West
first, then North). Verified end to end against the current file
`data/metrics/ERCOT_WEST_NORTH_DA_BASIS__2026-09-08.json`:

```
$ python3 -c "
import json, hashlib
from pathlib import Path
rec = json.loads(open('data/metrics/ERCOT_WEST_NORTH_DA_BASIS__2026-09-08.json').read())
files = rec['sourceFiles']
west = [f for f in files if 'HB_WEST' in f]
north = [f for f in files if 'HB_NORTH' in f]
def h(names):
    d = hashlib.sha256()
    for n in names: d.update((Path('data/raw')/n).read_bytes())
    return d.hexdigest()
hash_w, hash_n = h(west), h(north)
print(hashlib.sha256((hash_w + hash_n).encode()).hexdigest())
print(rec['sourceHash'])
"
cf1d4eef3bb74d65150876b090197cd41c00c74c3ed1f02a5b7a909f3d821df0
cf1d4eef3bb74d65150876b090197cd41c00c74c3ed1f02a5b7a909f3d821df0
```

Match. `hash_w` (`dd903acd...`) and `hash_n` (`75999d01...`) are each
independently meaningful too: `hash_n` is exactly the `sourceHash` on that
day's `ERCOT_HBNORTH_DA_AVG` file, since both fetch `HB_NORTH` the same way
in the same run. A silent change to *either* leg's raw data changes the
combined hash — there's no leg that can be tampered with invisibly to this
metric.

**Known limitations, `ERCOT_WEST_NORTH_DA_BASIS`:**
- The intersection-based completeness rule means this metric and
  `ERCOT_HBNORTH_DA_AVG` aren't guaranteed to publish on the same set of
  days.
- Depends on two independently-fetched datasets. The hash covers both now,
  but a reader who only checks `westAvg`/`northAvg` against the record
  without re-deriving `sourceHash` from the raw chunks could still be
  misled by a tampered record — the fix makes the hash trustworthy, it
  doesn't make skipping the hash check safe.

---

## Feed metric: `ERCOT_LOAD_WEIGHTED_DA_INDEX`

**Status: feed only.** Published and shown on the site; not a settlement
metric in the MVP. A contract on this metric is the next listing after the
hackathon — see `CLAUDE.md`.

**What it measures.** "What did Texas actually pay for power today" — total
cost divided by total volume across four load zones:
`sum(price × load) / sum(load)`, hour by hour, summed over the day. This
weights by real consumption in both space and time (Houston's afternoon
peak counts more than a 4am hour with less load moving), constructed from
ERCOT's own hourly load rather than a hardcoded population/consumption
table.

**Dataset and settlement points.** Prices from `ercot_spp_day_ahead_hourly`
at four **load zones** (`LZ_NORTH`, `LZ_SOUTH`, `LZ_WEST`, `LZ_HOUSTON` —
not trading hubs, because load zones are where consumption is metered and
settles), weighted by `ercot_load_by_forecast_zone`. Computed in
`load_weighted_index()`.

**Unit and scaling.** Signed integer, USD/MWh × 100. `loadWeights` records
each zone's realized share of that day's total volume (e.g.
`{"north": 0.3549, "south": 0.2669, "west": 0.1391, "houston": 0.2392}`),
so the weighting can be checked after the fact rather than trusted blind.

**Market day and Central time.** Same mechanism as the contract metrics.
`marketDayStartUtc`/`marketDayEndUtc` are computed from the load dataset
(`day_bounds_from_df(df_load)`), since load is hourly and fetched once,
shared across all four zone computations.

**Completeness rule.** An hour only counts if *all four* zones have both a
price and a load figure (`set(zone_prices) == set(zones.values())` and
same for load) — a missing zone is dropped rather than reweighted across
the rest, because silently reweighting biases the index toward whoever is
left. The published day set requires 24 such complete hours
(`hoursUsed == 24`); any other count is skipped, same equality-check
philosophy as the contract metrics, even though this metric doesn't settle
anything.

**Source hash — five inputs, combined.** `sourceHash` covers all four zone
price fetches plus the load fetch: `sha256(hash_z1 + hash_z2 + hash_z3 +
hash_z4 + hash_load)`, in the fixed order the zones are iterated. Real
example, `data/metrics/ERCOT_LOAD_WEIGHTED_DA_INDEX__2026-09-08.json`: 20
`sourceFiles` (4 zones × 4 chunks + 4 load chunks, for the 90-day run that
produced it). Not hand-verified line-by-line here the way the two contract
metrics were — same mechanism as `ERCOT_WEST_NORTH_DA_BASIS`, just five
legs instead of two — but the combining code is the same code path, already
verified for BASIS.

**Known limitations, `ERCOT_LOAD_WEIGHTED_DA_INDEX`:**
- Five independently-fetched datasets instead of one or two — the largest
  surface of any GRIDFLEX metric for a chunk to go missing or be
  individually stale.
- `normalise_load()` auto-detects whether the load feed is "wide" (one
  column per zone) or "long" (a zone column + value column) and raises if
  it's neither — a defensive check, but it means a genuine GridStatus
  schema change surfaces as a hard crash on the next `--days` run rather
  than a silent bad number, which is the intended tradeoff but is still a
  fragility worth knowing about before depending on this metric more
  heavily post-hackathon.
- Not currently a contract metric, so its completeness and hash guarantees
  have not been under the same adversarial scrutiny as the two that settle
  money — worth re-auditing to the same standard before it becomes one.

---

## Feed metric: `ERCOT_HBWEST_NEG_INTERVALS`

**Status: feed only, and staying that way.** This was the original
candidate second contract metric; a year of data ruled it out (see
`README.md`, "Metric decision"). Kept as a published feed statistic because
it's still informative about West Texas curtailment, just not tradeable.

**What it measures.** Count of 15-minute real-time intervals at `HB_WEST`
where the settlement price was negative, per market day (0–96).

**Dataset and settlement point.** `ercot_spp_real_time_15_min`, filtered to
`HB_WEST`, price column `spp`. Computed in `negative_intervals()`.

**Unit and scaling.** Plain integer count, no scaling.

**Market day and Central time.** Same mechanism as the contract metrics.

**Completeness rule.** Exactly 96 fifteen-minute rows required
(`EXPECTED_ROWS["ercot_spp_real_time_15_min"] = 96`) — same equality-check
philosophy as the contract metrics, even though nothing settles on this
number. Both DST days are excluded here too (92 or 100 intervals instead of
96).

**Why it was rejected as a contract metric.** `analyse_metrics.py` over a
full year: the value sits at exactly zero on ~61% of days. Every candidate
threshold from p10 through p50 collapses to the same 0-vs-nonzero split —
there's no threshold that produces a genuinely uncertain YES/NO question.
`ERCOT_WEST_NORTH_DA_BASIS` was built specifically as the tradeable
replacement, measuring the same underlying West Texas congestion.

**Source hash.** Single dataset, single location — same mechanism as
`ERCOT_HBNORTH_DA_AVG` (one `fetch()` call's chunks, hashed in order).

**Known limitations, `ERCOT_HBWEST_NEG_INTERVALS`:**
- 61% zero-inflation, by design, is exactly why this isn't a contract
  metric — noted here so nobody re-proposes it without re-running
  `analyse_metrics.py` first.
- Completeness is row-count equality, same hour-identity caveat as
  `ERCOT_HBNORTH_DA_AVG`.

---

## Out of scope: `ERCOT_FUELMIX_<FUEL>`

Feed-only display ratios (share of generation by fuel type), computed in
`fuel_shares()`. Deliberately not covered at contract-metric depth in this
document because it isn't a settlement candidate and uses a different,
looser completeness rule on purpose: `FUELMIX_MIN_COVERAGE = 0.95` (at
least 95% of the expected 288 five-minute readings, not 100%) — because
these are display ratios, not numbers anyone gets paid on, so one missing
5-minute reading out of 288 is immaterial in a way it would not be for a
contract metric. See `fetch_ercot.py` for the exact rule.

---

## Known limitation: DST changeover days can never settle a contract

Both `ERCOT_HBNORTH_DA_AVG` and `ERCOT_WEST_NORTH_DA_BASIS` require exactly
24 hourly rows for a market day. The two US DST transition days each year
never have 24: the spring-forward day has 23 (Central time skips an hour),
the fall-back day has 25 (Central time repeats one). Both fail the
completeness check, are skipped, and get no metric file — permanently, not
just until the pipeline is fixed. This is true for both contract metrics
independently, and for `ERCOT_HBWEST_NEG_INTERVALS` on its own 96-interval
equivalent.

**This is stated as a known limitation, not a bug.** The alternative —
averaging over 23 or 25 hours and calling it a normal day's value — is
exactly the kind of silently-wrong settlement number the completeness rule
exists to prevent. A market listed to resolve on a DST transition day
simply has no data to resolve against; don't schedule a market's `dayKey`
to be a DST changeover date. `data/metrics/` confirms this in practice —
no `ERCOT_HBNORTH_DA_AVG` or `ERCOT_WEST_NORTH_DA_BASIS` file exists for
`2025-11-02` or `2026-03-08`, the two DST days in the currently-fetched
year of data.

---

## Shared limitations (chunk caching, all metrics)

- **Chunk cache keys are exact date strings, not calendar-aligned across
  runs.** `month_chunks()` starts its first chunk at the literal requested
  start date, not the 1st of that month. Two runs with different `--days`
  windows produce different, overlapping-but-not-identical chunk boundaries
  for the month where their windows begin, both sitting in `data/raw/` at
  once. This doesn't corrupt any computed value, but it's why
  `sourceFiles` must be read as an explicit list, never a glob.
- **No revision detection.** `fetch()` treats "the cache file exists" as
  "this data is final." A later correction from ERCOT/GridStatus for an
  already-cached period is silently invisible unless someone manually
  deletes the affected cache file and re-runs.
