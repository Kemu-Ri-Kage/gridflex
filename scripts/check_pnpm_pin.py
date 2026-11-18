#!/usr/bin/env python3
"""The deploy job's pnpm comes from web/package.json's packageManager field
(audit finding S13). Check that the field is an exact pnpm version and that
web/pnpm-lock.yaml is a lockfile that pnpm major writes."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# pnpm major -> the lockfileVersion it writes.
LOCKFILE_FOR_MAJOR = {9: "9.0", 10: "9.0", 11: "9.0", 12: "9.0"}


def check(root: Path = ROOT) -> str:
    manager = json.loads((root / "web" / "package.json").read_text()).get("packageManager", "")
    match = re.fullmatch(r"pnpm@(\d+)\.(\d+)\.(\d+)(\+sha\d+\.[0-9a-f]+)?", manager)
    if not match:
        raise ValueError(f"web/package.json packageManager must be an exact pnpm version, got {manager!r}")
    major = int(match.group(1))
    head = (root / "web" / "pnpm-lock.yaml").read_text().splitlines()[0]
    lock = re.fullmatch(r"lockfileVersion: '([0-9.]+)'", head)
    if not lock:
        raise ValueError(f"web/pnpm-lock.yaml has no lockfileVersion line: {head!r}")
    if LOCKFILE_FOR_MAJOR.get(major) != lock.group(1):
        raise ValueError(f"{manager} does not write lockfileVersion {lock.group(1)}")
    return manager


if __name__ == "__main__":
    try:
        print(f"pnpm pin OK: {check()} matches web/pnpm-lock.yaml")
    except (OSError, ValueError) as exc:
        print(f"pnpm pin: {exc}", file=sys.stderr)
        raise SystemExit(1)
