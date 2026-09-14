# GRIDFLEX contracts

Foundry project for the GRIDFLEX contracts deployed on X Layer.

## Local checks

```bash
forge fmt --check
forge build
forge test -vvv
python3 scripts/export_abi.py
```

Deployment is split into two explicit steps: `DeployCore.s.sol` deploys the oracle, demo
collateral, and factory; `CreateDemoMarket.s.sol` mints the configured demo liquidity and creates
one seeded market. Metric names are encoded onchain as `keccak256(bytes(metricName))`.

`GridOracle` stores daily ERCOT metric readings. A single reporter can submit or correct a
reading during its dispute window. After that window, anyone can finalize the reading and it
becomes immutable.

`MockUSDT` is permissionlessly mintable test collateral with six decimals. `OutcomeToken` is
the restricted ERC-20 implementation used for the YES and NO sides of a binary market.

`BinaryMarket` locks collateral to mint complete YES/NO sets, provides a zero-fee
constant-product swap pool, resolves from a finalized oracle reading, and redeems the winning
side one-for-one. `MarketFactory` creates, seeds, and indexes markets in one transaction.
