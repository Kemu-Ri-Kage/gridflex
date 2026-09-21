#!/usr/bin/env python3
"""Guard the frozen pipeline/oracle ABI and the market's signed dayKey terms."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ABI_DIR = ROOT / "shared" / "abi"


def load(name: str) -> list[dict]:
    return json.loads((ABI_DIR / f"{name}.json").read_text(encoding="utf-8"))


def find(abi: list[dict], item_type: str, name: str | None = None) -> dict:
    matches = [
        item
        for item in abi
        if item.get("type") == item_type and (name is None or item.get("name") == name)
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected one {item_type} {name or ''}, found {len(matches)}")
    return matches[0]


def types(items: list[dict]) -> list[str]:
    return [item["type"] for item in items]


def main() -> None:
    oracle = load("GridOracle")
    market = load("BinaryMarket")
    factory = load("MarketFactory")

    submit = find(oracle, "function", "submitReading")
    assert types(submit["inputs"]) == ["bytes32", "uint32", "uint64", "uint64", "int256", "bytes32"]

    finalize = find(oracle, "function", "finalize")
    assert types(finalize["inputs"]) == ["bytes32", "uint32"]
    is_final = find(oracle, "function", "isFinal")
    assert types(is_final["inputs"]) == ["bytes32", "uint32"]
    assert types(is_final["outputs"]) == ["bool"]

    reading = find(oracle, "function", "getReading")["outputs"][0]["components"]
    assert [(field["name"], field["type"]) for field in reading] == [
        ("metricId", "bytes32"),
        ("dayKey", "uint32"),
        ("marketDayStartUtc", "uint64"),
        ("marketDayEndUtc", "uint64"),
        ("value", "int256"),
        ("sourceHash", "bytes32"),
        ("publishedAt", "uint64"),
        ("finalized", "bool"),
    ]

    submitted = find(oracle, "event", "ReadingSubmitted")
    assert types(submitted["inputs"]) == ["bytes32", "uint32", "int256", "bytes32"]
    assert [item["indexed"] for item in submitted["inputs"]] == [True, True, False, False]
    finalized = find(oracle, "event", "ReadingFinalized")
    assert types(finalized["inputs"]) == ["bytes32", "uint32"]

    market_constructor = find(market, "constructor")
    assert types(market_constructor["inputs"]) == [
        "address",
        "bytes32",
        "uint32",
        "int256",
        "address",
        "uint64",
        "uint64",
    ]
    find(market, "function", "cancel")
    swap = find(market, "function", "swap")
    assert types(swap["inputs"]) == ["bool", "uint256", "uint256", "uint64"]
    assert types(swap["outputs"]) == ["uint256"]
    quote_swap = find(market, "function", "quoteSwap")
    assert types(quote_swap["inputs"]) == ["bool", "uint256"]
    assert types(quote_swap["outputs"]) == ["uint256"]
    assert types(find(market, "function", "threshold")["outputs"]) == ["int256"]
    assert types(find(market, "function", "dayKey")["outputs"]) == ["uint32"]

    create = find(factory, "function", "createMarket")
    assert types(create["inputs"]) == [
        "address",
        "bytes32",
        "uint32",
        "int256",
        "address",
        "uint64",
        "uint64",
        "uint256",
    ]

    serialized = json.dumps([oracle, market, factory])
    assert "periodStart" not in serialized
    assert "periodEnd" not in serialized
    assert "isFinalized" not in serialized
    print("Frozen oracle and signed dayKey market ABIs match the agreed interface.")


if __name__ == "__main__":
    main()
