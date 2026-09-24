# GRIDFLEX demo video script

A 3:43 demo, recorded by the presenter. Every on-screen string below was read
from the live site (<https://gridflex-web.teslenko-platon.workers.dev>) and its
source on 23 September 2026. Every transaction shown that already exists is in
`shared/demo-evidence.md`. The rest are made on camera by the demo wallet.

**Figures that can move before you record.** The hero figures ($19.26, $95.33,
from the 24 September refresh) change only if `./refresh_data.sh` runs with a
fetch; don't run one between now and recording. The YES/NO cents on
2 Oct change whenever anyone trades. Say what the screen shows, not what's
written here.

## Changes from the brief, and why

- **The opening figures are 24 September's.** The 24 September refresh
  moved the hero to that day: cheapest hour $19.26 at 11:00, dearest
  $95.33 at 18:00 Central, 4.95 times as much and seven hours apart
  (`web/lib/generated/price-summary.json`). The lines say "five times" and
  "seven hours".
- **"Nobody outside the industry" is now "without a futures broker".** ICE
  sells these contracts to anyone with a broker, so the original is a claim a
  judge can knock down.
- **The opening names the customer.** After the hook, 0:15–0:31 says who
  pays this price and why it belongs onchain: Texas bitcoin miners, whose
  single largest cost is electricity, have no onchain hedge; ICE sells one to
  institutions through a broker. **Cut for it:** 0:15's "Without a futures
  broker, you can't take a position on that." The broker point moves to
  0:31. The two ICE lines ("Institutions already trade this exact price, on
  ICE." / "Eighty megawatt-hours a contract, through a futures broker.") are
  reworded into 0:26 and 0:31, not cut. Net +6s.
- **"A third more than last" is the price, from our data.** The Texas power
  price (`ERCOT_HBNORTH_DA_AVG`) averaged **$39.91/MWh over 10–23 September
  2026, against $30.12 over the same 14 days of 2025: up 32.5%**
  (`data/metrics/ERCOT_HBNORTH_DA_AVG__2025-09-*.json` and `__2026-09-*.json`;
  every day complete). Our data starts on 10 September 2025, so a longer
  window isn't possible. The line puts data centres next to the rise but
  doesn't claim they caused it; our data can't show that. Don't swap in a
  demand figure: our load data overlaps across the two years on only three
  days (19–21 Sep), and West Texas load, where most miners are, fell 1.6% on
  those.
- **ICE sizes are specific.** The daily option is on an 80 MWh future. The
  monthly future is about 350 MWh. "Hundreds of megawatt-hours" is true only
  of the monthly, so 0:26–0:31 show the monthly future's page. It's the
  real-time peak contract at the same hub, not our day-ahead daily average,
  which is why the line says "hedge" and no longer "this exact price".
- **The full cycle has one cut.** Trading on the replay market closes
  45 minutes after it's created, so the video cuts from the buy to the close.
  The spoken line says so.
- **The terminal opens on the settlement chart, on 30 Sep $40.** One beat
  shows the price history, both 30 September strikes and the past-frequency
  panel, then switches between the two strikes. The buy stays on 2 Oct $45.
- **"Cashing out before settlement isn't in the contracts yet" is cut.** It
  made room for the chart beat, and 3:26 already says it: cashing out before
  settlement is the first item under *Next*.
- **12 August is shown on OKLink, not the site.** It's a West-vs-North
  market, and the site lists only Texas power price questions
  (`PUBLIC_METRIC` in `web/lib/markets.tsx`).

## Judging criteria

UV user value · INN innovation · GRO growth potential · TECH technical
execution · XL meaningful X Layer integration · COMP product completeness ·
OKX contribution to the OKX ecosystem

---

## Script

| Time | What I say | What's on screen | Serves |
|---|---|---|---|
| **0:00** | *(silent, 2s)* | Landing page loads. The hero headline reveals word by word. | UV |
| 0:02 | "Texas power cost nineteen dollars at eleven in the morning." | Hero: **Texas power cost $19.26 at 11am and $95.33 at 6pm.** | UV |
| 0:06 | "And ninety-five dollars at six that evening. Same day." | Cursor under the mono line: *24 Sep 2026 · cheapest and dearest hour, Central time · $/MWh* | UV |
| 0:11 | "Five times the price, seven hours apart." | Hero, still. | UV |
| 0:15 | "Bitcoin miners in Texas pay that price. Electricity is their single largest cost." | Hero, still. | UV, GRO |
| 0:20 | "And AI data centres now compete for the same power. This September cost a third more than last." | Scroll to **01 / Normal range**, click **Full year**. Say it over the chart, then hold. | UV, GRO |
| **0:26** | "Miners have no way to hedge it onchain. Institutions do, on ICE." | ICE tab: the product page for ICE's monthly ERCOT North peak future. | INN, GRO |
| 0:31 | "Through a futures broker, in contracts of hundreds of megawatt-hours." | Same page, with the contract size (1 MW for every peak hour of the month) in view. | INN, GRO |
| 0:35 | "GRIDFLEX is the same bet, as a YES or NO, at any size." | GRIDFLEX tab, still on **Full year**: the 26 Jan 2026 spike, $694.03, about 24× the median day. | INN, UV |
| **0:41** | "So where does the price come from?" | Scroll to **02 / How we verify**. **01 Source** active: four file names, *4 source files · 8 Sep 2026 reading*. | TECH |
| 0:45 | "Texas's official grid price. Twenty-four hourly prices, averaged." | Click **02 Compute**. *SHA-256* `75999d0173983de904ad23e09e4b2de1536fa0929e23ae4700359d53593913c4` | TECH |
| 0:50 | "That's a fingerprint of the exact source files. Anyone can recompute it." | Same panel, the `$ cat … \| shasum -a 256` line. | TECH |
| 0:55 | "And the price, written to the oracle on X Layer." | Click **03 Publish**: *GridOracle* `0x970cefFC…D561`, *Oracle tx* `0xf6bdfc4e4c77…`. Click the Oracle tx link. | XL, TECH |
| 1:00 | "Confirmed on chain. Any market that settles reads this." | OKLink tab: tx `0xf6bdfc4e…cb44f`, its status and the `GridOracle` address it was sent to. | XL |
| **1:06** | "This is the terminal. It runs on X Layer testnet, paid in MockUSDT." | `/trade`, already on **Will Texas power cost more than $40 on 30 Sep?** TRADING. Header chip *X Layer testnet · MockUSDT*. The chart is on **Settlement price**, **90 days**: filled daily candles, the daily average line, and the strike ladder. | COMP |
| 1:11 | "Every past day, both strikes, and how often they were beaten. See for yourself if the question's open." | Hold on the chart: the amber dashed **$40.00** line marked *Strike · 30 Sep*, the faint $45.00 line above it, the light shading above $40. Past frequency: *Days above $40.00 · Last 30 days 12 of 30 · Last 90 days 17 of 90*. **Optional, silent:** two-finger scroll in over the latest candles to about a week, then click **90 days** to come back. Skip it if it would run past the line. | UV, INN |
| 1:17 | "Same day, two strikes: forty or forty-five." | Click **Will Texas power cost more than $45 on 30 Sep?** The $45.00 line turns amber, the shading moves up to it, past frequency reads *7 of 30 · 12 of 90*. | UV, COMP |
| 1:21 | "Will Texas power cost more than forty-five dollars on 2 October? YES is fifty cents." | Click **Will Texas power cost more than $45 on 2 Oct?** Order ticket: YES in cents with its implied percentage underneath. Say the cents the ticket shows. | UV, COMP |
| 1:27 | "Connect a wallet." | Click **Connect wallet to trade**. Approve the connection in the wallet. | COMP |
| 1:30 | "Take a thousand demo tokens to trade with." | Click **Get 1,000 test mUSDT**, confirm. *Transaction confirmed*. | COMP |
| 1:35 | "Buy YES, a hundred." | YES selected, Amount `100`, *Estimated output* about 198.8 YES. Click **Buy YES**. | UV, COMP |
| 1:38 | "A first buy asks for four confirmations: two permissions, then the trade in two steps." | Wallet prompt 1. Status *Approving mUSDT…* | COMP, TECH |
| 1:44 | "Each one is its own transaction on X Layer." | Prompts 2–4. Status *Buying YES…*, *Approving NO…*, *Buying YES…*, then *Transaction confirmed*. **Edit:** jump-cut the gaps, keep each status line on screen for at least a second. | XL, COMP |
| 1:49 | "History reads them straight back from the chain." | **History** tab: *Approve mUSDT*, *Mint YES + NO*, *Approve NO*, *Swap (Buy YES)*, with block numbers and tx links. | TECH, XL |
| 1:54 | "Positions: what I paid, and what it's worth right now." | **Positions** tab: YES row, *Avg entry*, *Current price*, *Current value*, *Indicative unrealised P&L*. | COMP, UV |
| **2:01** | "Change your mind? Switch a quarter of it to NO." | Order ticket, **Switch position**. **YES → NO**, click **25%**, then **Switch … YES to NO**. Two prompts: *Approving YES…*, *Switching to NO…*. | COMP |
| 2:07 | "That changes side. It doesn't turn the position back into cash." | Hold on the line *Changes side. Not a sale: no mUSDT is returned before settlement.* Then **Positions**: YES and NO rows. | COMP |
| **2:11** | "Now one market, start to finish." | Markets list, click **Will Texas power cost more than $25 on 11 Sep 2025?** (top of the list, under *Next day*: it closes soonest). | TECH |
| 2:15 | "It replays 11 September 2025, a day that has already settled." | Pay line: *Pays 1 mUSDT per YES if the Texas power price for 11 Sep 2025 settles above $25.00/MWh.* | TECH |
| 2:20 | "So the answer is already public. That's the one thing a live market never allows." | Settlement summary: *Trading closes …* | TECH |
| 2:25 | "Live markets stop trading an hour before the price is published." | Click the 2 Oct market for one second: *Trading closes 1 Oct 2026 17:30 UTC*. Click back to 11 Sep. | TECH, UV |
| 2:30 | "Buy YES, a hundred. New market, so the same four confirmations." | Amount `100`, about 199.0 YES. **Buy YES**, four prompts. **Edit:** jump-cut the gaps. | COMP |
| **2:38** | "Forty-five minutes later, trading has closed. The contract now refuses any new buy." | **Cut.** Status *Awaiting resolution*. Buy button reads **Trading closed**. Summary: *Trading closed …* | TECH |
| 2:44 | "Anyone can resolve it. The contract reads the published price itself." | Click **Resolve**, confirm. *Resolving…* | TECH, XL |
| 2:49 | "Twenty-six thirty-eight, above twenty-five. YES wins." | *Resolved · YES*. **Settlement** tab: *Oracle reading $26.38/MWh*, Outcome YES. | TECH |
| 2:54 | "Redeem. One hundred in, about a hundred and ninety-nine back." | Click **Redeem**, confirm. **History**: *Redeem … YES + 0.00 NO → … mUSDT*. Positions: the mUSDT balance. | TECH, COMP |
| **3:01** | "It has already done this for real. 8 September resolved YES." | Select **Will Texas power cost more than $30 on 8 Sep?** *Resolved · YES*. **Settlement** tab: *Oracle reading $39.57/MWh*, *Verified*, *Oracle tx*. | TECH, XL |
| 3:07 | "Here's that resolve on OKLink." | OKLink tab: resolve tx `0x004e9ae0…7b216`. | XL |
| 3:11 | "12 August asked whether West Texas would cost more than North. It resolved NO." | OKLink tab: resolve tx `0xd83a6e14…a82104`. | TECH, XL |
| 3:18 | "On X Layer: GridOracle, MarketFactory, a BinaryMarket per question, and its YES and NO tokens." | Terminal footer: *GridOracle 0x970c…D561 · MarketFactory 0xE521…C3A9 · MockUSDT 0xA5A5…217A*. **Settlement** tab's *Contract* row. | XL |
| **3:26** | "Next: cashing out before settlement, more markets every day, weekly and monthly contracts." | GitHub README, **What's next**. | GRO |
| 3:32 | "Then the same product on other US grids." | Same section, *More US grids*. | GRO |
| 3:35 | "Each market is a self-contained contract, so listing it on exchange infrastructure is a deployment, not a rewrite." | Same section, *Listing on exchange infrastructure*. | OKX, GRO |
| 3:41 | "GRIDFLEX." | Landing hero. | — |
| **3:43** | *End* | | |

---

## Timing and cuts

Runs **3:43**, leaving 17 seconds under 4:00. If every wallet step runs 13
seconds long, it still ends 4 seconds under.

| Section | Length | If a take runs long |
|---|---|---|
| 0:00 Hook | 15s | **Untouchable** |
| 0:15 Who pays it | 11s | **Untouchable.** It's why this belongs onchain. |
| 0:26 ICE | 15s | **Cut first.** Drop 0:31 and keep 0:26 and 0:35. Saves about 4s. |
| 0:41 How we verify | 25s | **Untouchable** |
| 1:06 Terminal, chart, buy, History, Positions | 55s | **Untouchable.** Tighten with jump cuts, not by dropping steps. The optional zoom at 1:11 goes first. |
| 2:01 Switch position | 10s | **Cut second.** Keep 2:07 alone over the switch screen. Saves about 6s. |
| 2:11 Full cycle | 50s | **Untouchable.** 2:25 (the 2 Oct close) can go. Saves 5s. |
| 3:01 Already resolved | 25s | **Untouchable.** 3:11 (12 Aug) can go if needed. Saves 7s. |
| 3:26 Where it goes | 17s | **Cut third.** Keep only 3:35. Saves 9s. |

---

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
4. <https://gridflex-web.teslenko-platon.workers.dev/trade>, with
   **Will Texas power cost more than $40 on 30 Sep?** selected. The page
   loads on 2 Oct $45, so click 30 Sep $40 in the markets list after every
   load or reload, and check the chart shows **Settlement price** and
   **90 days**, with the $40.00 line amber. Hover off the chart so its
   readout shows the latest day.
5. <https://www.oklink.com/x-layer-testnet/tx/0x004e9ae0e4fa95f5519d3f9ad274b695bedefd21af2bdcafeff3cc47dc97b216>
   is the 8 Sep resolve.
6. <https://www.oklink.com/x-layer-testnet/tx/0xd83a6e14b88f5d6ad57d4b48af6da93464b27ebe04695f3b20b67ac6d3a82104>
   is the 12 Aug resolve.
7. The repo README on GitHub, scrolled to **What's next**. This is the
   footer's *Source on GitHub* link.

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
| T+8 | Hard-reload `/trade`. **Will Texas power cost more than $25 on 11 Sep 2025?** is listed as *Trading* under *Next day*, and its close matches what you wrote down. Then select **30 Sep $40** again, so the terminal opens on it. | |
| **T+10** | **Record 1:06–2:10**: the chart beat, connect, get demo mUSDT, the 2 Oct buy, History, Positions, the switch. | about 5–8 min with retakes |
| **T+20** | **Record 2:11–2:37**: select the replay market, Buy YES, four prompts. **The buy must be confirmed by T+40.** Don't start it after T+38. | about 1 min |
| T+22 → T+44 | Record 0:00–1:05, then 3:01–3:43. | as long as needed |
| T+45 | Trading closes. | |
| **T+46** | Record 2:38–3:00: *Trading closed*, **Resolve**, **Redeem**. Wait a full minute past the close before resolving; the chain's clock can run a few seconds behind the browser's. | Resolve and Redeem are one prompt each, about 10s each |

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
| The chart doesn't load | "The chart reads the published daily prices. The latest one is up here." | Point at *Latest Texas power price … $/MWh* in the instrument bar. |
| **Resolve** fails just after the close | "The chain's clock runs a few seconds behind mine. Once more." | Wait 30 seconds and press **Resolve** again. |
| An OKLink page is slow or won't load | "The explorer's slow today. Every transaction link is also in the README." | Switch to the pre-loaded tab, or to the landing page's **03 / Proof** table, which checks each price against the oracle live. |
| The diagram's hash or file names read *loading…* | "It's pulling the committed file. There." | Wait, or reload the landing page. |
