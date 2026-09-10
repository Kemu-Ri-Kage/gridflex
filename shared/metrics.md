# GRIDFLEX metrics methodology

This document describes the two metrics GRIDFLEX contracts settle on, and
only those two. `ERCOT_HBWEST_NEG_INTERVALS` and `ERCOT_FUELMIX_<FUEL>` are
feed statistics produced by the same pipeline (see `README.md`) but are not
settlement data, so this document does not cover them beyond what's needed
to explain why they were excluded.

Everything below was checked against the actual implementation in
`fetch_ercot.py` and against real cached data as of 2026-09-10 — including
running the hash-reproduction steps by hand and confirming they match. Where
the code does something less clean than it sounds, that's written down as a
limitation rather than smoothed over.

**Revision note, 2026-09-10:** an earlier version of this document flagged
two real problems found during the same audit: `ERCOT_WEST_NORTH_DA_BASIS`'s
`sourceHash` covered only its `HB_WEST` leg, and the truncated `sourceFile`
label (`"N chunk(s): <first> .. <last>"`) didn't record enough to reproduce
a hash for runs with more than two chunks. Both are fixed in the current
`fetch_ercot.py`: `sourceFiles` is now the full ordered file list on every
metric record, and the basis hash is `sha256(hash_west + hash_north)`. The
fixes are verified below against regenerated metric files, not assumed from
reading the diff.

---

## Contract metric: `ERCOT_HBNORTH_DA_AVG`

**What it measures.** The mean of the 24 hourly day-ahead settlement point
prices at ERCOT hub `HB_NORTH` for one market day — i.e. the average
day-ahead price a generator or load at HB_NORTH cleared at that day.

**Dataset and settlement point.** GridStatus dataset
`ercot_spp_day_ahead_hourly`, filtered to `location = HB_NORTH`, price column
`spp`. Fetched and computed in `day_ahead_average()`.

**Unit and scaling.** Stored as a signed integer, USD/MWh × 100:
`value = round(mean_price * 100)`. A stored value of `4518` means
$45.18/MWh. The `hoursUsed` field on the metric record is always 24 for a
published value (see completeness below).

**Market day and why Central time.** ERCOT defines a market day as a
calendar day in Central Prevailing Time, not UTC. The fetch passes
`timezone="US/Central"` to the API so that `start`/`end` mean Central
midnights, and `to_central_day()` converts each row's `interval_start_utc`
to a Central calendar date before grouping. Grouping by UTC date instead
would cut every day at 00:00 UTC (6 or 7pm Central) and average across two
different ERCOT market days — a UTC-day average is not a number any ERCOT
participant would recognize.

**Completeness rule.** `day_ahead_average()` requires exactly 24 rows for a
given market day (`EXPECTED_ROWS["ercot_spp_day_ahead_hourly"] = 24`). If the
count is anything else, the day is skipped — no metric file is written, and
the skip is logged to stdout with the actual count. This is not a
tolerance band; it's an equality check. Two real cases this catches every
year: the fall-back DST day has 25 hourly rows, the spring-forward day has
23. Both are permanently unpublishable for this metric — there is no 24-hour
day-ahead average for a day that Central time doesn't have 24 hours of.

**Why a partial day is never averaged, even approximately.** A day-ahead
average settles a contract; a mean over 20 of 24 hours because 4 were
missing is a different, silently wrong number, and whoever is on the wrong
side of that contract is paying for a data gap they had no way to see. The
code enforces this by construction — there is no partial-average code path,
only "24 rows, or nothing gets written."

**A real edge case this rule does *not* catch:** the check is a row *count*,
not a check that all 24 distinct hours are present. If the upstream feed
ever returned, say, hour 3 twice and omitted hour 17, `len(group)` would
still be 24 and the day would pass as complete with a mean computed over the
wrong set of hours. This hasn't been observed, but the code doesn't rule it
out.

### Source hash and how to reproduce it by hand

Fetches are chunked into calendar-month pieces (`month_chunks()`), each
chunk cached to
`data/raw/ercot_spp_day_ahead_hourly__HB_NORTH__<chunk_start>__<chunk_end>.json`
as the exact JSON the API returned. For one invocation of the pipeline
(one `--days N` run), `fetch()` takes every chunk file it fetched or reused
for that run, in chronological order, and hashes their concatenated raw
bytes with SHA-256. That single hash — and, as of the fix, the **full
ordered list of every chunk file that went into it** — is then attached,
unchanged, to every day's metric file produced by that run. It is still a
hash of the whole pulled range, not of any individual day, but the metric
record now names exactly which files that range came from, in order.

Verified reproduction, using the regenerated metric file for 2026-09-09:

```
$ python3 -c "import json; print(json.load(open('data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-09.json'))['sourceFiles'])"
['ercot_spp_day_ahead_hourly__HB_NORTH__2025-09-10__2025-10-01.json', ... 13 files ..., 'ercot_spp_day_ahead_hourly__HB_NORTH__2026-09-01__2026-09-10.json']

$ cd data/raw && cat ercot_spp_day_ahead_hourly__HB_NORTH__2025-09-10__2025-10-01.json \
      ercot_spp_day_ahead_hourly__HB_NORTH__2025-10-01__2025-11-01.json \
      ... (the rest of sourceFiles, in the order given) ... \
      ercot_spp_day_ahead_hourly__HB_NORTH__2026-09-01__2026-09-10.json \
      | shasum -a 256
1b3ead66d0d30a6fdf6d479c4835c28ba5047c2ad6ebce37b1a2b88adbdd7c43  -
```

This matches the `sourceHash` recorded in
`data/metrics/ERCOT_HBNORTH_DA_AVG__2026-09-09.json` exactly (checked
programmatically against all 13 files, not by hand-typing a 13-line `cat`).

**Why this is a real fix and not cosmetic:** before it, the metric file said
`"13 chunk(s): <first>.json .. <last>.json"` — count and endpoints only. For
a run with more than two chunks that is not enough to know what to hash;
you had to separately know the exact `--days` value and run date to
recompute `month_chunks(start, end)` yourself. And `data/raw/` cannot
substitute for that list, because it accumulates chunk files from every run
ever made — different `--days` windows produce different, overlapping-but-
not-identical chunk boundaries in the same folder. Concatenating *every*
`ercot_spp_day_ahead_hourly__HB_NORTH__*.json` file present (the naive
reading of "hash the raw data for this dataset and location") still gives
the wrong answer:

```
$ cat $(ls data/raw/ercot_spp_day_ahead_hourly__HB_NORTH__*.json | sort) | shasum -a 256
5016105ed3b70a8634a39ff507c932d8c9f6a4155f9f65d98f65115d8e4d4aea  -
```

That does not match `1b3ead66...`. This is exactly why `sourceFiles` has to
be an explicit list rather than a glob pattern or a count-plus-endpoints
label — it's the only thing in the system that says, unambiguously, which
files a given value depends on.

**Known limitations, `ERCOT_HBNORTH_DA_AVG`:**
- DST transition days are permanently unpublishable (see above) — expect
  two missing days a year, always.
- `sourceHash` still commits to an entire run's pulled range, not to the
  individual day. The same day's value can carry a different `sourceHash`
  across two different pipeline runs, purely because the requested `--days`
  window produced different chunk boundaries — even though the underlying
  ERCOT data for that day didn't change. `sourceFiles` at least makes this
  provable instead of hidden: you can see the file sets differ.
- Completeness is row-count equality, not hour-identity verification (see
  edge case above).
- `fetch()` never re-fetches a chunk whose cache file already exists. If
  GridStatus or ERCOT later revises a settled day-ahead price, that
  revision is only picked up by deleting the specific cached chunk file
  first — nothing detects or flags a stale cache automatically.

---

## Contract metric: `ERCOT_WEST_NORTH_DA_BASIS`

**What it measures.** The day-ahead basis spread between two ERCOT hubs for
one market day: mean day-ahead price at `HB_WEST` minus mean day-ahead price
at `HB_NORTH`. Negative basis means West Texas cleared cheaper than North —
more wind/solar generation than the transmission out of the region can
carry. Positive basis means that congestion isn't binding, or has reversed.
This is the real-market analog of a congestion-rights spread.

**Dataset and settlement points.** Same dataset,
`ercot_spp_day_ahead_hourly`, read at two locations: `HB_WEST` (fetched
directly by this metric's own `fetch()` call, config block `BASIS`) and
`HB_NORTH` (**not re-fetched** — `basis_spread()` is called as
`basis_spread(df_west, df_da)`, reusing the DataFrame already fetched for
the `ERCOT_HBNORTH_DA_AVG` metric in the same run). Computed in
`basis_spread()`.

**Unit and scaling.** Signed integer, USD/MWh × 100:
`value = round((west_mean - north_mean) * 100)`. The metric record also
carries `westAvg` and `northAvg` as the raw (unscaled) daily means, rounded
to 2 decimals, for audit — these aren't used in settlement, just to let
someone sanity-check the subtraction without recomputing it.

**Market day and Central time.** Identical mechanism to
`ERCOT_HBNORTH_DA_AVG` — see above. Both legs are converted to Central
market days independently before being matched up by date.

**Completeness rule.** Each side is checked independently against the same
24-row requirement (`EXPECTED_ROWS["ercot_spp_day_ahead_hourly"]`):
`west_daily` and `north_daily` are each built only from days with exactly
24 rows on that side. The published set of days is the **intersection** of
the two (`set(west_daily) & set(north_daily)`) — so a day is skipped if
*either* hub's day-ahead feed was incomplete, even if the other hub's data
was perfectly fine. A DST transition day is skipped here too, for the same
reason as `ERCOT_HBNORTH_DA_AVG`, and independently on both legs.

**Why a partial day is never averaged.** Same reasoning as
`ERCOT_HBNORTH_DA_AVG`: a spread computed from a partial day on either side
is a different, wrong number, and the intersection rule exists specifically
so an incomplete West day can't get paired with a complete North day (or
vice versa) and published as if it meant something.

### Source hash and how to reproduce it by hand — both legs, combined

**This metric's hash previously covered only the HB_WEST leg**, even though
the value depends on both HB_WEST and HB_NORTH. That's fixed now: the hash
is `sha256(hash_west + hash_north)` — the two legs' own chunk-hashes,
concatenated as hex strings and hashed again — and `sourceFiles` lists all
26 chunk files (13 HB_WEST, then 13 HB_NORTH) that went into it.

Verified end to end against the regenerated metric file for 2026-09-09:

```
$ python3 -c "
import json, hashlib
from pathlib import Path

rec = json.loads(open('data/metrics/ERCOT_WEST_NORTH_DA_BASIS__2026-09-09.json').read())
files = rec['sourceFiles']
west_files  = [f for f in files if 'HB_WEST'  in f]
north_files = [f for f in files if 'HB_NORTH' in f]

def chunk_hash(names):
    d = hashlib.sha256()
    for n in names:
        d.update((Path('data/raw')/n).read_bytes())
    return d.hexdigest()

hash_w = chunk_hash(west_files)
hash_n = chunk_hash(north_files)
combined = hashlib.sha256((hash_w + hash_n).encode()).hexdigest()
print('combined :', combined)
print('recorded :', rec['sourceHash'])
"
combined : 4261d4f5a665594c0285008125b7fef07ff6b48db7f714929fff26f3cbf5e9d3
recorded : 4261d4f5a665594c0285008125b7fef07ff6b48db7f714929fff26f3cbf5e9d3
```

Match, and the two leg hashes are meaningful on their own too: `hash_w`
(`7290d279...`) is the same value that was previously (before the fix)
published as the metric's entire `sourceHash` — confirming the WEST-side
computation is unchanged — and `hash_n` (`1b3ead66...`) is exactly the
`sourceHash` currently published on that day's `ERCOT_HBNORTH_DA_AVG`
record, since both metrics fetch HB_NORTH the same way in the same run.

To verify a `ERCOT_WEST_NORTH_DA_BASIS` value by hand: split `sourceFiles`
by hub, hash each half in order, concatenate the two hex digests and hash
once more — if that matches `sourceHash`, both legs' raw data are accounted
for. Then recompute `round((westAvg - northAvg) * 100)` and check it equals
`value`. Unlike before the fix, a silent change to *either* leg's raw data
now changes the recorded hash — there's no longer a leg that can be
tampered with invisibly to this metric specifically.

**Known limitations, `ERCOT_WEST_NORTH_DA_BASIS`, beyond the shared ones
above:**
- The intersection-based completeness rule means a day can appear in
  `ERCOT_HBNORTH_DA_AVG` but not in `ERCOT_WEST_NORTH_DA_BASIS` (HB_WEST
  incomplete that day) or vice versa — the two contract metrics are not
  guaranteed to publish on the same set of days.
- Depends on two independently-fetched datasets instead of one. The hash
  now covers both, but a reader who only checks `westAvg`/`northAvg`
  against the record without re-deriving `sourceHash` from the raw chunks
  could still be misled by a tampered record — the fix makes the hash
  trustworthy, it doesn't make skipping the hash check safe.

---

## Shared limitations (both metrics)

- **Chunk cache keys are exact date strings, not calendar-aligned across
  runs.** `month_chunks()` starts its first chunk at the literal requested
  start date, not the 1st of that month. A `--days 90` run and a
  `--days 365` run whose windows overlap will each fetch their own,
  differently-bounded boundary chunk for the month where their windows
  begin — e.g. `HB_NORTH__2026-06-12__2026-07-01` (90-day run) and
  `HB_NORTH__2026-06-01__2026-07-01` (365-day run) both exist in
  `data/raw/` and both contain most of the same underlying rows, but are
  different cache entries with different filenames. This doesn't corrupt
  any computed value, but it does mean `data/raw/` is not a clean
  one-file-per-month-per-hub archive, and it's part of why naively hashing
  "everything for this hub" gives the wrong answer (demonstrated above).
- **No revision detection.** `fetch()` treats "the cache file exists" as
  "this data is final." Nothing compares a re-fetch to what's cached, so a
  later correction from ERCOT/GridStatus for an already-cached period is
  silently invisible unless someone manually deletes the affected cache
  file and re-runs.
- **Feed-only metrics are out of scope here on purpose.**
  `ERCOT_HBWEST_NEG_INTERVALS` sits at exactly zero on ~61% of days
  (documented in `README.md`, "Metric decision, 10 September") and was
  rejected as a contract metric for exactly that reason — it isn't held to
  contract-grade completeness scrutiny in this document because it doesn't
  settle anything. `ERCOT_FUELMIX_<FUEL>` uses a deliberately looser 95%
  coverage rule (`FUELMIX_MIN_COVERAGE`) because it's a display ratio, not
  a settlement number — see `fetch_ercot.py` for that rule, it's out of
  scope here for the same reason.
