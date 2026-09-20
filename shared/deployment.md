# X Layer testnet deployment

GRIDFLEX deploys only to X Layer testnet (chain ID `1952`). The deployment script rejects every
other chain, including X Layer mainnet (`196`).

## Prerequisites

1. Install Foundry.
2. Import the dedicated testnet account into Foundry's encrypted keystore with
   `cast wallet import gridflex-deployer --interactive`. Enter the private key only in the hidden
   prompt and set a unique keystore password.
3. Put only that wallet's public address in `.env` as `DEPLOYER_ADDRESS`.
4. Fund that wallet with testnet OKB from the X Layer faucet.
5. Optionally set `REPORTER_ADDRESS`; otherwise the deployer is the reporter.
6. Set `ORACLE_DISPUTE_WINDOW=3600` for normal testnet operation, or `0` only for a
   tightly controlled past-day demo that must finalize immediately.

Never use a wallet that holds real assets. Never commit `.env` or paste a private key into a
command, shell history, chat, README, transaction log, or ZIP. The deployment commands below
prompt for the encrypted-keystore password without displaying it.

## Validate and deploy

```bash
cd contracts
set -a
source ../.env
set +a

forge fmt --check
forge test
forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url xlayer_testnet \
  --account gridflex-deployer \
  --sender "$DEPLOYER_ADDRESS" \
  --broadcast
```

Copy the three printed contract addresses into `.env` and `shared/addresses.json`, keeping
`chainId` set to `1952`. Then choose the demo market parameters. `MARKET_DAY_KEY` is the exact
`YYYYMMDD` integer from the matching metric JSON — it is not a timestamp.
`MARKET_THRESHOLD` is a signed integer in that metric's stored unit, and
`MARKET_RESOLVE_AFTER` must be a future Unix timestamp after trading should close.
`MARKET_DISPUTE_WINDOW` is the grace period before an unresolvable market can be cancelled;
use `3600` normally or `0` for a past-day live demo.

Metric names are always encoded as `keccak256(bytes(metricName))`; the market and every oracle
submission must use the same encoding.

Create and seed the demo market:

```bash
forge script script/CreateDemoMarket.s.sol:CreateDemoMarket \
  --rpc-url xlayer_testnet \
  --account gridflex-deployer \
  --sender "$DEPLOYER_ADDRESS" \
  --broadcast
```

The script mints the configured `INITIAL_LIQUIDITY` of test-only MockUSDT, approves the factory,
and creates a seeded market atomically. The default is `10000000000`, or 10,000 MockUSDT at six
decimals, producing initial reserves of 10,000 YES and 10,000 NO. Copy the printed market and YES/NO token addresses into
`shared/addresses.json`. Then rebuild and export the ABIs:

```bash
forge build
python3 scripts/export_abi.py
```

For the first complete demonstration, use the market specified in
`shared/demo-markets.md`: `ERCOT_HBNORTH_DA_AVG`, `MARKET_DAY_KEY=20260908`, and
`MARKET_THRESHOLD=3000`. The matching real metric is $39.57/MWh, so it resolves YES.

After deployment, save every public transaction hash (deploy, submit, finalize, create,
swap, resolve, redeem) in the README. Public addresses and hashes are safe to share; private
keys are not.
