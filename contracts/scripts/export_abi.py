#!/usr/bin/env python3
"""Export the frontend-facing ABI arrays from Foundry build artifacts."""

from __future__ import annotations

import json
from pathlib import Path


CONTRACT_NAMES = (
    "GridOracle",
    "BinaryMarket",
    "MarketFactory",
    "MockUSDT",
    "OutcomeToken",
)

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_ROOT = REPO_ROOT / "contracts" / "out"
ABI_ROOTS = (
    REPO_ROOT / "shared" / "abi",
    REPO_ROOT / "web" / "lib" / "abi",
)


def main() -> None:
    for abi_root in ABI_ROOTS:
        abi_root.mkdir(parents=True, exist_ok=True)

    for contract_name in CONTRACT_NAMES:
        artifact_path = ARTIFACT_ROOT / f"{contract_name}.sol" / f"{contract_name}.json"
        if not artifact_path.exists():
            raise SystemExit(f"Missing {artifact_path}. Run `forge build` first.")

        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        for abi_root in ABI_ROOTS:
            output_path = abi_root / f"{contract_name}.json"
            output_path.write_text(
                json.dumps(artifact["abi"], indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(f"Exported {output_path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
