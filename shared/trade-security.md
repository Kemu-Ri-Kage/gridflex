# Trade execution and settlement safety

This document defines the safety boundary for the GRIDFLEX binary-market trade
flow. The contracts remain fully collateralised and use no leverage.

## Protected exact-input swaps

The market exposes two functions for trading:

```solidity
quoteSwap(bool yesForNo, uint256 amountIn) returns (uint256 amountOut)
swap(
    bool yesForNo,
    uint256 amountIn,
    uint256 minimumAmountOut,
    uint64 deadline
) returns (uint256 amountOut)
```

`quoteSwap` calculates the output against the current pool reserves. The web
interface then applies a 0.50% slippage tolerance. It preserves that original
minimum while the outcome-token approval confirms, fetches a fresh quote and
stops if the market has already moved beyond the limit. An accepted swap gets a
five-minute deadline measured from the latest confirmed block.

The contract rejects a swap when:

- the input or minimum output is zero;
- the transaction executes after its deadline;
- trading has closed or the pool has not been seeded;
- the current output is below the caller's minimum; or
- integer rounding would produce no output.

These checks protect the user from stale quotes and adverse reserve movement
between quoting and execution. The transaction reverts atomically, so a failed
swap cannot partially move tokens or alter the pool reserves.

## Collateral and settlement invariants

Every complete set locks one unit of mUSDT and creates one YES plus one NO.
Trading only redistributes outcome tokens; it does not mint unbacked exposure.
At all times before settlement:

- YES total supply equals NO total supply;
- the market's collateral balance equals each outcome token's total supply;
- the outcome-token balances held by the market equal its recorded reserves;
- a successful zero-fee swap does not reduce the constant-product invariant.

After oracle resolution, winning tokens redeem one-for-one for mUSDT. The
liquidity provider claims the winning reserve. The tests cover two independent
users, both swap directions, oracle resolution, user redemption, prevention of
double redemption and the final liquidity claim.

If no reading exists after the grace period, `cancel()` enables a refund path.
Each YES and each NO then pays 0.5 mUSDT, rounded down. This prevents collateral
from becoming permanently trapped when the data source has a genuine gap.

## Deployment impact

The protected `swap` interface changes `BinaryMarket` creation bytecode.
`MarketFactory` embeds that bytecode, so the factory currently deployed on X
Layer testnet must not be used to create the final demo market. The existing
oracle and MockUSDT deployments can be reused, but a new factory must be
deployed from this version after all checks pass.

No deployment or live market creation is part of the local implementation
step. Record the replacement factory and market addresses in
`shared/addresses.json` only after their transactions are confirmed.

## Operator checklist

1. Run the complete local test suite and contract-interface validation.
2. Review the deployment transaction in the wallet before signing.
3. Deploy the replacement factory to X Layer testnet.
4. Verify the deployed bytecode and publish the transaction hash.
5. Create one market with 10,000 mUSDT of initial liquidity.
6. Exercise mint, quote, approve, swap, resolve and redeem with test funds.
7. Confirm the market contract finishes with the expected collateral balance.
