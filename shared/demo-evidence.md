# GRIDFLEX demo evidence

This file lists the onchain transactions that the README and the demo video
point to. Every value here was read back from X Layer testnet (chain
`1952`, RPC `https://testrpc.xlayer.tech/terigon`) on 2026-09-22 with
`cast`. The approvals, the demo mUSDT mint and the two reverted attempts
were found and read back on 2026-09-23, as were the two strike-ladder markets
(with web3.py). Amounts are in token units (all three
tokens have 6 decimals), and raw onchain integers are shown in brackets.
Contract addresses come from `shared/addresses.json`.

Explorer links use OKLink's X Layer Testnet explorer, the same base the site
uses (`web/lib/explorer.ts`): `https://www.oklink.com/x-layer-testnet/tx/<hash>`
for a transaction and `.../address/<address>` for a contract or wallet. The
mint transaction's page was confirmed to render correctly in a normal browser
on 2026-09-23. Both OKLink and the OKX explorer block headless browsers, so
the other links were checked for URL shape and HTTP response, not rendered.

---

## First trade

Wallet `0xD95Bd9f3E641974515B53adE252AD43e7cB28059` on live market 4,
**"Will Texas power cost more than $45 on October 2, 2026?"**
(`ERCOT_HBNORTH_DA_AVG`, `dayKey 20261002`, threshold `4500`, trading closes
2026-10-01 17:30 UTC).

| | Address |
|---|---|
| Market | [`0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604`](https://www.oklink.com/x-layer-testnet/address/0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604) |
| YES token | [`0x7Ab974d156E5C0bA65C90C5385F8Bc64Ca5AcB2A`](https://www.oklink.com/x-layer-testnet/address/0x7Ab974d156E5C0bA65C90C5385F8Bc64Ca5AcB2A) |
| NO token | [`0xDd4ADa603d2aAC5945AEDd76519cbC7E8CdEdfa4`](https://www.oklink.com/x-layer-testnet/address/0xDd4ADa603d2aAC5945AEDd76519cbC7E8CdEdfa4) |
| mUSDT | [`0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A`](https://www.oklink.com/x-layer-testnet/address/0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A) |

The position rests on two transactions: the mint (step 1) turns 10 mUSDT into
10 YES + 10 NO, and the swap (step 2) turns the 10 NO into 9.990009 YES. The
swap is what makes it a 19.990009 YES position. The approvals and the demo
mUSDT mint below come first.

### Before the trade: approvals and demo mUSDT

Both approvals name the market as spender, for 100 tokens each. The market
needs the mUSDT approval to pull collateral in `mintSet()` and the NO
approval to pull NO in `swap()`.

| Step | Transaction | Block | Time (UTC) | Call | Result |
|---|---|---|---|---|---|
| Approve mUSDT | [`0x4f6bfde6f4befa50b4ce35081e65f20a844fbab47a8c1b598b4572c59a42b096`](https://www.oklink.com/x-layer-testnet/tx/0x4f6bfde6f4befa50b4ce35081e65f20a844fbab47a8c1b598b4572c59a42b096) | `41656927` | 2026-09-22 22:22:44 | mUSDT `approve(market, 100)` `[100000000]` | success |
| Mint set, 100 mUSDT | [`0xd4993e85e727a4dc99bf8036877323c77a8a502eea453d8c178a085be0bfb851`](https://www.oklink.com/x-layer-testnet/tx/0xd4993e85e727a4dc99bf8036877323c77a8a502eea453d8c178a085be0bfb851) | `41656936` | 2026-09-22 22:22:53 | `mintSet(100000000)` | **reverted**: `ERC20InsufficientBalance` (wallet held 0 mUSDT) |
| Approve NO | [`0xc714866ec4c3389282a160b83566626ce6dfa1cf5fefff9ae489aaddb37e39f4`](https://www.oklink.com/x-layer-testnet/tx/0xc714866ec4c3389282a160b83566626ce6dfa1cf5fefff9ae489aaddb37e39f4) | `41656948` | 2026-09-22 22:23:05 | NO `approve(market, 100)` `[100000000]` | success |
| Swap, 100 NO | [`0xb78a910d4a2725aca81458c922d060aefa09f913e353442ecdf96831eb493d80`](https://www.oklink.com/x-layer-testnet/tx/0xb78a910d4a2725aca81458c922d060aefa09f913e353442ecdf96831eb493d80) | `41656956` | 2026-09-22 22:23:13 | `swap(false, 100000000, …)` | **reverted**: `ERC20InsufficientBalance` (wallet held 0 NO) |
| Get demo mUSDT | [`0x9109a3834c9db092bbe76d5ad4ae5039865009381756c71d52ae0d922a83d099`](https://www.oklink.com/x-layer-testnet/tx/0x9109a3834c9db092bbe76d5ad4ae5039865009381756c71d52ae0d922a83d099) | `41657404` | 2026-09-22 22:30:41 | mUSDT `mint(wallet, 1000)` `[1000000000]` | success |

The two reverted attempts changed no balances: the wallet held 0 mUSDT and
0 YES at blocks `41656926`, `41656940` and `41657403`. They explain the size
of the approvals, which were sized for that first 100 mUSDT attempt. After the
10 mUSDT trade below, 90 of each approval remains (`allowance` reads
`90000000` for both).

### 1. Mint a set: 10 mUSDT for 10 YES + 10 NO

- Tx: [`0x32aa67ca132bf362d910a1cdaea334b36bd4d7e9238b450a3692fe87e7a7255d`](https://www.oklink.com/x-layer-testnet/tx/0x32aa67ca132bf362d910a1cdaea334b36bd4d7e9238b450a3692fe87e7a7255d)
- Block `41657429`, **2026-09-22 22:31:06 UTC**, status success
- `mintSet(10000000)`: 10 mUSDT went from the wallet to the market, and 10
  YES and 10 NO were minted to the wallet (`SetMinted`, `[10000000]`).

### 2. Swap: 10 NO for 9.990009 YES

- Tx: [`0x9bed4e23049c7ce5262a913b4b1152f90bfa3db10811d4531f38b193b1808a2a`](https://www.oklink.com/x-layer-testnet/tx/0x9bed4e23049c7ce5262a913b4b1152f90bfa3db10811d4531f38b193b1808a2a)
- Block `41657438`, **2026-09-22 22:31:15 UTC** (9 seconds after the mint),
  status success
- `swap(yesForNo=false, amountIn=10000000, minimumAmountOut=9940058,
  deadline=2026-09-22 22:36:08 UTC)`
- `Swapped`: **10 NO in `[10000000]`, 9.990009 YES out `[9990009]`**.
  The minimum output the wallet would accept was 9.940058 YES.

### Wallet balances on this market after the trade

Read at the latest block (`41658789`). They are the same as at block
`41657438`, and the wallet held none of these tokens before the mint
(block `41657428`: 1,000 mUSDT, 0 YES, 0 NO).

| Token | Balance | Raw |
|---|---|---|
| mUSDT | 990 | `990000000` |
| YES | 19.990009 | `19990009` |
| NO | 0 | `0` |

The balances reconcile: 1,000 − 10 = 990 mUSDT, 10 + 9.990009 = 19.990009
YES, and 10 − 10 = 0 NO. The position is a YES position: it pays out if
the 2 October 2026 HB_NORTH day-ahead average closes above $45.00/MWh.

---

## Strike ladder

Two live markets added on 2026-09-23, rows 6 and 7 of the Summary table in
`shared/demo-markets.md`. Each sits beside a $45 market on the same day. Both
were created through `MarketFactory` by wallet
`0xD95Bd9f3E641974515B53adE252AD43e7cB28059`, with 10,000 mUSDT of initial
liquidity (`[10000000000]`) and a seven-day dispute window (`[604800]`).
After they were created, `marketCount()` read `7`, and `marketAt(5)` and
`marketAt(6)` returned these two markets. Neither creation transaction emitted
a log from any of the five earlier markets. The earlier markets still read
the same strike, day, close, dispute window and tokens as
`shared/addresses.json`.

| | 30 September, above $40 | 2 October, above $38 |
|---|---|---|
| Question | "Will Texas power cost more than $40 on September 30, 2026?" | "Will Texas power cost more than $38 on October 2, 2026?" |
| Metric, `dayKey`, threshold | `ERCOT_HBNORTH_DA_AVG`, `20260930`, `4000` | `ERCOT_HBNORTH_DA_AVG`, `20261002`, `3800` |
| Trading closes | 2026-09-29 17:30 UTC (12:30 CDT), `resolveAfter` `1790703000` | 2026-10-01 17:30 UTC (12:30 CDT), `resolveAfter` `1790875800` |
| Market | [`0x4f8eCF1f34727d57797158634576DC8dbFF7b13d`](https://www.oklink.com/x-layer-testnet/address/0x4f8eCF1f34727d57797158634576DC8dbFF7b13d) | [`0x845A05007aD577f37eDC8779afF28169a7321D77`](https://www.oklink.com/x-layer-testnet/address/0x845A05007aD577f37eDC8779afF28169a7321D77) |
| YES token | [`0x5b1bbDe179EB64bDa299dBFaF9ca5Ef23c6218d9`](https://www.oklink.com/x-layer-testnet/address/0x5b1bbDe179EB64bDa299dBFaF9ca5Ef23c6218d9) | [`0x1d419831e413cD885707Fe71f6bBB53F2Ab3852a`](https://www.oklink.com/x-layer-testnet/address/0x1d419831e413cD885707Fe71f6bBB53F2Ab3852a) |
| NO token | [`0xe9d83b4c4b960bEfECBe0189793A7639F2684a68`](https://www.oklink.com/x-layer-testnet/address/0xe9d83b4c4b960bEfECBe0189793A7639F2684a68) | [`0xCEA8595b18ca4ECb6686fbA7aeFa096D4E4E04FA`](https://www.oklink.com/x-layer-testnet/address/0xCEA8595b18ca4ECb6686fbA7aeFa096D4E4E04FA) |
| Created | [`0xf4075068e26a30a98882036f1f3637f8226b8e633554585feae7bc6a88460a8b`](https://www.oklink.com/x-layer-testnet/tx/0xf4075068e26a30a98882036f1f3637f8226b8e633554585feae7bc6a88460a8b) | [`0x18232e03a19b3709ce27086d02f200f4c0ce850b9c0e4ce35d4d98f63f2e2cf3`](https://www.oklink.com/x-layer-testnet/tx/0x18232e03a19b3709ce27086d02f200f4c0ce850b9c0e4ce35d4d98f63f2e2cf3) |
| Block, time (UTC) | `41704525`, 2026-09-23 11:36:02 | `41704545`, 2026-09-23 11:36:22 |
| Status | success, `MarketCreated` from the factory | success, `MarketCreated` from the factory |

---

## Resolved markets

These are the two markets created under the earlier plan (see
`shared/demo-markets.md`). Both are resolved onchain and `resolved()` reads
`true`. Wallet `0xD95Bd9f3E641974515B53adE252AD43e7cB28059` sent both
`resolve()` calls. Resolution is permissionless: any account can send it
once trading has closed and the reading is final.

### Texas power, 8 September 2026, above $30 → YES

- Market: [`0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1`](https://www.oklink.com/x-layer-testnet/address/0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1)
  (`ERCOT_HBNORTH_DA_AVG`, `dayKey 20260908`, threshold `3000`)
- Created: [`0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677`](https://www.oklink.com/x-layer-testnet/tx/0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677)
- Resolved: [`0x004e9ae0e4fa95f5519d3f9ad274b695bedefd21af2bdcafeff3cc47dc97b216`](https://www.oklink.com/x-layer-testnet/tx/0x004e9ae0e4fa95f5519d3f9ad274b695bedefd21af2bdcafeff3cc47dc97b216)
  at block `41622133`, **2026-09-22 12:42:50 UTC**
- `Resolved(yesWon=true, oracleValue=3957)`: **$39.57/MWh, which is above
  $30, so YES wins**

### West–North basis, 12 August 2026, above $0 → NO

- Market: [`0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07`](https://www.oklink.com/x-layer-testnet/address/0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07)
  (`ERCOT_WEST_NORTH_DA_BASIS`, `dayKey 20260812`, threshold `0`)
- Created: [`0x74bde77879ccd4bcdd4c7242ce05f4a7bb471da78f7c8a375827df80dd049e3b`](https://www.oklink.com/x-layer-testnet/tx/0x74bde77879ccd4bcdd4c7242ce05f4a7bb471da78f7c8a375827df80dd049e3b)
- Resolved: [`0xd83a6e14b88f5d6ad57d4b48af6da93464b27ebe04695f3b20b67ac6d3a82104`](https://www.oklink.com/x-layer-testnet/tx/0xd83a6e14b88f5d6ad57d4b48af6da93464b27ebe04695f3b20b67ac6d3a82104)
  at block `41626418`, **2026-09-22 13:54:15 UTC**
- `Resolved(yesWon=false, oracleValue=-1032)`: **−$10.32/MWh, which is not
  above $0, so NO wins**

---

## How to re-check

```sh
RPC=https://testrpc.xlayer.tech/terigon
cast receipt 0x9bed4e23049c7ce5262a913b4b1152f90bfa3db10811d4531f38b193b1808a2a --rpc-url $RPC
cast call 0x7Ab974d156E5C0bA65C90C5385F8Bc64Ca5AcB2A 'balanceOf(address)(uint256)' \
  0xD95Bd9f3E641974515B53adE252AD43e7cB28059 --rpc-url $RPC
cast call 0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1 'yesWon()(bool)' --rpc-url $RPC
```

Balances change if the wallet trades again, so the balance table is only
valid as of the block it names.
