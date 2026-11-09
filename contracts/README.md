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

`LivePriceFeed` holds five-minute ERCOT real-time prices for the perpetual futures and the
options quotes (GRIDFLEX Trading Platform Plan). A bot (the reporter) publishes one round per
finished five-minute interval, in cents per MWh, within fixed bounds; intervals only move
forward. The GRIDFLEX Texas Live Index at a round is the average of that round and the two
before it, and exists only when the three intervals are back to back, so a missed interval
means no index (markets go close-only) rather than a stale one. `latestIndex` also refuses a
price older than the caller's limit and serves nothing while paused. Keys follow
`GridOracleV2`: an offline owner replaces the reporter and guardian and alone unpauses; the
guardian can pause. It is not deployed yet and nothing uses it yet.

`TexasPowerPerp` is TXPOWER-PERP, the perpetual future on the live Texas price (plan, "Market
1"). Traders go long or short in MWh on the `LivePriceFeed` index, clamped to a fixed band.
Every position is fully backed: a long posts size x (entry - floor), a short size x (cap -
entry), and the pool sets aside the most the trader could win, so there is no leverage and no
liquidation. Orders fill at the first price round published after the order (a round in the
order's own block never counts); once that round exists the trader cannot cancel. The bigger
side pays funding to the pool, growing with the imbalance; open and close fees go to the pool.
Liquidity providers deposit for pool shares (this contract's ERC-20) and withdraw only cash no
position or pending order has reserved. Not deployed.

Known gaps to settle in review before any deploy beyond testnet:
- Pool deposits and withdrawals price at the latest published index, so a provider who sees
  ERCOT's next price first could withdraw before a loss reaches the pool. Fix: fill pool
  withdrawals at the next print, like orders.
- If the price feed stops for good, open positions cannot close. Fix: after a long outage,
  let anyone close positions at the last valid index.
- A wrong price round cannot be removed from `LivePriceFeed`; the guardian can only pause.
  Orders whose fill round is the bad one can be cancelled by their traders while paused.
