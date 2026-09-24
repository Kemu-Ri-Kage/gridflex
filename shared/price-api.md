# Texas power price API

A pay-per-call JSON API for the daily Texas power price that GRIDFLEX
publishes to its oracle on X Layer, the YES/NO questions that settle on
it, and hedge quotes built from them. Each paid call costs $0.01 in USDT0
through OKX's x402 Payment SDK, so AI agents can find and pay for it on
OKX AI (A2MCP). GRIDFLEX is a derivatives venue on a published price:
nothing here is redeemable for electricity. Markets run on X Layer
testnet and settle in mUSDT.

- Base URL: `https://gridflex-web.teslenko-platon.workers.dev/api/v1`
- Methods: `GET` only (plus CORS preflight `OPTIONS`)
- Network: `eip155:1952` (X Layer testnet) unless `X402_NETWORK` says otherwise

## Endpoints

| Path | Cost | What it answers |
|---|---|---|
| `GET /api/v1` | Free, always | Name, network, payment mode and price, endpoint list |
| `GET /api/v1/price?day=YYYY-MM-DD` | $0.01 | One day's Texas power price, its oracle reading on X Layer, and whether they match. `day` defaults to the latest day in the data. 404 `{ error, availableFrom, availableTo }` for a day with no price. |
| `GET /api/v1/markets?status=trading\|all` | $0.01 | The YES/NO questions: strike, day, status, YES and NO prices, pool reserves, when trading closes. Default `trading`. |
| `GET /api/v1/hedge-quote?mw=10&hours=24&day=YYYY-MM-DD&protectTo=80` | $0.01 | A ladder of YES tokens across one day's trading strikes that pays a load's extra cost above the lowest strike up to `protectTo`, with its cost and payout scenarios. Defaults: `mw` 10, `hours` 24, `protectTo` 80, `day` the earliest day with a trading market. 404 `{ error, tradingDays }` when nothing trades that day; 400 on a bad parameter. |

Every body is JSON. Prices are dollars per MWh (`value`, `strike`),
`valueCents` keeps the oracle's x100 integer, YES and NO prices are 0 to
1, and token amounts are whole tokens (6-decimal amounts converted, never
base units).

**Trust levels** (design-brief.md §6). `/price` is *verified* only when
`oracle.matches` is true: the oracle on X Layer holds exactly this value
and source hash (`verified: true`). A day that isn't published yet comes
back with `oracle.published: false` and `verified: false`. If X Layer
can't be reached, `oracle.checked` is false and nothing is claimed as
matched. `/hedge-quote` costs are *indicative*: they are worked out from
each pool's reserves now; a real buy is sent with its own on-chain quote
and a 0.50% slippage limit.

### Headers

- CORS: `Access-Control-Allow-Origin: *`; `PAYMENT-REQUIRED`,
  `PAYMENT-RESPONSE` and `X-GRIDFLEX-Payment` are exposed to browsers;
  `PAYMENT-SIGNATURE` and `X-PAYMENT` are allowed request headers.
- `X-GRIDFLEX-Payment: free` on every response while payments are off, and
  on `/api/v1` always; `x402` on the paid endpoints once they charge.
- `Cache-Control`: free answers are cacheable (`/api/v1` 300 s, `/price`
  60 s, `/markets` and `/hedge-quote` 15 s); a paid answer and any error
  are `no-store`, since each paid call is its own payment.

## How it is built

- Route handlers in the existing vinext app on Cloudflare Workers:
  `web/app/api/v1/{route.ts,price/route.ts,markets/route.ts,hedge-quote/route.ts}`.
  All logic is in `web/lib/price-api.ts` (tested in
  `web/lib/price-api.test.ts`); the routes only wire it to its inputs.
- Committed data: `web/app/api/v1/data.ts` imports
  `public/data/ERCOT_HBNORTH_DA_AVG.json`, `addresses.json` and
  `evidence-demo-day.json` at build time, so the Worker answers with the
  same files `/data/` serves in that deploy (no fetch to its own static
  assets). `refresh_data.sh` already rebuilds before it deploys, so the API
  follows every data refresh.
- Chain reads: one Multicall3 call per request reads every listed market's
  facts, state, price and reserves from the same block (kept for 5 s so
  `/markets` then `/hedge-quote` reads once); `/price` calls
  `GridOracle.getReading`. Market names, days and statuses come from
  `web/lib/market-facts.ts`, the same code the site uses (moved out of
  `lib/markets.tsx` so routes carry no React).
- Payments: `web/lib/x402-gate.ts` does what `@okxweb3/x402-next`'s
  `withX402` does, on plain `Request`/`Response`: verify the payment first,
  answer 402 with `PAYMENT-REQUIRED` when it is missing, run the handler,
  and settle only when the handler answered below 400, so a refused call is
  never charged. `x402-next` itself was not used: it imports the real
  `next/server` and pulls `next@16` into the app as a peer, beside vinext's
  own Next shims. `web/app/api/v1/payment.ts` builds the
  `OKXFacilitatorClient`, `x402ResourceServer` with `ExactEvmScheme` and
  `x402HTTPResourceServer` from `@okxweb3/x402-core` and
  `@okxweb3/x402-evm` on the first paid call.
- Payment mode: payments turn on only when all of `OKX_API_KEY`,
  `OKX_SECRET_KEY`, `OKX_PASSPHRASE` and `X402_PAY_TO` (a 0x address) are
  set as Worker secrets; `X402_NETWORK` is optional. With any one missing
  the API is free and no facilitator is built. On `eip155:1952` the asset
  is the SDK's default USDT0 at `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c`.

Not yet proven: a real paid call. No secrets exist in development, so the
responses below are free mode. The 402 challenge, settle-after-success and
no-settle-on-error paths are tested against a stubbed facilitator in
`web/lib/x402-gate.test.ts`.

## Example responses

Recorded from `pnpm dev --port 5301` on 24 Sep 2026, free mode.

`GET /api/v1`

```json
{
  "name": "GRIDFLEX Texas power price API",
  "description": "The daily Texas power price that GRIDFLEX publishes to its oracle on X Layer, the YES/NO questions that settle on it, and hedge quotes built from them. X Layer testnet; markets settle in mUSDT.",
  "network": "eip155:1952",
  "payment": { "mode": "free", "price": "$0.01", "asset": "USDT0", "payTo": null },
  "endpoints": [
    {
      "path": "/api/v1/price",
      "description": "The Texas power price for one day in USD/MWh, with its on-chain oracle reading on X Layer and whether the two match.",
      "params": { "day": "YYYY-MM-DD, optional. Defaults to the latest day in the data." }
    },
    { "path": "/api/v1/markets", "description": "…", "params": { "status": "\"trading\" (default) or \"all\"." } },
    { "path": "/api/v1/hedge-quote", "description": "…", "params": { "mw": "…", "hours": "…", "day": "…", "protectTo": "…" } }
  ]
}
```

`GET /api/v1/price?day=2026-09-08` (a verified day)

```json
{
  "metricId": "ERCOT_HBNORTH_DA_AVG",
  "name": "Texas power price",
  "unit": "USD/MWh",
  "day": "2026-09-08",
  "dayKey": 20260908,
  "value": 39.57,
  "valueCents": 3957,
  "verified": true,
  "sourceHash": "75999d0173983de904ad23e09e4b2de1536fa0929e23ae4700359d53593913c4",
  "sourceFiles": [
    "ercot_spp_day_ahead_hourly__HB_NORTH__2026-06-12__2026-07-01.json",
    "ercot_spp_day_ahead_hourly__HB_NORTH__2026-07-01__2026-08-01.json",
    "ercot_spp_day_ahead_hourly__HB_NORTH__2026-08-01__2026-09-01.json",
    "ercot_spp_day_ahead_hourly__HB_NORTH__2026-09-01__2026-09-10.json"
  ],
  "oracle": {
    "chainId": 1952,
    "address": "0x970cefFC0e75bCa245F3337715992ad520A4D561",
    "txHash": "0xf6bdfc4e4c775eca150fff4d380f915411d6bf4e5389d8e3228dfbeff00cb44f",
    "published": true,
    "final": true,
    "onchainValueCents": 3957,
    "matches": true,
    "checked": true
  }
}
```

`GET /api/v1/price` (the default: the latest day, not yet published)

```json
{
  "metricId": "ERCOT_HBNORTH_DA_AVG",
  "name": "Texas power price",
  "unit": "USD/MWh",
  "day": "2026-09-24",
  "dayKey": 20260924,
  "value": 41.6,
  "valueCents": 4160,
  "verified": false,
  "sourceHash": "2ccc362154808dab34e2226003d94eeb2cfff527e5494f70fee5ce2ef2fce011",
  "sourceFiles": [],
  "oracle": {
    "chainId": 1952,
    "address": "0x970cefFC0e75bCa245F3337715992ad520A4D561",
    "txHash": null,
    "published": false,
    "final": null,
    "onchainValueCents": null,
    "matches": null,
    "checked": true
  }
}
```

`sourceFiles` lists the raw source files only for the day whose evidence
the site publishes (`evidence-demo-day.json`); every other day is
identified by its `sourceHash`.

`GET /api/v1/markets` (two of the five trading markets)

```json
{
  "markets": [
    {
      "address": "0x204Ef0871892c52b7Abf00AC4755333c5e7F73af",
      "question": "Will Texas power cost more than $45 on 30 Sep?",
      "day": "2026-09-30",
      "dayKey": 20260930,
      "strike": 45,
      "status": "trading",
      "yesPrice": 0.5005,
      "noPrice": 0.4995,
      "yesReserve": 9990.009991,
      "noReserve": 10010,
      "tradingClosesAt": "2026-09-29T17:30:00.000Z",
      "yesWon": null,
      "yesToken": "0x15Ab31AC0116E768650499dE165627EE5E33D368",
      "noToken": "0xD64afc93D02BC14dEcf36A6860e7BDdC24d9ffca"
    },
    {
      "address": "0x4f8eCF1f34727d57797158634576DC8dbFF7b13d",
      "question": "Will Texas power cost more than $40 on 30 Sep?",
      "day": "2026-09-30",
      "dayKey": 20260930,
      "strike": 40,
      "status": "trading",
      "yesPrice": 0.5,
      "noPrice": 0.5,
      "yesReserve": 10000,
      "noReserve": 10000,
      "tradingClosesAt": "2026-09-29T17:30:00.000Z",
      "yesWon": null,
      "yesToken": "0x5b1bbDe179EB64bDa299dBFaF9ca5Ef23c6218d9",
      "noToken": "0xe9d83b4c4b960bEfECBe0189793A7639F2684a68"
    }
  ]
}
```

`GET /api/v1/hedge-quote?mw=10&hours=24&day=2026-09-30&protectTo=80`

```json
{
  "day": "2026-09-30",
  "mw": 10,
  "hours": 24,
  "mwh": 240,
  "protectTo": 80,
  "rungs": [
    { "market": "0x4f8eCF1f34727d57797158634576DC8dbFF7b13d", "strike": 40, "tokens": 1200, "yesPrice": 0.5, "cost": 617.983829 },
    { "market": "0x204Ef0871892c52b7Abf00AC4755333c5e7F73af", "strike": 45, "tokens": 8400, "yesPrice": 0.5005, "cost": 5050.066799 }
  ],
  "totalCost": 5668.050628,
  "scenarios": [
    { "price": 40, "extraCost": 0, "payout": 0, "covered": null },
    { "price": 45, "extraCost": 1200, "payout": 1200, "covered": 1 },
    { "price": 80, "extraCost": 9600, "payout": 9600, "covered": 1 },
    { "price": 160, "extraCost": 28800, "payout": 9600, "covered": 0.3333 }
  ],
  "notes": [
    "Each YES pays 1 mUSDT if the Texas power price for 30 Sep 2026 settles above its strike. The ladder pays the extra cost of 240 MWh above $40/MWh up to $80/MWh; above that it stays at 9,600 mUSDT.",
    "Indicative: costs are worked out from each pool's reserves now, including the price impact of the buy. A buy is sent with its own on-chain quote and a 0.50% slippage limit.",
    "Markets settle on the verified daily Texas power price published to the oracle on X Layer testnet, in mUSDT."
  ]
}
```

The ladder is `web/lib/hedge.ts`'s `ladder()`: 240 MWh x ($45 - $40) = 1,200
YES on $40 and 240 x ($80 - $45) = 8,400 YES on $45; each `cost` is
`yesCostFor(tokens, yesReserve, noReserve)` and includes the price impact
of buying that many from a 10,000-token pool.

`GET /api/v1/hedge-quote?mw=-5` → 400

```json
{ "error": "mw must be a number of megawatts above 0 and at most 10,000." }
```

`GET /api/v1/price?day=2020-01-01` → 404

```json
{ "error": "No Texas power price for 2020-01-01.", "availableFrom": "2025-09-10", "availableTo": "2026-09-24" }
```

## What you do

The API ships free. These steps turn payments on and list it on OKX AI.
Type every secret yourself; none belongs in a file, a commit or a chat.

1. **Deploy the API.** Merge this branch and deploy as usual
   (`./refresh_data.sh`, or `cd web && pnpm build && pnpm exec wrangler deploy --config dist/server/wrangler.json`).
   Check `curl https://gridflex-web.teslenko-platon.workers.dev/api/v1`
   answers with `"mode": "free"`.
2. **Create an OKX API key.** In the OKX Developer Portal, create an API
   key for the x402 facilitator and note its key, secret key and
   passphrase. See
   [the seller SDK guide](https://web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk).
3. **Pick the payee.** An X Layer address you control that receives the
   USDT0 (public address only).
4. **Set the Worker secrets.** From the repo root:

   ```bash
   cd web
   pnpm exec wrangler secret put OKX_API_KEY --name gridflex-web
   pnpm exec wrangler secret put OKX_SECRET_KEY --name gridflex-web
   pnpm exec wrangler secret put OKX_PASSPHRASE --name gridflex-web
   pnpm exec wrangler secret put X402_PAY_TO --name gridflex-web
   # optional; defaults to eip155:1952 (X Layer testnet)
   pnpm exec wrangler secret put X402_NETWORK --name gridflex-web
   ```

   Wrangler prompts for each value. Secrets apply to the live Worker
   without a rebuild.
5. **Check it charges.** `curl -i .../api/v1` now shows
   `"mode": "x402"` and your payee; `curl -i .../api/v1/price` answers
   `402` with a `PAYMENT-REQUIRED` header and `X-GRIDFLEX-Payment: x402`.
   To switch payments off again, `wrangler secret delete OKX_API_KEY --name gridflex-web`.
6. **List it on OKX AI.** Register the service with base URL
   `https://gridflex-web.teslenko-platon.workers.dev/api/v1`, following
   [How to MCP](https://web3.okx.com/onchainos/dev-docs/okxai/howtomcp).
   `GET /api/v1` describes every endpoint and its price for the listing.
7. **Test a paid call.** Run the hedging agent below against the live site
   (`node web/scripts/hedge-agent.ts`). It prints its wallet address; send
   that address a little testnet USDT0 on X Layer (each call is $0.01).
   Run it again: each call should print "Paid $0.01 in USDT0 on X Layer …"
   with the settlement transaction, and your payee's USDT0 balance rises
   by $0.03.
