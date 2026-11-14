#!/usr/bin/env python3
"""Add the next market days' ladder rows to shared/demo-markets.md, so the
daily settle job can create them (create_markets.py --market N --live --yes).

Each new day gets three Texas power price strikes (ERCOT_HBNORTH_DA_AVG),
live kind, closing 12:30 Texas time the day before, the same as rows 39-59.
A day is added only when it has no market yet, isn't a daylight-saving
changeover day (those can't settle, shared/metrics.md), and its trading
close is at least MIN_LEAD_SECONDS away, so createMarket can't race it.

Strikes: SETTLE_LADDER_STRIKES ("30,40,50", whole dollars) when set.
Otherwise centred on the mean of the last RECENT_DAYS committed daily
prices, rounded to the nearest $5, at -$10, the centre and +$10 (never below
$5). Rows 39-59 were chosen the same way by hand: strikes that split
outcomes rather than all settling one side.

Prints the new row numbers, one per line, and nothing else on stdout.
--dry-run prints the rows it would add without writing the file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from create_markets import format_close, live_trading_close  # noqa: E402
from settle_due import day_key, is_dst_changeover  # noqa: E402

DEMO_MARKETS = ROOT / "shared" / "demo-markets.md"
METRICS_DIR = ROOT / "data" / "metrics"
METRIC = "ERCOT_HBNORTH_DA_AVG"
HEADING = "## Summary table"

LADDER_DAYS = 7            # keep markets listed this many days ahead
MIN_LEAD_SECONDS = 3600    # never add a day whose close is under an hour away
RECENT_DAYS = 7
STRIKE_STEP_DOLLARS = 10
DEFAULT_STRIKES = (30, 40, 50)


def table_rows(text: str) -> tuple[list[str], int]:
    """The Summary table's data lines and the index of the last one."""
    lines = text.splitlines()
    start = lines.index(HEADING)
    rows, last = [], None
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells and cells[0].isdigit():
                rows.append(line)
                last = i
        elif rows:
            break
    if last is None:
        raise SystemExit(f"{DEMO_MARKETS}: no rows found under '{HEADING}'")
    return rows, last


def existing_days(rows: list[str]) -> set[int]:
    days = set()
    for row in rows:
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if cells[1].strip("`") == METRIC:
            days.add(int(cells[3].strip("`")))
    return days


def recent_strikes(today: date) -> tuple[int, ...]:
    override = os.environ.get("SETTLE_LADDER_STRIKES", "").strip()
    if override:
        return tuple(int(s) for s in override.split(","))
    values = []
    for i in range(1, 31):
        path = METRICS_DIR / f"{METRIC}__{(today - timedelta(days=i)).isoformat()}.json"
        if path.exists():
            values.append(json.loads(path.read_text(encoding="utf-8"))["value"] / 100)
        if len(values) == RECENT_DAYS:
            break
    if not values:
        return DEFAULT_STRIKES
    centre = max(5 + STRIKE_STEP_DOLLARS, int(round(sum(values) / len(values) / 5) * 5))
    return (centre - STRIKE_STEP_DOLLARS, centre, centre + STRIKE_STEP_DOLLARS)


def new_rows(rows: list[str], now: int, strikes: tuple[int, ...]) -> list[str]:
    today = datetime.fromtimestamp(now, timezone.utc).date()
    have = existing_days(rows)
    number = max(int(r.strip().strip("|").split("|")[0]) for r in rows)
    out = []
    for offset in range(1, LADDER_DAYS + 1):
        day = today + timedelta(days=offset)
        key = day_key(day)
        if key in have or is_dst_changeover(day):
            continue
        close = live_trading_close(key)
        if close - now < MIN_LEAD_SECONDS:
            continue
        for strike in strikes:
            number += 1
            out.append(f"| {number} | `{METRIC}` | > ${strike} | `{key}` | {day.isoformat()} | live | "
                       f"{format_close(close)} |")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the rows, don't write the file")
    args = parser.parse_args(argv)

    text = DEMO_MARKETS.read_text(encoding="utf-8")
    rows, last = table_rows(text)
    now = int(time.time())
    strikes = recent_strikes(datetime.fromtimestamp(now, timezone.utc).date())
    added = new_rows(rows, now, strikes)
    if added:
        print(f"extend_ladder: {len(added)} row(s) at strikes {', '.join(f'${s}' for s in strikes)}",
              file=sys.stderr)
        if not args.dry_run:
            lines = text.splitlines()
            lines[last + 1:last + 1] = added
            DEMO_MARKETS.write_text("\n".join(lines) + ("\n" if text.endswith("\n") else ""),
                                    encoding="utf-8")
    for row in added:
        print(row.strip().strip("|").split("|")[0].strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
