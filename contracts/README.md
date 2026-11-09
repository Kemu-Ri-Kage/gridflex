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
position or pending order has reserved; while positions are open, deposits and withdrawals
fill at the next price round like orders, so nobody moves money at a pool value they know is
stale. If the feed is silent for 3 days, anyone can close any position at the last index (at
its entry price if the feed is paused). Not deployed.

Known gaps to settle in review before any deploy beyond testnet:
- A wrong price round cannot be removed from `LivePriceFeed`; the guardian can only pause.
  Orders whose fill round is the bad one can be cancelled by their traders while paused.

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

## Deploying the futures and options markets (X Layer testnet)

`DeployDerivatives.s.sol` deploys `LivePriceFeed`, `TexasPowerPerp` on it, and
`TexasPowerOptions` on the existing `GridOracle` in one run, with the plan's settings (5-minute
rounds, a -$50 to $300 band, $5 strikes). It refuses any chain but 1952, a reporter that is
also the quoter, and an owner that is also the deployer. Every contract is owned from the start
by the offline owner; the deployer key only pays gas.

```bash
export DEPLOYER_ADDRESS=0x...   # pays gas, signs with --account below
export OWNER_ADDRESS=0x...      # offline owner
export GUARDIAN_ADDRESS=0x...   # can pause
export REPORTER_ADDRESS=0x...   # price bot key (new, never the v1 oracle reporter)
export QUOTER_ADDRESS=0x...     # quote bot key (new, its own)
export COLLATERAL_ADDRESS=0x... # MockUSDT from shared/addresses.json
export ORACLE_ADDRESS=0x...     # GridOracle from shared/addresses.json
# OPTIONS_METRIC defaults to ERCOT_HBNORTH_DA_AVG (then the quote bot keeps
# OPTIONS_CLOSE=dayAheadAuction)
forge script script/DeployDerivatives.s.sol --rpc-url https://testrpc.xlayer.tech/terigon \
  --account <deployer-keystore> --sender "$DEPLOYER_ADDRESS" --broadcast
```

Then add the three printed addresses to `shared/addresses.json` as `LivePriceFeed`,
`TexasPowerPerp` and `TexasPowerOptions`; `build_feed_data.py` publishes them to
`web/public/data/addresses.json`, and the /futures and /options screens open. Seed the pools
after: `TexasPowerPerp.deposit` while no position is open, and `TexasPowerOptions.fundPool`
from the owner.
