# GRIDFLEX web

Vinext/React frontend for the GRIDFLEX demo market on X Layer testnet.

## Run locally

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Without contract addresses the app intentionally runs in preview mode. Copy `.env.example` to
`.env.local` after deployment and fill the four public addresses to enable wallet transactions.
Never put a private key in the web environment.

## Validate

```bash
pnpm lint
pnpm build
```

The wallet flow supports X Layer testnet switching, test collateral minting, complete-set minting,
YES/NO swaps, permissionless resolution, and redemption. The trade panel also exposes a WebMCP
tool that stages (but never signs or submits) a trade in supported clients.
