# gridflex-bots

One Cloudflare Worker on a timer, no web pages:

| Timer | Bot | What it does |
| --- | --- | --- |
| every minute | price bot (`lib/price-bot.ts`) | puts each new 5-minute ERCOT North Hub price in `LivePriceFeed` |
| every minute, after the price bot | keeper (`lib/keeper.ts`) | fills pending `TexasPowerPerp` orders and pool requests at their fill round (anyone may; the result is fixed by the round, the keeper only makes it prompt) |
| every 5 minutes | quote bot (`lib/quote-bot.ts`) | lists the next seven Texas days in `TexasPowerOptions` and posts call and put quotes on nine $5 strikes; each post also fills that day's pending orders |

GitHub's timer can run 10 to 30 minutes late, which is why these run here and the
daily settle job stays on GitHub.

## Safety

- Dry run by default: nothing is sent unless `LIVE` is `yes` and the bot's own key is set.
- Each bot has its own replaceable key, set as a Worker secret by whoever deploys:
  `REPORTER_PRIVATE_KEY` (the feed's reporter), `QUOTER_PRIVATE_KEY` (the options'
  quoter) and `KEEPER_PRIVATE_KEY` (any funded address; it holds no rights). Never an owner key, never the old GridOracle v1 reporter key, never in code.
  If a key leaks, the contract owner replaces it and the guardian pauses meanwhile.
- The price bot only publishes finished intervals, in order, inside ERCOT's own limits,
  and after an outage only the newest three, so the index returns without trading on a gap.
- The price bot asks GridStatus only when a new interval is due (about 288 reads a day).

## When options stop trading

An expiry must stop trading before anyone can know its settlement price. While
`TexasPowerOptions` settles on `ERCOT_HBNORTH_DA_AVG`, that is 12:30 Texas time the day
before (`OPTIONS_CLOSE` = `dayAheadAuction`, the default), because ERCOT's day-ahead
auction publishes that average at about 13:30. Use `dayStart` only for a deployment that
settles on a real-time daily average.

## Going live, in order (David deploys the contracts)

1. Deploy `LivePriceFeed` and `TexasPowerOptions` (branches `feat/live-price-feed`,
   `feat/options-market`) with an offline owner, the guardian wallet, and two fresh bot
   addresses as reporter and quoter. Give the two bot addresses test OKB for gas.
2. Put the contract addresses in `wrangler.jsonc` (`FEED_ADDRESS`, `PERP_ADDRESS`, `OPTIONS_ADDRESS`).
3. From `web/`: `pnpm exec wrangler deploy --config bots/wrangler.jsonc`, then add the
   secrets, each typed in by hand:
   `pnpm exec wrangler secret put GRIDSTATUS_API_KEY --config bots/wrangler.jsonc`
   (and the same for `REPORTER_PRIVATE_KEY`, `QUOTER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`).
4. Watch the dry-run logs for a day (`pnpm exec wrangler tail --config bots/wrangler.jsonc`).
5. Set `LIVE` to `yes` and deploy again.

The quote bot prices from the daily averages in `public/data/ERCOT_HBNORTH_DA_AVG.json`
as of the deploy; redeploy after a data refresh to give it the latest days.

## Checking it locally

`bots/e2e-local.ts` runs both bots in live mode against the real contracts on a local
anvil chain (anvil's public test accounts; GridStatus replaced by fixed rows): the price
bot publishes three rounds and the index is checked on chain, the quote bot lists seven
days and posts quotes, and a buy order fills at the next post. Build both contracts with
`forge build`, start `anvil --port 8546`, then from `web/`:
`node bots/e2e-local.ts <contracts/out>`.

## Rehearsing the real launch on a fork

`bots/rehearse-fork.ts` rehearses the launch end to end on a local fork of X Layer
testnet, with the real GridOracle and MockUSDT. Run 10 Nov 2026: the deploy, the three
bots and the three screens all worked together (index $45.98, a 10 MWh long filled at
$45.98, a $45 call filled at 65 cents).

1. `anvil --fork-url https://testrpc.xlayer.tech/terigon --port 8547 --chain-id 1952`
2. Deploy with `contracts/script/DeployDerivatives.s.sol` (branch
   `feat/derivatives-deploy`) to `http://127.0.0.1:8547` with `--unlocked --sender` anvil
   account 9, owner account 0, guardian 2, reporter 1, quoter 3, and the GridOracle and
   MockUSDT addresses from `shared/addresses.json`.
3. Add the three printed addresses to `shared/addresses.json`, run
   `python3 build_feed_data.py`.
4. From `web/`: `node bots/rehearse-fork.ts`. It runs the price bot, seeds both pools,
   runs the quote bot, places a futures long and an option buy for anvil account 4,
   publishes the next price, runs the keeper and the quote bot again, and checks that both
   orders filled.
5. To see the screens, point `XLAYER_TESTNET_RPC_URLS` in `lib/contracts.ts` at the fork
   in a scratch copy only (never commit that), then `pnpm dev` and open /futures,
   /options and /hedge.

## Stress-testing the markets with many wallets

`sim/market-sim.ts` runs the futures and options contracts, with the deploy script's
settings, against 200 trader wallets and 10 pool providers on a local anvil chain it starts
itself (anvil's public test mnemonic; it refuses anything but its own chain 31337). It
replays nine days of real 5-minute ERCOT North Hub prices (15 to 23 September 2026, with
spikes above $300 and dips below -$50, in `sim/data`) through the real price bot, keeper and
quote bot, settles options on the real day-ahead averages, and adds the edge cases on a
schedule: band-edge prices, missed prices, bot outages, pauses, cancels, a burst of 320
orders in one block. Every fill, fee, funding charge, payout and settlement is checked
against an independent model (`sim/model.ts`), and the books are reconciled with the
contracts' balances after every transaction (`sim/ledger.ts`); every 3 hours every holder must
be able to close, withdraw, sell back or claim. It ends with targeted cases (each on a
snapshot of the chain) and a wind-down where everyone exits and the contracts must end empty.

Needs foundry (`forge`, `anvil`) and the web dependencies. From `web/`:

```bash
node sim/market-sim.ts
```

About 15 to 25 minutes. `--days 2` for a quick run, `--seed <n>` for a different but
repeatable crowd, `--lambda <n>` for trader actions per 5 minutes (default 5),
`--skip-scenarios` to leave out the targeted cases. Results go to `sim/out/report.md` (and
`report.json`). `node --test sim/model.test.ts` tests the model itself. To rebuild the price
file from GridStatus downloads: `node sim/build-price-fixture.ts ../data/raw 2026-09-15 10`.
