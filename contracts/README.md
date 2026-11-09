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

`TexasPowerOptions` lists European calls and puts on one Texas market day's average price
(plan, "Market 2"). Each expiry trades until its close and settles on the oracle's final
reading of the contract's metric for that day, clamped to a fixed band. A call pays
max(settlement - strike, 0) per MWh, a put max(strike - settlement, 0). The pool writes every
option and locks its largest payout when it is bought, so each option is fully backed; holders
can sell back at the pool's bid before the close. A quote bot posts ask and bid premiums per
strike as numbered versions, and every pending order of that expiry fills or cancels inside
the same transaction: an order fills at the first quotes posted after it, never at quotes it
could see, and nobody can pick when it executes (orders from the quotes' own block wait for
the next version). Pending orders per expiry are capped at 100 to bound the bot's gas. If the
oracle has no final reading 14 days after the close, anyone can void a series and every
holder gets back the premium they paid (selling back moves a share of it). Not deployed.

Known gaps to settle in review:
- Only the owner funds the pool. Public pool shares need a fair value for open options.
- The quote bot is trusted: it sees pending orders and could quote up to their limits, and a
  wrong quote costs the pool. Guardian pause stops it; the bot's key is replaceable.
