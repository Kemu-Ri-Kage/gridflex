# GRIDFLEX demo video script — v2, the finals cut

A 3:50 demo (the rules allow 2 to 4 minutes). Every on-screen string below
is from the live site (<https://gridflex-web.teslenko-platon.workers.dev>)
after the 24 September terminal redesign. Transactions that already exist
are in `shared/demo-evidence.md`. The rest are made on camera by the demo
wallet and the agent wallet.

**Figures that can move before you record.** The hero figures ($19.26,
$95.33) change only if `./refresh_data.sh` runs with a fetch, so don't run
one before recording. YES/NO cents change whenever anyone trades. Say what
the screen shows, not what's written here.

## What the judges score, and where the video earns it

The Builder Kit scores innovation, product completeness, user value,
technical execution, meaningful integration with X Layer and/or OKX AI,
growth potential and contribution to the OKX ecosystem. It publishes no
weights. For "Build a Market", the video must show a working integration
on X Layer, contract addresses, and the working flow. GRIDFLEX's RWA angle
is a real-world commodity price, verified and settled on chain.

| Criterion | The beat that proves it | Time |
|---|---|---|
| User value | A 10 MW miner sizes a hedge in dollars, then buys it | 1:58 |
| Innovation | A hash-verified power price, sold to AI agents per call | 0:42, 3:02 |
| Completeness | Connect, fund, buy, hedge, resolve and redeem, all live | 1:14–2:58 |
| Technical execution | Anyone can recompute the fingerprint; trading closes before the price exists | 0:42, 2:28 |
| X Layer / OKX AI | Oracle, markets, payments and the agent's trades, all on X Layer | 1:02, 3:02 |
| OKX ecosystem | OKX Wallet (incl. social-login smart accounts), x402 Payment SDK, OKX AI listing, USDT0 path | 1:18, 3:02, 3:30 |
| Growth | Miners buy YES, wind and solar buy NO; API calls and pool fees | 3:30 |

## How we beat the competition

Reins (@ReinsOKX, "AI agents can spend money now…") posted a 25-second
motion-graphics teaser: a light, glassy 3D render, kinetic type, and one
line that names three roles, "Reins decides. OKX executes. X Layer
settles." Take the craft, not the look:

- **One line that names the roles.** Ours: *"Texas sets the price.
  GRIDFLEX proves it. X Layer settles."* It opens the video on a title
  card and closes it on the end card.
- **Motion graphics only as chapter cards.** Everything between them is
  the real product working, which their teaser doesn't show. The Builder
  Kit asks for "the working product and integration".
- **Agents without the hype.** Their product is agents' budgets. Our agent
  beat shows an agent paying for verified data and buying a real hedge on
  X Layer: proof, not a render.

## The pitch, in 30 seconds

For the submission form, the video's opening and the finale:

> Texas power can cost five times more at 6pm than at 11am. Bitcoin miners
> and data centres pay that swing, and the only hedge is a futures broker
> and contracts too big for them. GRIDFLEX lists YES/NO markets on the
> daily Texas power price. Every price is fingerprinted from its source
> files and published to an oracle on X Layer, so anyone can check it. A
> miner types their megawatts and gets a hedge in dollars. AI agents pay a
> cent a call for the same verified price. Texas sets the price. GRIDFLEX
> proves it. X Layer settles.

---

## Script

`TC` is a title card from `shared/video/title-cards.html` (open it in
Chrome full screen; → advances; `?card=N` opens card N). Everything else
is a screen recording of the live site, the agent's terminal or OKLink.

| Time | What I say | What's on screen | Serves |
|---|---|---|---|
| **0:00** | *(silent, 2s)* | Landing page loads: the headline reveals word by word; the 3D price grid rises row by row. | UV |
| 0:02 | "Texas power cost nineteen dollars at eleven in the morning." | Hero: **Texas power cost $19.26 at 11am and $95.33 at 6pm.** Hover the green bar in the front row of the grid. | UV |
| 0:06 | "And ninety-five dollars at six that evening. Five times the price, seven hours apart." | Hover the red 18:00 bar: *24 Sep 2026 · 18:00 Central · $95.33/MWh*. Drag the grid a little to turn it. | UV |
| 0:12 | "Bitcoin miners pay that price. So do the AI data centres now arriving in Texas." | Grid still turning under the cursor. | UV, GRO |
| 0:17 | "Institutions hedge it on ICE, through a futures broker, in contracts of hundreds of megawatt-hours. Miners can't." | ICE tab: the monthly ERCOT North peak future, contract size in view. | INN, GRO |
| **0:24** | "So we built GRIDFLEX." | **TC 1**: *Texas sets the price. / GRIDFLEX proves it. / X Layer settles.* | INN |
| 0:28 | "Texas sets the price. GRIDFLEX proves it. X Layer settles." | TC 1 finishes its three lines. | XL |
| **0:34** | *(silent, 1s)* | **TC 2**: *01 / Verify*. | TECH |
| 0:36 | "Twenty-four hourly prices from Texas's official grid, averaged." | Landing **02 / How we verify**: **01 Source**, then **02 Compute**. | TECH |
| 0:42 | "Then fingerprinted: a SHA-256 hash of the exact source files. Anyone can recompute it." | **02 Compute**: the hash `75999d01…13c4` and the `shasum -a 256` line. | TECH, INN |
| 0:48 | "And published to our oracle on X Layer." | **03 Publish** → click the *Oracle tx* link. | XL |
| 0:52 | "Confirmed on chain, for any market or app to read." | OKLink tab: tx `0xf6bdfc4e…cb44f`, *Success*, sent to `GridOracle`. | XL |
| **0:57** | *(silent, 1s)* | **TC 3**: *02 / Trade*. | COMP |
| 0:59 | "This is the terminal. Markets by maturity: tomorrow, this week, later." | `/trade`: the market list's *Next day* / *This week* groups, each row with its YES price, the green/red bar and *Closes in*. The panels rise into place on load. | COMP, UV |
| 1:05 | "Every settled day, and every strike, on one chart." | Click **Will Texas power cost more than $40 on 30 Sep?** The header's YES/NO figures tick to the new market; the chart's amber $40 line and the faint $45 line above it. | UV, INN |
| 1:11 | "The question is simple. Will Texas power cost more than forty-five dollars on 2 October? YES is fifty cents." | Click the 2 Oct $45 market. Header: **YES 50¢ · NO 50¢**, strike $45.00, *Closes in …*. Say the cents the header shows. | UV |
| **1:18** | "Connect OKX Wallet. Social-login smart accounts work too." | **Connect wallet to trade** → OKX Wallet → approve. | OKX, COMP |
| 1:23 | "Take a thousand test dollars to trade with." | **Get 1,000 test mUSDT**, confirm; the receipt pops in: *Confirmed · View on OKLink*. | COMP |
| 1:28 | "Buy YES, a hundred. To win: about a hundred and ninety-nine." | Click **YES**, then the **100** chip. *To win* counts up to ~199 mUSDT; *Pay 100 mUSDT · max loss 100 mUSDT*. | UV |
| 1:34 | "The ticket shows every wallet prompt before I send it: two approvals, then the trade." | The numbered *Wallet prompts* list. Click **Buy YES · 100 mUSDT**. | COMP, TECH |
| 1:39 | "Each one is its own transaction on X Layer." | Prompts 1–4, each step's number turning into a drawn check. **Edit:** jump-cut the waits, label the cut *4 confirmations, sped up*. Receipt: *Confirmed*. | XL, COMP |
| 1:47 | "Positions and history read straight back from the chain." | **Positions** tab, then **History**: *Approve mUSDT · Mint YES + NO · Approve NO · Swap (Buy YES)* with block numbers. | TECH |
| **1:54** | *(silent, 1s)* | **TC 4**: *03 / Hedge*. | UV |
| 1:56 | "Now the customer. A ten-megawatt miner. Power over forty-five dollars hurts." | **Hedge** tab, *One day*: 10 MW, 24 hours, protect to $80. | UV |
| 2:01 | "GRIDFLEX builds a ladder of strikes, and shows in dollars what it pays at sixty, eighty, a hundred." | The ladder rows and the scenario table. | UV, INN |
| 2:07 | "Or keep the whole week covered." | Switch to **Week strip**: seven days, cost and payout per scenario. | UV, COMP |
| 2:12 | "One click loads it into the ticket." | **Load** → the ticket fills in (side, amount). Don't buy on camera. | COMP |
| **2:16** | *(silent, 1s)* | **TC 5**: *04 / Settle*. | TECH |
| 2:18 | "Now one market, start to finish. It replays 11 September 2025, a day that has already settled." | Market list, **Will Texas power cost more than $25 on 11 Sep 2025?**. Pay line under the question. | TECH |
| 2:24 | "Buy YES, a hundred." | Four prompts, jump-cut. | COMP |
| 2:28 | "Forty-five minutes later, trading has closed. Live markets always close before the price is published." | **Cut.** Status *Awaiting*, the ticket's **Resolve market** button. | TECH |
| 2:34 | "Anyone can resolve. The contract reads the oracle itself: twenty-six thirty-eight, above twenty-five. YES wins." | Click **Resolve market**, confirm. Header: *Outcome YES*. **Settlement** tab: *Oracle reading $26.38/MWh*. | TECH, XL |
| 2:42 | "YES won, so the portfolio flags the winnings. Redeem all: a hundred in, a hundred and ninety-nine out." | The winnings banner → **View portfolio** → **Redeem all**, confirm; the receipt pops in. (The ticket's **Redeem … mUSDT** does the same for one market; use it if the banner doesn't show.) | COMP, UV |
| 2:53 | "It's settled real days too: 8 September resolved YES." | OKLink: resolve tx `0x004e9ae0…7b216`. | XL |
| **2:58** | *(silent, 1s)* | **TC 6**: *05 / Agents*: *$0.01 per call · X Layer · OKX AI*. | OKX |
| 3:00 | "The same verified price is an API for AI agents, built to list on OKX AI." | Terminal: `node web/scripts/hedge-agent.ts --mw 1 --execute`. | OKX, INN |
| 3:05 | "This agent has its own wallet on X Layer. It pays a cent a call, over OKX's x402, for the price, the markets and a hedge quote." | *Paid $0.01 in USDT0 on X Layer for …* lines with their transactions. **If payments aren't switched on:** the lines read free; say "Each call is priced at a cent through OKX's x402 SDK." instead. | OKX, XL |
| 3:13 | "Then it buys the hedge itself, on chain." | *Buying YES on the $… strike …* lines, *Hedge placed.*, one OKLink tx opened. | XL, INN |
| **3:20** | *(silent, 1s)* | **TC 7**: *06 / Two natural sides*: Miners buy YES · Wind & solar buy NO · API + fees. | GRO |
| 3:22 | "Miners lose when power is dear, wind and solar farms when it's cheap. Each side hedges the other." | TC 7 figures. | GRO |
| 3:28 | "We earn on every API call, and on pool fees." | TC 7, *Revenue* figure. | GRO |
| 3:32 | "Next: cashing out before settlement, weekly and monthly contracts, other US grids, and USDT0 on X Layer mainnet." | README, **What's next**. | GRO, OKX |
| 3:41 | "GRIDFLEX. Texas sets the price, we prove it, X Layer settles." | **TC 8**: end card with the live link, the code link and *X Layer · OKX Wallet · OKX x402 Payment SDK*. | — |
| **3:50** | *End* | | |

---

## Production: what makes it look high-end

- **Screen recorder with automatic zoom.** Screen Studio (macOS) or the
  free Cap: they zoom smoothly onto each click and smooth the cursor. That
  is most of the "produced" look. Record the browser at 1440×900, export
  1080p at 60 fps.
- **Title cards** from `shared/video/title-cards.html`: record each card
  full screen for 3–4 seconds, and cut them in where the script says TC.
  Their motion (word reveal, bars rising, rule drawing) matches the site's.
- **Voice last.** Lock the picture, then record the voiceover in one quiet
  take per section, with the mic 15 cm away. Normalise to about −16 LUFS.
- **Music:** one quiet instrumental bed, about 20 dB under the voice. Use
  royalty-free music only (YouTube Audio Library, Artlist, Epidemic).
- **Burned-in captions.** Judges often watch muted. CapCut's auto-captions
  are fine; check every figure by hand.
- **Cuts:** jump-cut every wallet wait, and mark sped-up waits on screen
  ("4 confirmations, sped up"). Hold every number the voice says for at
  least one second.
- **Look:** one browser window, no bookmarks bar, 100% zoom, dark mode,
  Do Not Disturb on, and the same wallet account throughout.
- **Thumbnail/cover:** TC 1 (the three-line tagline) as a still.

## Timing and cuts

Runs **3:50**, 10 seconds under the 4-minute limit. If a take runs long,
cut in this order:

| Section | Length | If a take runs long |
|---|---|---|
| 0:00 Hook | 24s | **Untouchable.** 0:12 can go (saves 5s). |
| 0:24 Tagline | 10s | **Untouchable.** It's the line judges remember. |
| 0:34 Verify | 23s | Keep 0:42 and 0:48; drop the OKLink beat at 0:52 (saves 5s). |
| 0:57 Trade | 57s | **Untouchable core:** connect, buy, prompts. 1:05 (the chart) goes first (saves 6s). |
| 1:54 Hedge | 22s | Drop the week strip at 2:07 (saves 5s). |
| 2:16 Settle | 42s | 2:53 (8 Sep on OKLink) can go (saves 5s). Never cut Resolve or Redeem. |
| 2:58 Agents | 22s | **Untouchable.** It's the OKX AI proof. |
| 3:20 Business | 21s | Keep 3:22 and the end card; drop 3:32 (saves 9s). |

## Record in this order (the replay market's 45-minute clock)

1. **Before the clock**, off camera:
   - Create the daily ladder, `create_markets.py --market 8 … --market 17
     --live`, so the Hedge tab's week strip covers seven days.
   - Redeploy. Rehearse once with a throwaway account.
   - Record the title cards, the landing beats (0:00–0:56), the ICE page
     and the OKLink beats.
2. **T−2:** `python3 create_markets.py --market 1 --live` (the replay
   market). Then redeploy (`./refresh_data.sh --no-fetch`, T0→T+8).
3. **T+10:** record 0:57–1:53 (terminal, connect, fund, buy, positions).
4. **T+20:** record the replay buy (2:18–2:27). **It must be confirmed by
   T+40.**
5. **T+22 → T+44:** record the Hedge tab (1:54–2:15) and the agent run
   (2:58–3:19).
6. **T+46:** record 2:28–2:52: *Awaiting*, **Resolve market**, then
   **Portfolio → Redeem all**.

## Shot list

### Browser tabs, in this order

Use one clean Chrome profile. The only extension should be the wallet.
Hide the bookmarks bar. Set zoom to 100%, with the window at 1440×900 or
larger.

1. <https://gridflex-web.teslenko-platon.workers.dev/>. Don't load it until
   recording starts, so the headline reveal is captured.
2. <https://www.ice.com/products/6590337/ERCOT-North-345KV-Real-Time-Peak-Fixed-Price-Future>,
   scrolled so the contract size is in view.
3. <https://www.oklink.com/x-layer-testnet/tx/0xf6bdfc4e4c775eca150fff4d380f915411d6bf4e5389d8e3228dfbeff00cb44f>
   is the 8 Sep oracle reading. The diagram's link opens this. Keep it
   pre-loaded as a backup.
4. <https://gridflex-web.teslenko-platon.workers.dev/trade>. It opens on
   the market that settles soonest (under *Next day*); the script clicks
   30 Sep $40 and then 2 Oct $45 on camera, so leave it as it loads. Check
   the chart shows **Settlement price** and **90 days**.
5. <https://www.oklink.com/x-layer-testnet/tx/0x004e9ae0e4fa95f5519d3f9ad274b695bedefd21af2bdcafeff3cc47dc97b216>
   is the 8 Sep resolve.
6. The repo README on GitHub, scrolled to **What's next**. This is the
   footer's *Source on GitHub* link.
7. `shared/video/title-cards.html`, opened from Finder in its own full-screen
   window. Record the cards separately and cut them in.

Plus one terminal window for the agent (2:58), large font (18 pt+), dark
theme, nothing else in its history: `cd ~/Desktop/gridflex` and the
agent command typed but not yet run. Its wallet needs test OKB from the
X Layer faucet, and `--fund` once off camera for mUSDT
(`shared/price-api.md`, "The hedging agent").

Load every OKLink tab once before recording, so none of them loads on camera.

### Wallet, before recording

- **Account:** a new account that has never touched GRIDFLEX. Don't use the
  deployer `0x27Aa…e902`. Don't use `0xD95B…8059` either: it already holds
  90 mUSDT and 90 NO of approval on 2 Oct, which would skip two of the four
  prompts, and its old trades would crowd History.
- **Network:** X Layer Testnet, added and selected in the wallet in advance.
  - Chain ID `1952`, currency `OKB`.
  - RPC `https://testrpc.xlayer.tech/terigon`. The backup is
    `https://xlayertestrpc.okx.com/terigon`.
  - Explorer `https://www.oklink.com/x-layer-testnet`.
- **OKB: 0.01 test OKB, sent by `fund_demo_wallet.py`.** The take sends 13
  transactions:
  - 1 demo mUSDT mint
  - 4 for the 2 Oct buy
  - 2 for the switch
  - 4 for the replay buy
  - resolve and redeem

  At most about 964,000 gas in all, which is **0.00002 OKB** at the 0.02 gwei
  gas price read on 23 September. 0.01 OKB covers that about 500 times over,
  enough for gas spikes, the wallet's upfront fee reserve, and a spare-market
  retake (4 more buys' worth plus resolve and redeem). The per-transaction
  figures are in the script's `DEMO_TRANSACTIONS`: measured receipts where
  one exists, otherwise the worst case in `forge test --gas-report`.
  - **Dry run:** `python3 fund_demo_wallet.py --to 0xNEW` checks the chain,
    shows the account's OKB, mUSDT and transaction count and whether it's
    fresh, and loads no key.
  - **Send:** `python3 fund_demo_wallet.py --to 0xNEW --live` sends it from
    the deployer after a typed `yes`. It refuses any address recorded in
    `shared/addresses.json` and any contract, and caps at 0.05 OKB.
  - Run it off camera, like `create_markets.py`. It asks for the keystore
    password.
  - **Alternatively,** any wallet that already holds test OKB can send it. It
    has to be a plain OKB transfer: no mUSDT, no approvals, nothing on any
    market. The script's value is that it can't send anything else.
- **mUSDT: 0. No script.** The *Get 1,000 test mUSDT* button calls
  `MockUSDT.mint`, which any account may call, and it's on camera at 1:30.
  1,000 covers 100 on 2 Oct, 100 on the replay, and 100 more if the spare is
  needed.
- **Not connected to the site.** If the account has connected before, remove
  the site from the wallet's connected sites, so *Connect* is real.
- **Check it's still fresh** just before recording: the dry run must say
  `Fresh: yes` and show 0 transactions sent. Receiving OKB doesn't count.
- If you use OKX Wallet, check beforehand that it answers the site's
  connect request, not another installed wallet.

### Prepare beforehand, so nothing is made on camera that doesn't need to be

- Only the replay market is created for the video, and it's created off
  camera. Everything else already exists on chain.
- `create_markets.py` mints its own 10,000 mUSDT of starting liquidity for
  each market, so the deployer needs only OKB for gas: about 0.00006 OKB per
  market. It held 0.1998 OKB on 23 September.
- Don't run `./refresh_data.sh` with a fetch on recording day. It can change
  the hero's figures.
- Do one full rehearsal on the 26 Sep market with a second throwaway account,
  funded the same way. That times the wallet prompts on the day without
  touching the replay market or the recording account.

### The replay market: when to create it, and how long each step takes

Each replay market **can be created only once**: `create_markets.py` skips a
metric and day that already exist. In live mode it also refuses to create a
replay market that `--market` didn't name, so a run can never start a replay
clock by accident. There are two:

| Row | Question on screen | Strike | Published price | Result | Create with |
|---|---|---|---|---|---|
| 1 | Will Texas power cost more than $25 on 11 Sep 2025? | $25.00 | $26.38 | YES | `--market 1` |
| 5 (spare) | Will Texas power cost more than $20 on 10 Sep 2025? | $20.00 | $22.62 | YES | `--market 5`, only if market 1's take fails |

Both readings were confirmed published and finalized on chain by the dry run
on 23 September. 10 Sep 2025 is the only other Texas power price day with a
finalized reading and no market (8 Sep 2026 already has one).

Trading closes **45 minutes after creation.** Any buy can happen anywhere in
that window. The wallet has to be connected and holding mUSDT before the
replay buy, so record the terminal section first, then the replay buy, then
everything else while the clock runs.

| Clock | Step | Takes |
|---|---|---|
| T−2 min | Off camera: `python3 create_markets.py --market 1 --live`. Write down the close time it prints, in Texas and London. | about 1–2 min (mint, approve, `createMarket`) |
| **T0** | `createMarket` confirmed. The 45 minutes start here. | |
| T0 → T+8 | `./refresh_data.sh --no-fetch`. It republishes `addresses.json`, commits and pushes the data files on this branch, builds and deploys. Commit `shared/addresses.json` afterwards; the script only commits the data files. | build and deploy; time it in the rehearsal |
| T+8 | Hard-reload `/trade`. **Will Texas power cost more than $25 on 11 Sep 2025?** is listed as *Trading* under *Next day*, and its close matches what you wrote down. | |
| **T+10** | **Record 0:57–1:53**: the market list, the chart beat, connect, get test mUSDT, the 2 Oct buy, Positions, History. | about 5–8 min with retakes |
| **T+20** | **Record 2:18–2:27**: select the replay market, Buy YES, four prompts. **The buy must be confirmed by T+40.** Don't start it after T+38. | about 1 min |
| T+22 → T+44 | Record the Hedge tab (1:54–2:15), the agent run (2:58–3:19), and anything from 0:00–0:56 not yet filmed. | as long as needed |
| T+45 | Trading closes. | |
| **T+46** | Record 2:28–2:52: *Awaiting*, **Resolve market**, then the winnings banner and **Portfolio → Redeem all**. Wait a full minute past the close before resolving; the chain's clock can run a few seconds behind the browser's. | Resolve and Redeem are one prompt each, about 10s each |

Measured on 22 September: approvals and trades confirmed 8–12 seconds
apart, and the first live trade's two steps landed 9 seconds apart
(`shared/demo-evidence.md`). A four-prompt buy with human clicking takes
roughly 40–60 seconds.

### When to use the spare

A failed take isn't always a reason to use the spare:

- **A resolve or redeem that reverted, or never got sent,** can simply be
  retried. Both stay open after the close, so re-record 2:38–3:00 on
  market 1.
- **Use the spare only when it can't be re-shot on market 1.** That means:
  - the buy wasn't confirmed before the close;
  - the resolve or redeem went through but the recording of it is unusable
    (the market is resolved for good);
  - the wallet redeemed off camera.

To run the spare:

1. Repeat the table above with `--market 5`, the same wallet and the same
   45 minutes.
2. Skip 1:06–2:10; that section is already recorded.
3. After the deploy, record the replay buy straight away.

The wallet still has 800 mUSDT and plenty of OKB. A new market means the
same four prompts again, and its History starts empty.

For the spare, these lines change and nothing else does:

| Time | Say instead |
|---|---|
| 2:15 | "It replays 10 September 2025, a day that has already settled." |
| 2:49 | "Twenty-two sixty-two, above twenty. YES wins." |

The screen shows **Will Texas power cost more than $20 on 10 Sep?**, and the
pay line reads *…for 10 Sep 2025 settles above $20.00/MWh.* On a 100 mUSDT
buy the redeem is again about 199 mUSDT, because the pool starts at the same
10,000 each side.

### Never on screen

- The terminal running `create_markets.py` or `refresh_data.sh`, and any
  window that could show the keystore or its password.
- Coding tools, and any editor with `.env` or `web/.env.local` open.
- Other tabs, private or incognito windows, bookmarks, history and
  autocomplete in the address bar.
- Notifications. Turn on macOS Focus / Do Not Disturb.
- The wallet's account list, if it names other accounts. Also its
  seed-phrase or private-key screens.

### After recording

- Add the replay market's transactions (create, buy, resolve, redeem) to
  `shared/demo-evidence.md`, and the funding transfer from
  `logs/fund-demo-wallet-*.log`.
- Update the README's market count and table. The factory will read eight
  markets, or nine if the spare was used.

---

## Fallbacks

One line each, so the take keeps moving. Say it, fix it, carry on. Cut the
fix in the edit if it's long.

| If this happens | Say this | Then do |
|---|---|---|
| A transaction is slow to confirm | "Testnet blocks can take a few seconds. The ticket shows each step while it waits." | Wait. The status line (*Buying YES…*) stays up until it lands. |
| The wallet prompt doesn't appear | "The wallet's popup is hiding behind the window. One second." | Click the wallet's toolbar icon. |
| *Could not read X Layer*, or the wallet reports an RPC error | "The public testnet connection dropped a request. The site reads straight from the chain, so I'll reload." | Reload. If the wallet still fails, switch its RPC to `https://xlayertestrpc.okx.com/terigon`. |
| An **Unfinished order** box appears (the first step landed, the second didn't) | "The first step landed and the second didn't. The terminal remembers, so I finish it here." | Click **Finish order**. |
| *Live quote unavailable* | "The price is read live from the market. It'll refresh in a moment." | Retype the amount. |
| The chart doesn't load | "The chart reads the published daily prices. The latest one is up here." | Point at *Texas power 24 Sep · $41.60/MWh* in the instrument bar. |
| **Resolve market** fails just after the close | "The chain's clock runs a few seconds behind mine. Once more." | Wait 30 seconds and press **Resolve market** again. |
| An OKLink page is slow or won't load | "The explorer's slow today. Every transaction link is also in the README." | Switch to the pre-loaded tab, or to the landing page's **03 / Proof** table, which checks each price against the oracle live. |
| The diagram's hash or file names read *loading…* | "It's pulling the committed file. There." | Wait, or reload the landing page. |
