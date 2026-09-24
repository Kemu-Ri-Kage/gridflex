# mergeSet: exiting a position before settlement

**Status: design only.** Nothing here is implemented, deployed or scheduled.
It describes a change to `BinaryMarket` for David to build against. Every
line reference is to `contracts/src/` as of commit `f22d04f`.

GRIDFLEX is a cash-settled derivatives venue. Outcome tokens are claims on
mUSDT collateral, settled against the published ERCOT reading. Nothing here,
or anywhere else, is redeemable for electricity.

---

## 1. The problem

**A trader can't turn a position back into mUSDT before the market
settles.** Today a position can be:

- switched between YES and NO through the pool (`swap`,
  `BinaryMarket.sol:147-177`), or
- held until settlement and redeemed.

`redeem()` is blocked until the market settles, by its first line:

```solidity
// BinaryMarket.sol:230
if (!resolved && !cancelled) revert MarketNotSettled();
```

No other function pays collateral to a trader. `claimLiquidity()`
(`:261-279`) pays only the liquidity provider, and only after settlement
(`:262`). So a trader who wants to take a profit or cut a loss before
settlement can't do it. They can only switch sides or wait.

## 2. The mechanism

```solidity
function mergeSet(uint256 amount) external nonReentrant
```

`mergeSet` burns `amount` YES and `amount` NO from the caller and sends the
caller exactly `amount` of collateral. It is the exact inverse of `mintSet`
(`:131-140`), which takes `amount` collateral and mints `amount` YES and
`amount` NO.

- **Units.** YES, NO and mUSDT all use the collateral's decimals (6), as
  set in the constructor (`:106-108`). So `amount` means the same base units
  on all three. One pair (1 YES + 1 NO, `1e6` base units each) returns
  1 mUSDT (`1e6`).
- **Body.** It runs in checks-effects-interactions order, as `redeem` does
  (`:253-255`):

```solidity
if (amount == 0) revert ZeroAmount();
uint256 yesBalance = yesToken.balanceOf(msg.sender);
uint256 noBalance = noToken.balanceOf(msg.sender);
if (yesBalance < amount || noBalance < amount) {
    revert InsufficientSet(yesBalance, noBalance, amount);
}
yesToken.burn(msg.sender, amount);
noToken.burn(msg.sender, amount);
collateral.safeTransfer(msg.sender, amount);
emit SetMerged(msg.sender, amount);
```

- **New error:** `InsufficientSet(uint256 yesBalance, uint256 noBalance,
  uint256 amount)`.
- **New event:** `SetMerged(address indexed account, uint256 amount)`, the
  counterpart of `SetMinted` (`:69`).

The explicit balance check is technically redundant: OpenZeppelin's `_burn`
already reverts with `ERC20InsufficientBalance`. It's there because that
error doesn't say which side is short or which token raised it, and the
ticket needs to say that. The site decodes `BinaryMarket`'s custom errors
(`revertAbi` in `web/components/web3-provider.tsx`).

### 2.1 Why it is safe

In short, the market's collateral always covers what its outstanding tokens
can claim, and `mergeSet` keeps it that way. The argument uses only the
contract's own code. I checked every sequence of mint, seed, swap, merge,
resolve, cancel, redeem and claim, and **none of them breaks the
invariant**.

**Notation.** `C` is `collateral.balanceOf(market)`. `Y` and `N` are
`yesToken.totalSupply()` and `noToken.totalSupply()`.

**Only three places create tokens, and each is paid for in full.** Only
the market can mint or burn (`OutcomeToken.sol:15-17, 32-38`). The market
mints in exactly two places, and both take the collateral first:

| Where | Collateral in | YES minted | NO minted |
|---|---|---|---|
| `seedPool` (`:123-125`), via the factory (`MarketFactory.sol:49-51`) | `+a` | `+a` to the market | `+a` to the market |
| `mintSet` (`:135-137`) | `+a` | `+a` to the caller | `+a` to the caller |
| `mergeSet` (new) | `−a` | `−a` from the caller | `−a` from the caller |

The brief says every token came from `mintSet`. That's almost right: the
pool's own tokens came from `seedPool`, but on the same one-for-one terms.

**Nothing else changes C, Y or N before settlement:**

- `swap` (`:161-174`) only moves tokens between the caller and the market,
  so supply doesn't change and no collateral moves.
- `redeem` (`:230`) and `claimLiquidity` (`:262`) revert until settlement.
- Anyone can send mUSDT or outcome tokens to the market address directly.
  That can only raise `C`, or park tokens outside the pool's reserves where
  nobody can claim them. Either way the market holds more than it owes.

**Before settlement, `Y = N ≤ C`.** Every row of the table changes `Y`, `N`
and `C` by the same amount. That covers the pool's tokens too.
`shared/trade-security.md` already claims `Y = N = C`, which becomes `≤`
only because of donations. With that, each possible outcome can pay out:

- **YES wins:** claims total at most `Y`. Holders are paid their YES
  one-for-one (`:245-246`), and the liquidity provider is paid
  `yesReserve` (`:268`). The market's reserve is part of `Y`, and stranded
  tokens are never paid.
- **NO wins:** claims total at most `N`, by the same argument.
- **Cancelled:** claims total at most `(Y + N) / 2`. Each holder is paid
  `Math.average(y, n)`, rounded down (`:242`), and the liquidity provider
  `Math.average(yesReserve, noReserve)` (`:268`).

All three bounds are at most `Y = N ≤ C`.

**After settlement no new tokens can appear.** `mintSet` requires
`block.timestamp < resolveAfter` (`:133`). `resolve` requires
`>= resolveAfter` (`:200`), and `cancel` requires `>= resolveAfter +
disputeWindow` (`:217-218`). Those windows don't overlap, so once a market
is settled no one can mint. `seedPool` has the same close (`:116`) and runs
only once (`:117`).

**After settlement the gap between collateral and claims never shrinks.**
Call that gap `D`:

- **Resolved, with W the winning side's supply: `D = C − W`.** It starts
  at `C − Y ≥ 0`.
  - A winner's `redeem` burns `w` winning tokens and pays `w`, so `D` is
    unchanged.
  - A holder with only losing tokens gets `NothingToRedeem` (`:244, :248`).
  - `claimLiquidity` burns the reserves and pays the winning reserve, so
    `D` is unchanged.
  - `mergeSet` burns `a` winning tokens (plus `a` losing ones) and pays
    `a`, so `D` is unchanged.
- **Cancelled: `D = C − (Y + N) / 2`.** It starts at `C − Y ≥ 0`.
  - `redeem` pays `floor((y + n) / 2)` and removes `(y + n) / 2` of claims,
    so `D` grows by 0 or ½.
  - `claimLiquidity` does the same with the reserves.
  - `mergeSet` pays `a` and removes `(a + a) / 2 = a`, so `D` is unchanged.

**The pool's own tokens can never be merged.** `mergeSet` burns only from
`msg.sender`, and the market never calls itself. So `yesReserve` and
`noReserve` stay equal to what the market actually holds, and
`claimLiquidity`'s payout on `:268` stays covered. There's no bug to guard
against here; the invariant test (§6) checks it anyway.

**Assumption, which already exists and isn't new:** the collateral is a
plain ERC-20 with no transfer fee, no rebasing and no transfer hooks.
`MockUSDT` (`MockUSDT.sol`) is one. The constructor accepts any collateral
address (`:87-108`). A fee-on-transfer token would already break
`mintSet`'s one-for-one backing today; `mergeSet` doesn't change that.

**No MEV surface.** `mergeSet` reads no price and no reserve, so there's
nothing to sandwich or front-run. The result depends only on the caller's
own balances.

---

## 3. Checks and when mergeSet is allowed

### 3.1 Checks

| Check | Why |
|---|---|
| `amount != 0`, else `ZeroAmount` (the existing error, `:49`) | Same as `mintSet` (`:132`). A zero merge would emit an empty `SetMerged` and cost gas for nothing. |
| Both balances `>= amount`, else `InsufficientSet` | Burns only a matched pair (§2). |
| `nonReentrant` | Every state-changing external function that moves value has it: `seedPool`, `mintSet`, `swap`, `redeem`, `claimLiquidity` (`:112, 131, 149, 229, 261`). |
| Burn before transfer | Same order as `redeem` (`:253-255`). Even without the guard, a re-entry would find the tokens already burned. |

The two outcome tokens and `MockUSDT` have no transfer hooks, so they can't
re-enter today. The guard is for consistency with the other functions, and
in case the collateral ever changes.

### 3.2 After trading closes, after resolution, after cancellation

A matched pair pays exactly `a` in every state:

- **Before settlement:** `mergeSet` pays `a`.
- **Resolved:** `redeem` would pay `a` for the winning half and nothing for
  the losing half.
- **Cancelled:** `redeem` would pay `Math.average(a, a) = a`.

So allowing a merge in any state never pays more than the tokens can
already claim. Nor can it use the outcome, even in the window after trading
closes (12:30 Central) and ERCOT publishes (13:30 Central) but before
`resolve()`: a pair is worth 1 whatever the price turned out to be.

Merging before or after `redeem` can't gain anything either. In a cancelled
market, a holder with 3 YES and 2 NO gets 2 from `redeem` (`floor(2.5)`).
Merging 2 and then redeeming the 1 leftover YES pays `2 + floor(0.5) = 2`,
the same amount.

**This part is David's call.** Each option is safe; they differ in product
behaviour and in what the tests must cover.

| Option | Rule | What it means |
|---|---|---|
| **A. Always allowed** *(recommended)* | No time or state check | Simplest, and nothing is lost. Pairs can be exited during the close-to-resolution gap. A live market's gap runs from 12:30 Central the day before to whenever someone calls `resolve()`, and can last up to the 7-day `disputeWindow` (604800 s in `shared/addresses.json`) if no reading arrives. After settlement it duplicates part of what `redeem` does; the ticket should still point to Redeem then (§7). |
| B. Only until settlement | `if (resolved \|\| cancelled) revert MarketAlreadySettled();` (existing error, `:63`) | One exit per state: merge before settlement, redeem after. Costs one branch, and gains no safety. |
| C. Only while trading is open | `if (block.timestamp >= resolveAfter) revert TradingClosed();` (as `mintSet`, `:133`) | Mirrors `mintSet`, but traps paired holders for the whole close-to-resolution gap for no safety benefit. Not recommended. |

---

## 4. Rounding

- **`mintSet`:** no arithmetic. Pay `a`, get `a` YES and `a` NO
  (`:135-137`).
- **`redeem` when resolved:** no arithmetic. `payout = balance`
  (`:246, 250`).
- **`redeem` when cancelled:** `Math.average(y, n)` (`:242`) rounds down,
  so an odd `y + n` loses half a base unit (0.0000005 mUSDT), which stays
  in the market. `claimLiquidity` rounds the same way for the pool
  (`:268`). The existing test `testCancelledOddDustDoesNotRevertFinalRedemption`
  confirms the last redeemer is still paid.
- **`mergeSet`:** no arithmetic. It pays exactly `amount`, so it can't round
  in anyone's favour and leaves no dust of its own. Any unmatched remainder
  (say 5 YES and 3 NO, merging 3) stays in the caller's wallet as tokens.
  That isn't dust: it keeps its full claim and can be redeemed at
  settlement.

**The rule to keep:** a later change that adds a fee, a partial payout or
any division must round down on what the caller receives and up on what
the caller pays. The market's surplus `D` (§2.1) must never go negative
through rounding. The rounding test in §6 locks this in.

---

## 5. Effect on the pool, approvals and wallet prompts

### 5.1 The pool

`mergeSet` doesn't read or write `yesReserve` or `noReserve`, and it burns
nothing the market holds. `price()` (`:192-195`) is `noReserve / (yesReserve
+ noReserve)`, so it reads the same before and after any merge, however
large. `quoteSwap` is unchanged too. A large exit through `mergeSet` moves
no price and hands nothing to the next trader.

The one caveat is in §5.3: a trader holding one side must swap first, and
**that swap** moves the price in the usual constant-product way. The price
impact of an exit is entirely in how the other side is acquired, never in
the merge.

### 5.2 Approvals: none

`mergeSet` needs **no approval of any token.**

- It burns through `OutcomeToken.burn` (`OutcomeToken.sol:36-38`), which is
  `onlyMarket` and calls `_burn` directly. There's no `transferFrom`, so
  no allowance is used.
- It pays mUSDT out with `safeTransfer` from the market's own balance.

The ticket asks the wallet for nothing but the `mergeSet` transaction:
**one prompt**, whatever the caller's allowances.

The buffered approvals (`web/lib/allowance.ts`, commit `e15a447`, already
shipped) don't change a matched exit. They matter only for the swap in
§5.3.

### 5.3 What it doesn't solve: holding only one side

`mergeSet` needs matched pairs, and **after a normal buy a trader holds only
one side.** The buy flow mints a pair and swaps the unwanted side away
(`runBuy` in `web/lib/buy-flow.ts`). So someone who bought YES holds only
YES and `mergeSet` can do nothing for them.

To exit they must first get NO through the pool, at the pool's price, and
then merge. This is the difference from a true sell:

- **A true sell** turns YES into mUSDT at a price, in one step.
- **`mergeSet`** only turns pairs back into mUSDT at exactly 1. The price is
  paid in the swap that builds the pair.

**The best one-sided exit.** A trader holds `y` YES; `Rʏ` and `Rɴ` are the
YES and NO reserves, and the swap fee is 0 (`SWAP_FEE_BPS = 0`, `:20`).
They should:

1. Swap `x` YES for NO, where `x` is chosen so the NO received equals the
   YES left over: `y − x = Rɴ·x / (Rʏ + x)`, giving
   `x = (−(Rʏ + Rɴ − y) + √((Rʏ + Rɴ − y)² + 4·y·Rʏ)) / 2`.
2. Merge `y − x`.

The mUSDT received is `y − x`. For NO, swap the roles of the reserves.

`quoteSwap` rounds its output down (`Math.mulDiv`, `:187`), so the NO
received can be one base unit short of `y − x`. The ticket should merge
`min(YES left, NO received)` and show what remains as a leftover position.
That leftover is one or two base units, never lost value.

**Worked example.** Reserves 10,000 / 10,000 (every market's initial
liquidity; YES price 0.50), exiting 100 YES:

- `x ≈ 50.125`: swapping 50.125 YES returns ≈ 49.875 NO.
- Merge 49.875 pairs to get **≈ 49.875 mUSDT**.
- At the 0.50 mid-price the position was worth 50; the 0.125 difference is
  the swap's price impact.

**Wallet prompts for a one-sided exit (swap, then merge):**

| Situation | With buffered approvals (shipped) | With exact approvals |
|---|---|---|
| First exit of this side on this market (the side was bought, never swapped away) | 3: approve YES, swap, merge | 3 |
| That side's approval already given (it was switched out of before) | 2: swap, merge | 3 |
| Later exits | 2 | 3 |

The approval is for the side being **sold**. A trader who bought YES has so
far approved only NO (it was swapped away in the buy). Selling YES needs a
YES approval the first time.

**Between the two transactions the trader is never exposed.** If the merge
never happens (rejected or failed), the trader holds a matched pair worth
exactly 1 per pair in every outcome, plus whatever YES is left. The ticket
should show that pair with a Cash out control, as it would any matched
holding. The price risk was taken, and fixed, when the swap confirmed.

**A related option, outside this spec, for David to rule on before any
redeploy.** A market function `sell(bool yes, uint256 amountIn, uint256
minimumCollateralOut, uint64 deadline)` could do the swap and merge
atomically inside the market.

- It would need **no approval and one prompt**, because the market can burn
  the caller's tokens directly.
- It would have a single slippage bound, in mUSDT.
- The swap-then-merge path above works without it, so it isn't needed for
  exits.
- It needs its own spec: an in-market swap without the transfer, rounding
  on the collateral out, and its own invariant tests.

It's raised here because shipping `mergeSet` already costs a full redeploy
(§8). If `sell` is ever wanted, adding it in the same redeploy avoids paying
that cost twice.

---

## 6. Tests: acceptance criteria

These are Foundry tests in `contracts/test/BinaryMarket.t.sol`, using the
existing fixture: a factory-seeded 10,000 mUSDT pool, `MockUSDT`, and the
oracle mock. Each line is one test and states what must hold. Rows marked
"Option A/B/C" depend on the decision in §3.2; build the rows for the
option chosen.

1. **Merge the full balance.** Mint 100 and merge 100. The caller's YES and
   NO go to 0; mUSDT comes back to its starting balance. `C`, `Y` and `N`
   each fall by 100. `SetMerged(caller, 100)` is emitted.
2. **Merge part of it.** Mint 100 and merge 40. The caller is left with 60
   YES and 60 NO and has 40 mUSDT back. A second merge of 60 then succeeds.
3. **Merge with an unequal holding.**
   - Mint 100, swap 30 NO for YES: the caller holds 100 + q YES and 70 NO.
   - Merging 70 succeeds and leaves q + 30 YES and 0 NO.
   - Merging 71 reverts with `InsufficientSet(yes, 70, 71)`.
   - A caller with YES only reverts on any positive amount.
4. **Merge zero.** Reverts with `ZeroAmount`, and nothing changes.
5. **Merge by someone holding nothing, or with only the pool's tokens.** A
   fresh address reverts with `InsufficientSet(0, 0, a)`. The market's own
   balances are never touched: `yesReserve` and `noReserve` stay equal to
   the market's token balances.
6. **The pool is untouched.** Before and after merging 5,000 pairs,
   `yesReserve`, `noReserve`, `price()` and `quoteSwap(true, 1e6)` are all
   unchanged.
7. **Merge after trading closes** (warp to `resolveAfter`, not yet
   resolved):
   - Option A or B: succeeds and pays 1:1.
   - Option C: reverts with `TradingClosed`.
   - In every option, `mintSet` and `swap` still revert with
     `TradingClosed`.
8. **Merge after resolution**, for YES winning and for NO winning:
   - Option A: a holder with `y` winning and `n` losing merges `min(y, n)`,
     then redeems the rest. The total received equals what redeeming
     straight away would pay. The liquidity provider's `claimLiquidity`
     still pays the full winning reserve, and the market ends with
     `C == 0` (or the donated amount).
   - Option B or C: reverts (`MarketAlreadySettled` or `TradingClosed`);
     redeem is unaffected.
9. **Merge on a cancelled market:**
   - Option A: a holder with 3 YES and 2 NO who merges 2 and then redeems
     gets 2 in total. Holders of 5/3 and 1/1 likewise get the same total as
     redeeming straight away. The liquidity provider's claim is still paid.
   - Option B or C: reverts; redeem is unaffected.
10. **No double spend.** After a merge, `redeem` at settlement pays nothing
    for the merged tokens, which are gone. A second merge of the same
    amount reverts.
11. **Reentrancy.**
    - Deploy a `BinaryMarket` directly with a hostile collateral: an ERC-20
      whose `transfer` calls back into the market.
    - Re-entering `mergeSet`, `mintSet`, `redeem` or `swap` from inside
      `mergeSet`'s collateral transfer reverts with OpenZeppelin's
      `ReentrancyGuardReentrantCall`, and the outer merge's state is
      unchanged.
    - A comment in the test notes that the real tokens have no hooks.
12. **Rounding dust.**
    - Merges of 1 base unit and of odd amounts pay exactly the amount.
    - Fuzz any sequence of partial merges summing to `m`: the caller
      receives exactly `m`, and `C` falls by exactly `m`.
    - On a cancelled market (Option A), a fuzzed holding `(y, n)` that is
      merged then redeemed never receives more than `Math.average(y, n)`.
13. **Invariant test** (forge-std `StdInvariant`, with a handler and at
    least three actors plus the liquidity provider).
    - The handler randomly calls `mintSet`, `swap` in both directions (with
      a valid minimum and deadline), `mergeSet`, time warps, `resolve`
      (the oracle mock returns a finalized reading above or below
      threshold), `cancel` (no reading, past the window), `redeem` and
      `claimLiquidity`.
    - It bounds amounts to actors' balances, and also makes some calls that
      must revert.
    - Invariants that must hold after every call:
      - **Before settlement:** `Y == N`, `C >= Y`, and `yesReserve ==
        yesToken.balanceOf(market)` (likewise for NO).
      - **Resolved:** `C >= ` the sum of every actor's winning balance, plus
        the winning reserve if liquidity isn't yet claimed.
      - **Cancelled:** `C >= ` the sum over actors of
        `Math.average(yes_i, no_i)`, plus the pool's
        `Math.average(yesReserve, noReserve)` if liquidity isn't yet
        claimed.
      - **Always:** every `redeem` and `claimLiquidity` call the handler
        makes while holding a claim succeeds. The collateral transfer
        never reverts for lack of funds.
      - **End of run:** once every actor has redeemed and the liquidity is
        claimed, `C` equals the rounding dust plus any donations, and is
        never negative. The dust is at most ½ base unit per cancelled
        redemption.

The existing suite must still pass unchanged, in particular
`testCannotRedeemBeforeSettlement`: `redeem` is untouched.
`scripts/validate_contract_interface.py` and `scripts/check_all.sh` must
pass with the new ABI.

---

## 7. UI

On the ticket (`web/components/trade-panel.tsx`, which is David's):

- **A "Cash out" control, kept separate from Switch position.**
  - It appears only when the wallet holds both YES and NO on the selected
    market. The amount is limited to `min(YES, NO)`.
  - Before confirming, it shows "You get X mUSDT", computed as exactly the
    amount; no quote is needed.
  - It also shows what stays open afterwards: any unmatched YES or NO.
  - One transaction and no approval step, so the prompt count reads 1.
- **Where it's needed most.** A buy whose mint confirmed but whose swap
  didn't (the pending order in `web/lib/pending-order.ts`) leaves exactly a
  matched pair. Cash out is that trader's clean way back to mUSDT, next to
  the existing "finish the order" path.
- **Keep it visibly separate from Switch position.**
  - Switch moves exposure from one side to the other at the pool's price.
  - Cash out ends exposure at a fixed 1 per pair.
  - They must not share a control, a percentage selector
    (`SWITCH_PERCENTAGES`, `web/lib/trade.ts:54`) or a heading.
- **A trader holding one side** sees no Cash out amount. Instead:
  > "Cash out needs both YES and NO. To exit YES before settlement, sell
  > it: part of your YES is swapped for NO at the pool's price, then the
  > pairs are cashed out. You'd get about X mUSDT."

  X is computed as in §5.3, followed by the prompt count from §5.3. If
  trading has closed, the text says the position can be redeemed after
  settlement, since the swap is closed (`:155`).
- **After settlement** (Option A), the ticket leads with Redeem, which pays
  everything in one call. Cash out doesn't need to appear there.

---

## 8. What it costs to ship

**The existing markets can't gain this function.** `BinaryMarket` has no
proxy and no upgrade path; every market is a separate `new BinaryMarket`
(`MarketFactory.sol:42`). Shipping `mergeSet` means:

1. **A new `BinaryMarket`**, with the tests in §6.
2. **A new `MarketFactory` deployment.** The factory embeds `BinaryMarket`'s
   creation bytecode, so any change to the market changes the factory. This
   happened once already (`shared/trade-security.md`, "Deployment impact").
   The current factory `0xE521…C3A9` then moves to
   `legacyDeployments.MarketFactory` in `shared/addresses.json`, as the
   first one did.
3. **Recreating every market.** Seven are listed in `shared/addresses.json`.
   - Each needs another 10,000 mUSDT of initial liquidity and gas.
   - The two replay markets (12 Aug, 8 Sep) have to be resolved again.
   - `create_markets.py` then checks existence against the new factory
     only.
4. **The old markets stay on chain.** They are still tradeable until they
   close, and positions in them (for example the first-trade wallet on the
   2 Oct $45 market, `0xb22A…E604`, in `shared/demo-evidence.md`) must
   still be resolved and redeemable there.

**Artefacts that would need updating:**

- **`contracts/src/BinaryMarket.sol` and `contracts/test/BinaryMarket.t.sol`.**
  Plus `contracts/scripts/export_abi.py` output to both copies of the ABI,
  `shared/abi/BinaryMarket.json` and `web/lib/abi/BinaryMarket.json`.
- **`shared/addresses.json`:**
  - the new `MarketFactory`;
  - the top-level `BinaryMarket`, `YesToken` and `NoToken` (currently the
    8 Sep market);
  - `markets[]`;
  - `legacyDeployments` for the old factory and its seven markets.

  It is the only place addresses live.
- **`data/market-ledger.json`.** It's keyed by `metric:dayKey:threshold`,
  so a recreated market reuses its predecessor's key. Decide whether old
  records move to a legacy section or get new keys; they must never be
  overwritten, because the evidence file cites them.
- **`create_markets.py`.** Its preflight refuses a `MarketFactory` whose
  deployed bytecode differs from the checked-out build ("Configured
  MarketFactory bytecode does not match…"). From the moment the
  `BinaryMarket.sol` change lands, it refuses to create markets until the
  new factory is deployed and recorded. **The contract change and the
  redeploy must land together.**
- **`resolve_markets.py`.** It lists markets from the configured factory's
  `getMarkets()` (`list_market_states`). After the switch it would stop
  seeing the old factory's markets, so it needs to also walk
  `legacyDeployments` or the old positions never settle.
- **The site:**
  - `web/lib/markets.tsx` and `web/lib/site-data.ts` read `addresses.json`
    and follow automatically, but decide whether legacy markets stay listed
    (read-only, Redeem only) so their holders can find them;
  - the new ticket control (§7), in David's `trade-panel.tsx` and
    `web3-provider.tsx`.
- **The evidence file and docs:**
  - `shared/demo-evidence.md` (every address and transaction; the old ones
    stay valid as history, so new ones are added, not substituted);
  - `shared/demo-markets.md`;
  - `README.md` (the market table and the resolved 8 Sep links);
  - `shared/demo-video-script.md`;
  - `shared/submission-answers.md`;
  - `shared/deployment.md`;
  - `shared/trade-security.md` (the invariants section gains `mergeSet`;
    its "Deployment impact" gains this redeploy);
  - `docs/HANDOFF.md`;
  - `docs/technical-reference.md`.

**Timing.** Submission is 25 September. The redeploy replaces every address
the README, the evidence file and the recorded demo point to. Whether that
happens before submission or after is a product decision, not an
engineering one. The spec doesn't assume either.
