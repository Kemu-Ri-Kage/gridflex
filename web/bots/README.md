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
