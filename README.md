# GRIDFLEX

**A YES/NO market on whether Texas power will cost more than a strike price on
a given day, settled automatically against the official published price.**

Bitcoin miners in Texas pay that price, and electricity is their single
largest cost. They have no way to hedge it onchain: ICE sells that hedge to
institutions, through a futures broker, in contracts of hundreds of
megawatt-hours. AI data centres now compete for the same power, and the
Texas power price averaged $39.91/MWh over 10–23 September 2026, up 32.5% on
the same days of 2025 ($30.12; from our
[metric files](data/metrics/)). GRIDFLEX lists that price onchain as a
YES/NO contract, at any size.

Live on X Layer testnet, settled in MockUSDT.

- **Live site:** <https://gridflex-web.teslenko-platon.workers.dev>
- **Demo video:** `[DEMO VIDEO LINK — TO ADD]`

---

## The problem

Texas power swings several-fold within a single day. On 22 September 2026,
the latest day in our data, the cheapest hour cost **$23.08/MWh** (9:00 Texas
time) and the dearest cost **$97.03/MWh** (18:00), 4.2 times as much
([`price-summary.json`](web/lib/generated/price-summary.json)). A MWh is roughly
what 650 Texas homes use in an hour.

Some days are far worse. On **26 January 2026** the Texas power price
averaged **$694.03/MWh** across the day
([metric file](data/metrics/ERCOT_HBNORTH_DA_AVG__2026-01-26.json)), against
a typical $20–45: the median day over the last 376 is $28.55, so that day
cost 24 times a normal one.

Institutions already trade this risk. ICE lists futures and options on the
same price point, ERCOT North Hub. Its
[monthly future](https://www.ice.com/products/6590337/ERCOT-North-345KV-Real-Time-Peak-Fixed-Price-Future)
is 1 MW for every peak hour of the month, around 350 MWh per contract, with
[options on it](https://www.ice.com/products/6590519/Option-on-ERCOT-North-345KV-Real-Time-Peak-Fixed-Price-Future);
the closest thing to a one-day bet is an
[option on an 80 MWh daily day-ahead future](https://www.ice.com/products/53169033/Option-on-ERCOT-North-345KV-Day-Ahead-Peak-Daily-80-MWh-Fixed-Price-Future).
All of them are reached through a futures broker.

**GRIDFLEX makes the same bet small and open to anyone with a wallet.** One
YES pays 1 MockUSDT if the day's price settles above the strike. The first
live trade was 10 MockUSDT.

## Who uses it

- **Traders who want exposure unrelated to crypto.** The Texas power price
  moves on weather, gas prices and grid demand, not on token markets.
- **Anyone whose costs depend on Texas power**, such as bitcoin miners and
  data centres. A YES on a high-price day pays out on the day their power
  bill hurts most.
- **Anyone who sells Texas power**, such as wind and solar farms, whose
  income falls when the price does. NO is their side of the same question,
  so the buyers who fear high prices and the sellers who fear low ones meet
  in one market.
- **AI agents**, which can buy the verified price and a hedge quote per
  call from the [price API](#the-price-api-for-agents-okx-ai).

## What works today

Everything below is on X Layer testnet (chain `1952`) and can be checked on
the [OKLink explorer](https://www.oklink.com/x-layer-testnet). Full detail,
with blocks and raw values, is in
[`shared/demo-evidence.md`](shared/demo-evidence.md).

### Core contracts

| Contract | Address |
|---|---|
| Oracle (`GridOracle`) | [`0x970cefFC0e75bCa245F3337715992ad520A4D561`](https://www.oklink.com/x-layer-testnet/address/0x970cefFC0e75bCa245F3337715992ad520A4D561) |
| Market factory (`MarketFactory`) | [`0xE52189873eb34A5cdbeE5ACAD2d227F2a65CC3A9`](https://www.oklink.com/x-layer-testnet/address/0xE52189873eb34A5cdbeE5ACAD2d227F2a65CC3A9) |
| Collateral (`MockUSDT`) | [`0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A`](https://www.oklink.com/x-layer-testnet/address/0xA5A5e9eB64d4a9414AA09d887E284d8F2b3b217A) |

### Every market

The factory has created seven markets (`marketCount()` reads `7`).

| Question | Status | Market |
|---|---|---|
| Will Texas power cost more than $45 on 26 Sep 2026? | trading | [`0xb1FaDd61…2F94`](https://www.oklink.com/x-layer-testnet/address/0xb1FaDd618FFC37E26bf75143E6C852d6D3992F94) |
| Will Texas power cost more than $45 on 30 Sep 2026? | trading | [`0x204Ef087…73af`](https://www.oklink.com/x-layer-testnet/address/0x204Ef0871892c52b7Abf00AC4755333c5e7F73af) |
| Will Texas power cost more than $40 on 30 Sep 2026? | trading | [`0x4f8eCF1f…b13d`](https://www.oklink.com/x-layer-testnet/address/0x4f8eCF1f34727d57797158634576DC8dbFF7b13d) |
| Will Texas power cost more than $45 on 2 Oct 2026? | trading, first live trade | [`0xb22A449c…E604`](https://www.oklink.com/x-layer-testnet/address/0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604) |
| Will Texas power cost more than $38 on 2 Oct 2026? | trading | [`0x845A0500…1D77`](https://www.oklink.com/x-layer-testnet/address/0x845A05007aD577f37eDC8779afF28169a7321D77) |
| Will Texas power cost more than $30 on 8 Sep 2026? | **resolved YES** | [`0x1b89e1dC…B8c1`](https://www.oklink.com/x-layer-testnet/address/0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1) |
| Will West Texas power cost more than North Texas power on 12 Aug 2026? | **resolved NO** | [`0x62D65F4e…BE07`](https://www.oklink.com/x-layer-testnet/address/0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07) |

The machine-readable list, with each market's YES and NO tokens and creation
transaction, is [`shared/addresses.json`](shared/addresses.json).

### The first live trade

A wallet bought YES on the 2 October market, 22 September 2026:

1. [Got 1,000 demo MockUSDT](https://www.oklink.com/x-layer-testnet/tx/0x9109a3834c9db092bbe76d5ad4ae5039865009381756c71d52ae0d922a83d099)
2. [Paid 10 MockUSDT for 10 YES + 10 NO](https://www.oklink.com/x-layer-testnet/tx/0x32aa67ca132bf362d910a1cdaea334b36bd4d7e9238b450a3692fe87e7a7255d)
3. [Swapped the 10 NO for 9.990009 YES](https://www.oklink.com/x-layer-testnet/tx/0x9bed4e23049c7ce5262a913b4b1152f90bfa3db10811d4531f38b193b1808a2a),
   nine seconds later

After it the wallet held 19.990009 YES (read at block `41658789`), which
pays 19.99 MockUSDT if the Texas power price for 2 October settles above
$45.00/MWh. On the site steps 2 and 3 are one button: **Buy YES**.

### Both resolved markets

| Market | Price published | Result |
|---|---|---|
| Texas power above $30 on 8 Sep 2026 | $39.57/MWh ([reading](https://www.oklink.com/x-layer-testnet/tx/0xf6bdfc4e4c775eca150fff4d380f915411d6bf4e5389d8e3228dfbeff00cb44f)) | **YES** ([resolve tx](https://www.oklink.com/x-layer-testnet/tx/0x004e9ae0e4fa95f5519d3f9ad274b695bedefd21af2bdcafeff3cc47dc97b216)) |
| West above North Texas on 12 Aug 2026 | −$10.32/MWh ([reading](https://www.oklink.com/x-layer-testnet/tx/0x9931b0c453c4de0367027e7024b3fd1832fa11dd02832701b00049194fecfc37)) | **NO** ([resolve tx](https://www.oklink.com/x-layer-testnet/tx/0xd83a6e14b88f5d6ad57d4b48af6da93464b27ebe04695f3b20b67ac6d3a82104)) |

Nobody chose these outcomes. Each market read the price from the oracle and
compared it to its own strike.

### For hedgers

The terminal's **Hedge** tab sizes a hedge for a power bill. Enter a load
in megawatts, the hours it runs and the price to protect up to, and it
builds a ladder of YES tokens across every strike trading on that day, so
the payout steps up with the extra cost of the power. It prices each rung
from its market's pool and shows the extra cost against the payout at each
price. **Load in ticket** puts a rung into the order ticket; nothing is
sent until the buyer presses Buy.

The order ticket states every buy in plain money ("Pay 100 mUSDT → receive
190.45 mUSDT if YES wins (+90.45). Max loss 100 mUSDT."). The **Portfolio**
tab lists a wallet's positions across every market, with **Redeem all**,
and a banner says when winnings are waiting.

### The price API for agents (OKX AI)

A JSON API sells the verified Texas power price, the live markets and hedge
quotes, built for AI agents to find on OKX AI and pay per call with x402:

| Endpoint | Returns |
|---|---|
| `GET /api/v1` | What the API sells and how it's paid (always free) |
| `GET /api/v1/price?day=2026-09-08` | The day's price, its source hash, and the oracle reading on X Layer, re-read and compared |
| `GET /api/v1/markets` | Every trading market: strike, day, YES price, pool depth, trading close |
| `GET /api/v1/hedge-quote?mw=10&day=2026-09-30&protectTo=80` | The YES ladder for a load, its cost from the pools, and payout scenarios |

Each paid call is priced at $0.01 in USDT0 on X Layer through OKX's x402
Payment SDK. Payment switches on once the OKX facilitator credentials are
set; until then every call is free and says so in an `X-GRIDFLEX-Payment`
header. A demo client, `web/scripts/hedge-agent.ts`, pays for the price,
the markets and a hedge quote, and can buy the ladder from its own wallet
on X Layer testnet. Full reference: [`shared/price-api.md`](shared/price-api.md).

### Tests

**627 automated tests, all passing** on 24 September 2026:

| Suite | Tests | Run it |
|---|---|---|
| Data pipeline, publisher, finalizer (Python) | 317 | `python3 -m unittest discover -s tests` |
| Contracts (Solidity, Foundry) | 54 | `cd contracts && forge test` |
| Web app logic and price API (TypeScript) | 256 | `cd web && node --test lib/*.test.ts` |

`./scripts/check_all.sh` runs all three plus data validation, lint and the
production build.

### Check it yourself

```sh
RPC=https://testrpc.xlayer.tech/terigon
ORACLE=0x970cefFC0e75bCa245F3337715992ad520A4D561

# Is the 8 Sep price final onchain?  -> true
cast call $ORACLE 'isFinal(bytes32,uint32)(bool)' $(cast keccak ERCOT_HBNORTH_DA_AVG) 20260908 --rpc-url $RPC

# Did YES win on 8 Sep?  -> true.   On 12 Aug?  -> false
cast call 0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1 'yesWon()(bool)' --rpc-url $RPC
cast call 0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07 'yesWon()(bool)' --rpc-url $RPC
```

---

## Why X Layer and OKX

- **Settlement lives on X Layer.** The oracle, the market factory, every
  market and every trade are X Layer contracts, and OKLink is the public
  record anyone can check.
- **The oracle is a public feed.** Any X Layer contract can read the
  verified Texas power price with `GridOracle.getReading(metricId, dayKey)`
  and check `isFinal()`, without trusting GRIDFLEX's site.
- **OKX AI is the distribution for data.** The price API is built to list
  on OKX AI, paid per call in USDT0 on X Layer through OKX's x402 Payment
  SDK, so agents can buy the price and hedge quotes without an account.
- **USDT0 is the path to mainnet.** Markets settle in MockUSDT on testnet.
  On mainnet the same contracts take X Layer's USDT0 as collateral.
- **OKX Wallet first.** The site finds every installed wallet and lists OKX
  Wallet first.

## Business model

- **API revenue:** $0.01 per call for the price, the markets and hedge
  quotes, paid by agents in USDT0 on X Layer.
- **Trading fees:** the next contracts add a swap fee paid to liquidity
  providers, with a protocol share. Today's pools charge none.
- **Two natural sides:** buyers whose costs rise with the price (miners,
  data centres) take YES; sellers whose income falls with it (wind and
  solar farms) take NO, so liquidity doesn't depend on speculators alone.
- **Regulation:** event contracts on a US commodity price are regulated in
  the US. GRIDFLEX runs on testnet with test tokens; a mainnet launch would
  exclude US persons or run through a licensed partner.

## How settlement works

1. **Fetch.** Each day's 24 hourly day-ahead prices at ERCOT North Hub are
   fetched and the raw responses cached untouched. The Texas power price is
   their average. A day missing any hour is skipped and logged, never
   averaged over what's there.
2. **Publish with a fingerprint.** The price is written to the oracle
   together with a SHA-256 hash of the exact source files it was computed
   from. The metric file in [`data/metrics/`](data/metrics/) lists those
   files by name and order, so anyone holding them can recompute the hash
   with `shasum -a 256`.
3. **Finalize.** After a one-hour dispute window, anyone can finalize the
   reading. Until then no market can use it.
4. **Resolve.** Anyone can call `resolve()` on a market once trading has
   closed and its reading is final. YES wins if the price is strictly above
   the strike. Winners redeem 1 MockUSDT per token.
5. **Fallback.** If no reading ever arrives, the market cancels and every
   YES and NO redeems for 0.5 MockUSDT, so no position is trapped.

**Trading closes an hour before the answer exists.** ERCOT publishes the
next day's day-ahead prices at 13:30 Texas time. Every market stops trading
at 12:30 Texas time on the day before, and the contract enforces it: buying
and swapping revert with `TradingClosed()` from that moment. Nobody can buy
a known answer ([`shared/demo-markets.md`](shared/demo-markets.md)).

On the site's verification view, each published reading is re-read from the
oracle live and compared with the committed file. A disagreement is shown as
`MISMATCH`, never retried away as a network error
([`shared/feed-spec.md`](shared/feed-spec.md)).

## Data source

Prices come from the [GridStatus](https://www.gridstatus.io) hosted API,
which redistributes ERCOT's public market data. Thanks to GridStatus for
making it available on a free plan.

The production path is direct access to ERCOT's own
[public API](https://apiexplorer.ercot.com/). It's geo-blocked from the UK,
where we build, which is why the hackathon build goes through GridStatus.
Only the fetch layer changes; the metric files, hashes and oracle stay the
same.

## Architecture

- **Data pipeline** (Python, repo root): `fetch_ercot.py` fetches and caches
  ERCOT prices, checks each day is complete, and writes one metric file per
  day with its source hash. `refresh_budget.py` keeps every refresh inside
  the free plan's row allowance.
- **Publisher and finalizer**: `publish.py` submits readings to the oracle;
  `finalize.py` finalizes them after the dispute window. Both dry-run unless
  given `--live`, and both check the chain before sending.
- **Contracts** (Solidity, [`contracts/`](contracts/)): `GridOracle` stores
  one reading per metric per day; `MarketFactory` creates markets;
  `BinaryMarket` holds fully collateralised YES/NO pairs, a zero-fee
  constant-product pool for swapping between them, and resolution;
  `OutcomeToken` and `MockUSDT` are ERC-20s.
- **Web app** ([`web/`](web/)): a landing page and a trading terminal that
  reads markets straight from the chain and trades through the user's
  wallet, deployed on Cloudflare Workers. No application backend.
- **Shared specs** ([`shared/`](shared/)): the frozen oracle interface,
  metric methodology, deployed addresses and demo evidence.

X Layer carries the whole settlement path: the oracle, every market and
every trade, with OKLink as the public record.

## What's next

- **Cash out before settlement.** Today a position can switch sides but not
  return to MockUSDT before the day settles (`redeem()` only opens at
  settlement).
  - `mergeSet` burns a matched YES and NO and returns exactly 1 MockUSDT.
    It is allowed in every market state, because a pair is worth exactly
    1 MockUSDT in all of them.
  - An atomic `sell` exits a one-sided position, which is what a buy
    leaves, in one wallet prompt with no approval.
  - Both ship together in one redeploy, after submission, because a new
    factory replaces every address above.
  - Before that redeploy, the resolver must also read the old factory's
    markets, and the market ledger must stop overwriting old records.

  Full design: [`shared/merge-set-spec.md`](shared/merge-set-spec.md).
- **Single-confirmation trading.** A buy is a mint and a swap, so the
  wallet asks twice even once its approvals are in place. A contract
  function that mints and swaps in one call, or EIP-5792 wallet batching,
  brings that down to one confirmation. Either needs new contracts and new
  markets.
- **Smart contract wallets.** OKX Wallet accounts created with a social
  login, such as Apple ID, are smart contract accounts rather than standard
  externally-owned accounts (EOAs). Our flow assumes an EOA, so a contract
  account can fail to sign or simulate transactions and can't be funded by a
  plain transfer in the usual way; full support needs EIP-4337 handling.
- **An AI hedging agent.** A miner says "keep my 10 MW hedged above $80";
  the agent, on OKX's Agentic Wallet, buys the price from the API each day
  and keeps the YES ladder topped up on X Layer. `web/scripts/hedge-agent.ts`
  is its first version.
- **One-prompt buying for smart accounts.** Wallets that batch calls
  (EIP-5792) can send approve, mint and swap as one prompt without new
  contracts.
- **Stop loss and take profit** orders on open positions.
- **More markets**: more days and strikes on the Texas power price.
- **A statewide price index**: what Texas as a whole paid for power each
  day, weighted by where it was used. It's already computed and published to
  the oracle; a market on it is the next listing.
- **Dated futures**: contracts on a week or month of prices, not just one
  day.
- **More US grids.** GridStatus already carries PJM, CAISO, MISO, NYISO,
  ISO-NE and SPP through the same client, so each is a new data source for
  the same pipeline.
- **Listing on exchange infrastructure.** The markets are self-contained
  contracts with no dependency on a host venue, so listing them on an
  exchange's own infrastructure is a deployment decision rather than a
  rewrite.

---

## For developers

- [`docs/technical-reference.md`](docs/technical-reference.md): running the
  pipeline, the metric definitions, hash verification, contract and web app
  setup, publishing and finalizing.
- [`shared/metrics.md`](shared/metrics.md): full methodology for every
  metric, including why the two daylight-saving changeover days can't
  settle.
- [`shared/oracle-interface.md`](shared/oracle-interface.md): the oracle's
  structs, functions and events.
- [`shared/deployment.md`](shared/deployment.md): deploying the contracts.
- [`docs/HANDOFF.md`](docs/HANDOFF.md): implementation status.

GRIDFLEX lists cash-settled contracts on a published price. Nothing on it is
redeemable for electricity.
