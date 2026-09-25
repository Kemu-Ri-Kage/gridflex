# GRIDFLEX web

Vinext/React frontend for the GRIDFLEX demo market on X Layer testnet.

## Run locally

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The app needs no environment to run. Contract addresses and the list of markets come from
`public/data/addresses.json`, written from `shared/addresses.json` by `build_feed_data.py` at the
repository root; run that script after creating a market so the site lists it. `.env.example`
documents the optional overrides. Never put a private key or an API key in the web environment:
every `NEXT_PUBLIC_*` value is compiled into the public bundle. The price API's payment secrets
(`OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `X402_PAY_TO`) are Worker secrets, never files.

## Validate

```bash
pnpm lint
pnpm build
```

The wallet flow supports X Layer testnet switching, test collateral minting, complete-set minting,
YES/NO swaps, permissionless resolution, and redemption.
