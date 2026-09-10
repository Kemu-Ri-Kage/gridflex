"""
GRIDFLEX — metric analysis
==========================

Reads everything in data/metrics/ and reports what each metric would look like
as a tradeable contract. This is how the HB_WEST question gets decided: not by
argument, but by looking at a year of real ERCOT data.

The test a metric has to pass: if you wrote a YES/NO question on it, would the
answer be genuinely uncertain? A metric that resolves the same way 90% of the
time is not a market — it is a coin that always lands heads, and nobody takes
the other side.

Usage:
    python analyse_metrics.py
    python analyse_metrics.py --metric ERCOT_WEST_NORTH_DA_BASIS
"""

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

METRICS_DIR = Path("data/metrics")

# How the value is stored vs how it reads to a human
SCALES = {
    "ERCOT_HBNORTH_DA_AVG":        (100, "$/MWh"),
    "ERCOT_WEST_NORTH_DA_BASIS":   (100, "$/MWh"),
    "ERCOT_HBWEST_NEG_INTERVALS":  (1,   "intervals"),
}


def load():
    """Load every metric file into one tidy DataFrame."""
    rows = []
    for path in sorted(METRICS_DIR.glob("*.json")):
        rec = json.loads(path.read_text())
        rows.append({
            "metricId": rec["metricId"],
            "day": datetime.fromtimestamp(rec["periodStart"], timezone.utc).date(),
            "value": rec["value"],
        })
    if not rows:
        raise SystemExit(
            f"No metric files in {METRICS_DIR}/.\n"
            "Run:  python fetch_ercot.py --days 365   first."
        )
    return pd.DataFrame(rows)


def describe(metric_id, series):
    """Print the distribution and, more importantly, the tradeability."""
    scale, unit = SCALES.get(metric_id, (1, ""))
    v = series / scale

    print(f"\n{'=' * 66}")
    print(f"{metric_id}   ({len(v)} days, {unit})")
    print("=" * 66)
    print(f"  min {v.min():>10.2f}    p10 {v.quantile(.10):>8.2f}    "
          f"median {v.median():>8.2f}")
    print(f"  max {v.max():>10.2f}    p90 {v.quantile(.90):>8.2f}    "
          f"mean   {v.mean():>8.2f}")
    print(f"  std {v.std():>10.2f}    days at exactly zero: "
          f"{int((series == 0).sum())} ({(series == 0).mean():.0%})")

    # A threshold contract is only interesting if YES and NO are both live.
    # The median is the fairest threshold by construction, so test a few
    # candidates around it and see how balanced the outcomes are.
    print("\n  If you listed 'will it exceed X?', how often does YES win:")
    best = None
    for q in (0.25, 0.40, 0.50, 0.60, 0.75):
        threshold = v.quantile(q)
        yes_rate = (v > threshold).mean()
        balance = abs(yes_rate - 0.5)
        flag = ""
        if best is None or balance < best[0]:
            best = (balance, threshold, yes_rate)
        if yes_rate in (0.0, 1.0):
            flag = "   <- dead market, never resolves both ways"
        print(f"    X = {threshold:>8.2f}  ->  YES {yes_rate:>5.0%}"
              f"   NO {1 - yes_rate:>5.0%}{flag}")

    balance, threshold, yes_rate = best

    # A balanced-looking ratio is not enough. If the metric piles up on one
    # value, every candidate threshold collapses to the same split and you
    # cannot tune the question at all — the market has one possible price and
    # everyone already knows it. Catch that before calling anything tradeable.
    modal_share = series.value_counts(normalize=True).iloc[0]
    distinct = v.quantile([.25, .40, .50, .60, .75]).nunique()

    if modal_share > 0.40:
        verdict = (f"NOT TRADEABLE - {modal_share:.0%} of days share one value; "
                   f"you cannot write a question with an uncertain answer")
    elif distinct < 3:
        verdict = ("NOT TRADEABLE - thresholds collapse; too few distinct "
                   "values to tune the question")
    elif balance < 0.15:
        verdict = "TRADEABLE"
    elif balance < 0.30:
        verdict = "MARGINAL"
    else:
        verdict = "NOT TRADEABLE - too one-sided"

    print(f"\n  Most balanced threshold: {threshold:.2f} "
          f"({yes_rate:.0%} YES)")
    print(f"  Verdict: {verdict}")

    # Movement matters too: a metric that barely changes gives traders
    # nothing to update on between listing and resolution.
    if len(v) > 2:
        daily_change = v.diff().abs().median()
        print(f"  Median day-to-day move: {daily_change:.2f} {unit}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metric", help="analyse just one metricId")
    args = ap.parse_args()

    df = load()
    df = df[~df["metricId"].str.startswith("ERCOT_FUELMIX_")]  # feed only

    metrics = [args.metric] if args.metric else sorted(df["metricId"].unique())
    for metric_id in metrics:
        sub = df[df["metricId"] == metric_id].sort_values("day")
        if sub.empty:
            print(f"\n{metric_id}: no data")
            continue
        describe(metric_id, sub["value"].reset_index(drop=True))

    print(f"\n{'=' * 66}")
    print("Pick the metric whose most balanced threshold sits closest to 50/50")
    print("and which moves enough day to day to be worth trading.")
    print("=" * 66)


if __name__ == "__main__":
    main()
