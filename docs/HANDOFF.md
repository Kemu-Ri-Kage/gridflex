# GRIDFLEX project handoff

## Product summary

GRIDFLEX is a testnet market for verifiable ERCOT electricity-market outcomes.
Users take YES or NO positions on questions such as whether the North Hub
day-ahead average price exceeded a specified threshold. An onchain oracle stores
the signed metric value and its source-data hash; a binary market then resolves
against that reading and distributes collateral to the winning outcome.

The product is a cash-settled derivatives demonstration. It does not tokenize or
deliver electricity. All collateral is freely mintable `MockUSDT` on X Layer
testnet and has no monetary value.

## Architecture

GRIDFLEX intentionally has no application backend:

1. The Python pipeline calculates ERCOT metrics and publishes readings to
   `GridOracle`.
2. X Layer stores oracle readings, token balances, and market state.
3. A connected wallet is the user's identity; no account database or password
   system is required.
4. The web application reads contracts directly and asks the wallet to sign
   transactions.
5. `BinaryMarket` holds collateral. Neither the team nor a server takes custody
   of user funds.

Private keys must never be exposed to the web application or committed to the
repository. Operator keys belong in an encrypted keystore outside the project.

## Implemented components

- ERCOT pipeline with 2,168 validated metric files across contract and feed
  metrics.
- Frozen oracle boundary using `(bytes32 metricId, uint32 dayKey)`, where
  `dayKey` is `YYYYMMDD` rather than a timestamp.
- Signed `int256` values and thresholds, including negative West–North basis
  values.
- `GridOracle`, `MockUSDT`, `MarketFactory`, `BinaryMarket`, and `OutcomeToken`
  contracts.
- Fully collateralized complete sets, constant-product YES/NO swaps, resolution,
  redemption, and a cancellation/refund path for missing oracle readings.
- Wallet-connected web interface for collateral minting, position creation,
  trading, settlement, and redemption.
- Source-hash verification and an idempotent publication ledger.

Only `ERCOT_HBNORTH_DA_AVG` and `ERCOT_WEST_NORTH_DA_BASIS` are eligible to
settle MVP markets. Other published metrics are display-only feeds.

## Current testnet state

The core contracts are deployed on X Layer testnet, chain ID `1952`:

| Contract | Address |
|---|---|
| `GridOracle` | `0x970cefFC0e75bCa245F3337715992ad520A4D561` |
| `MockUSDT` | `0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A` |
| `MarketFactory` | `0xE4d35CE22E74A8BA656D74245E2173C93b430243` |

The committed ledger contains eight confirmed oracle submissions. The oracle
uses a 3,600-second dispute window. Contract addresses and deployment
transaction hashes are recorded in `shared/addresses.json`.

The next end-to-end milestone is to:

1. finalize the eligible demo readings;
2. create and seed a past-day market through `CreateDemoMarket.s.sol`;
3. execute the complete mint, swap, resolve, and redeem lifecycle;
4. record every public transaction hash;
5. configure the market addresses in `web/.env.local` and verify the live UI.

Detailed operator commands are in `shared/deployment.md`,
`shared/publish-spec.md`, and `shared/finalize-spec.md`.

## Verification

Run the complete project check from the repository root:

```bash
./scripts/check_all.sh
```

The script validates the metric files, runs the Python test suite, checks and
tests the Solidity contracts, exports and verifies the shared ABIs, and runs the
web tests, linter, and production build.

## Collaboration workflow

The GitHub repository is the canonical project source. Do not merge ZIP archives
into `main`.

For every change:

```bash
git switch main
git pull --ff-only
git switch -c <descriptive-branch-name>
```

Make one focused change, run `./scripts/check_all.sh`, commit it with a concise
English message, push the branch, and open a pull request. Another team member
should review the pull request before it is merged. Keep `main` deployable and
avoid force-pushing shared branches.

## Security rules

- Use dedicated testnet wallets only.
- Never commit `.env`, private keys, keystores, passwords, raw API responses,
  build artifacts, or local logs.
- Verify chain ID `1952`, contract bytecode, and the configured reporter before
  sending transactions.
- Run publication in dry-run mode first and use the explicit live confirmation.
- Pull the latest ledger before publishing or finalizing readings.
- Treat the source-data hash and completeness checks as part of the settlement
  security model.
