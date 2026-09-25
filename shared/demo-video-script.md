# GRIDFLEX demo video script: v4, the submission cut

## As submitted (25 September)

The submitted cut is on YouTube: <https://www.youtube.com/watch?v=9nZG6C00s3I>
(3:51, 1080p60). It follows the plan below with the wording tightened, read
by a professional narrator. It opens on a 3D Texas grid with the settled
8 September market's numbers, and each cut and camera move lands on the word
it illustrates. The narration as recorded, with the time each line starts:

| Time | Line |
|---|---|
| 0:19 | This market has already settled on X Layer: $39.57 against a $30 strike. YES won. |
| 0:27 | GRIDFLEX lists YES-or-NO markets on the daily price of Texas electricity. Miners and data centres carry that risk every day. Now they can hedge it from a wallet, for cents. |
| 0:42 | We hedge the day, not the hour. Each market settles on one day's average price. A normal day runs from $19 to $42. On the 26th of January, it hit $694. |
| 0:54 | The prices come from ERCOT's day-ahead market, through GridStatus. We check all 24 hours and average them, then we fingerprint the exact source files with SHA-256. |
| 1:05 | The price and its fingerprint go to GridOracle on X Layer. One publisher today: us. After a one-hour correction window, the price is final. |
| 1:19 | The terminal shows every past settlement price, every strike, and how often each one was beaten. |
| 1:25 | Will Texas power cost more than $45 on October the 2nd? YES costs 52 cents. It pays one test dollar if the answer is yes. |
| 1:36 | I connect a fresh OKX Wallet and mint a thousand test dollars. They have no real value. |
| 1:45 | 100 on YES. If it wins, it pays 190. |
| 1:50 | Under the hood, the contract mints a fully backed pair: one YES, one NO. Then it swaps the NO into more YES, with a slippage limit and a five-minute deadline. |
| 2:03 | Positions and profit and loss are read straight from the chain. No account, no custody. The wallet and the contracts are the source of truth. |
| 2:15 | Now the real customer: a 10-megawatt bitcoin miner, running all day. |
| 2:21 | GRIDFLEX buys YES on every strike. If the day averages $80, it pays back the extra cost above $35. Today, that cover costs about $6,450. |
| 2:36 | Settlement needs no one's permission. Once trading has closed and the price is final, anyone can resolve. The contract reads the oracle itself: $39.57, above $30. YES won. |
| 2:50 | Here's that resolve, confirmed on X Layer. Winners redeem one for one, and live markets stop trading an hour before the grid publishes the price. |
| 3:01 | AI agents get the same data. Here it's read live from OKX AI through Onchain OS: GRIDFLEX, agent 13881, with three services. |
| 3:10 | This agent has its own X Layer wallet. It calls those three endpoints, free today, with OKX's x402 payments already built in. Then it buys the hedge itself, on X Layer. |
| 3:26 | Miners lose when power is expensive. Wind and solar farms lose when it's cheap. Each side hedges the other. Revenue comes from a cent per agent call, and a trading fee in the next contracts. |

The rest of this file is the plan the cut was made from.

v4 merges David's proposal (proof first, the research chart, how a buy
works, Positions and P&L, no custody) into v3 (the promo bookends, the
Hedge tab, OKX AI and the honest framings the judge review asked for).

A **3:47** demo (the rules allow 2 to 4 minutes). It opens with the first
19 seconds of the promo film and closes with its last 5.5 seconds. Between
them is 3:22 of the real product working, narrated. Every on-screen string
below was checked against the live site
(<https://gridflex-web.teslenko-platon.workers.dev>) on 25 September, and
every spoken claim against the repo. Transactions that already exist are in
`shared/demo-evidence.md`. The rest are made on camera by the demo wallet
and the agent wallet.

**Say what the screen shows.** YES/NO cents move whenever anyone trades,
and *To win* and *Est. cost* move with them. Figures in [brackets] are
today's; read the screen's figure instead. The hero figures ($19.26,
$95.33) change only if `./refresh_data.sh` runs with a fetch, so don't run
one today.

**"Built on X Layer"** is the right phrase: the oracle, the factory and every
market are contracts deployed on X Layer (testnet), and every trade, resolve
and redeem is an X Layer transaction.

## What the judges score, and where the video earns it

The Builder Kit scores innovation, product completeness, user value,
technical execution, meaningful integration with X Layer and/or OKX AI,
growth potential and contribution to the OKX ecosystem. It publishes no
weights. The panel includes people from real-world business, so the video
speaks plainly, says what the product settles on, and never claims more
than exists today.

| Criterion | The beat that proves it | Time |
|---|---|---|
| Product completeness | Proof first: a market that already settled on X Layer. Then research, connect, fund, buy, positions and P&L, hedge, resolve and redeem, all live on X Layer testnet in one recording session | 0:19, 1:11–2:57 |
| User value | A 10 MW miner types their load; the ladder pays back the extra cost up to $80, and its cost is on screen | 2:04 |
| Innovation | A daily power price made into an on-chain index with a fingerprint; the same data offered to AI agents | 0:39, 2:58 |
| Technical execution | Fingerprinted readings, one publisher and a one-hour correction window stated plainly; a fully backed mint and swap with a slippage limit and deadline; no custody; permissionless resolve | 0:50, 1:41, 2:44 |
| X Layer / OKX AI | Oracle, markets and the agent's own trades on X Layer; the OKX AI registration read live with Onchain OS | 1:00, 2:58 |
| OKX ecosystem | OKX Wallet chosen from the picker, OKX AI (agent #13881, 3 A2MCP services), OKX's x402 Payment SDK, USDT0 as the mainnet path | 1:28, 2:58 |
| Growth | Miners buy YES, wind and solar buy NO; revenue from agent calls and trading fees; the roadmap | 3:23 |

## How we beat the competition

Reins (@ReinsOKX) posted a 25-second motion-graphics teaser with kinetic
type, a 3D render and a three-role line ending "X Layer settles". Ours
shows the whole loop working on chain:

- **Cinema only at the edges.** The promo's hook and end card bookend the
  demo (24.5 s in all). Everything between them is the real product.
- **Our own closing line:** "Hedge the grid. Or trade it." It doesn't echo
  their "…X Layer settles" structure, which v2's tagline did.
- **Honest where they'd be vague.** One publisher today, a replay called a
  replay, payments "built in, not switched on". Judges who check find it
  all true.

## The pitch in 30 seconds

For the finale and anyone who asks what it is (78 words, about 30 seconds):

> Texas power can cost five times more at 6pm than at 11am. Bitcoin miners
> and AI data centres pay that swing, and today's hedge means a futures
> broker and margin calls. GRIDFLEX makes it a YES/NO question you buy from
> a wallet, in cents, settled on X Layer against a fingerprinted daily
> price. A miner types their megawatts and gets a hedge in dollars. Agents
> find the same data on OKX AI. Hedge the grid. Or trade it.

---

## The script

Seven sections between the promo's bookends. Each opens on a one-second
chapter card from `shared/video/title-cards.html` (**TC**; open it in Chrome
full screen, → advances, `?card=N` opens card N). Everything else is a
screen recording of the live site, OKLink or the agent's terminal.

Timed at 150 words a minute, a natural narration pace, with a half-second
breath after each line. `/` marks a short pause. Don't read slower than
that: at 140 words a minute it reaches 4:00. If it runs long, use the cut
table below.

### 0 · Cold open: the problem, in 19 seconds (0:00–0:19)

| Time | Screen | Say |
|---|---|---|
| **0:00** | `GRIDFLEX-promo.mp4`, **0.00 → 19.00**: the day's 24 price bars rise, $19 at 11am, $95 at 6pm, the 30-day field, *Who pays the swing: Bitcoin miners. AI data centres.*, *Hedging it takes: Futures broker. Exchange account. Margin calls.* struck out, *Wallets: locked out.*, then the GRIDFLEX drop, the YES/NO question and *Just a wallet. No minimum.* | *(nothing: the film carries it)* |
| 0:18.5 | Last half-second of the promo | Fade the promo's music out over 18.5 → 19.3, under the first line |

Cut on **19.00** exactly, the downbeat where the promo would start *How it
works*.

### 1 · Proof first, then the pitch (0:19–0:38) · completeness, user value

| Time | Screen | Say |
|---|---|---|
| **0:19** | `/trade` with the settled 8 Sep market already selected: header *Oracle reading $39.57*, strike $30, *Resolved · YES*; then the **Settlement** tab's *Verified* row. | "This market has already settled on X Layer: / thirty-nine fifty-seven against a thirty-dollar strike. / YES won." |
| 0:26 | Landing page hero, then turn the 3D price grid. | "GRIDFLEX lists YES or NO markets on the daily price of Texas electricity. / Miners and data centres carry that risk; / now they can hedge it from a wallet, in cents." |

### 2 · Verify (0:38–1:10) · technical execution, innovation, X Layer

| Time | Screen | Say |
|---|---|---|
| **0:38** | **TC 2**: *01 / Verify* (1 s) |  |
| 0:39 | Move the cursor off the grid: *24 Sep 2026 · average $41.60/MWh, the price markets settle on*. | "We hedge the day, not the hour: / each market settles on one day's average price, / which ran from twenty-six to fifty-six dollars this past month." |
| 0:50 | **02 / How we verify**: **01 Source**, **02 Compute** (hash `75999d01…13c4`). | "ERCOT's day-ahead prices come in through GridStatus. / We check all twenty-four hours, average them, / and fingerprint the exact source files with SHA-256." |
| 1:00 | **03 Publish** → *Oracle tx* → OKLink: *Success*, to `GridOracle`, from `0x27Aa…e902`. | "The price and its fingerprint go to GridOracle on X Layer. / One publisher today: us. / After a one-hour correction window, it's final." |

### 3 · Trade (1:10–2:03) · completeness, technical execution, X Layer

| Time | Screen | Say |
|---|---|---|
| **1:10** | **TC 3**: *02 / Trade* (1 s) |  |
| 1:11 | Click **…$40 on 30 Sep?**: *Settlement price*, *90 days*, the strike line and *Past frequency*; click the $45 market on the same day. | "The terminal shows every past settlement price, / each strike, and how often it was beaten." |
| 1:17 | Click **Will Texas power cost more than $45 on 2 Oct?** | "Will Texas power cost more than forty-five dollars on October the second? / YES costs [fifty-two] cents / and pays one test dollar if it does." |
| 1:28 | **Connect wallet to trade** → the picker lists the installed wallets → **OKX Wallet** → approve. **Get 1,000 test mUSDT**, confirm. | "I connect OKX Wallet / and mint a thousand test dollars, with no real value." |
| 1:36 | Tap **10**, then **100**: *To win* counts up; *You get* and *Minimum* below. | "One hundred on YES. / If it wins, it pays [about one-ninety]." |
| 1:41 | **Buy YES · 100 mUSDT**: the four prompts, each status held about 1 s, waits cut; receipt *Confirmed*. | "Under the hood, a fully backed YES and NO pair is minted, / and the NO is swapped into more YES, / with a slippage limit and a five-minute deadline." |
| 1:53 | **Positions**: *Quantity*, *Avg entry*, *Current price*, *Current value*, *Indicative unrealised P&L*; then **History** with blocks. | "Positions and P&L are read from the chain. / No account, no custody: / the wallet and the contracts are the source of truth." |

### 4 · Hedge (2:03–2:21) · user value

| Time | Screen | Say |
|---|---|---|
| **2:03** | **TC 4**: *03 / Hedge* (1 s) |  |
| 2:04 | Click **…$45 on 30 Sep?** → **Hedge** tab, *One day*: clear *Load*, type 10. | "Now the real customer: / a ten-megawatt miner that runs all day." |
| 2:09 | The ladder ($35, $40, $45); zoom onto the $80 scenario, *100%* covered. | "GRIDFLEX buys YES on each strike. / If the day averages eighty dollars, / it pays back the extra cost above thirty-five." |
| 2:17 | Zoom onto *Est. cost*. | "Today that costs about [six thousand] test dollars." |

### 5 · Settle (2:21–2:57) · technical execution, completeness, X Layer

| Time | Screen | Say |
|---|---|---|
| **2:21** | **TC 5**: *04 / Settle* (1 s) |  |
| 2:22 | The replay market **…$25 on 11 Sep 2025?**, *Oracle reading $26.38* beside the $25.00 strike. | "Now a full cycle, on a replay of the eleventh of September 2025: / its price is already on chain, so it settles today." |
| 2:33 | Buy YES, 100, waits cut. | "One hundred on YES." |
| 2:36 | **Cut.** *45 minutes later*: *Awaiting resolution*, the Buy button reads *Trading closed*. | "Trading has closed, and the contract rejects new orders. / Live markets close an hour before the grid publishes the price." |
| 2:44 | **Resolve market** → *Outcome YES*. | "Anyone can resolve. / The contract reads the oracle itself: / twenty-six thirty-eight, above twenty-five. / YES wins." |
| 2:51 | Portfolio → **Redeem all** → receipt. | "Winning tokens redeem one for one: / a hundred in, [a hundred and ninety-nine] out." |

### 6 · Agents on OKX AI (2:57–3:22) · OKX AI integration, innovation

| Time | Screen | Say |
|---|---|---|
| **2:57** | **TC 6**: *05 / Agents* (1 s) |  |
| 2:58 | Terminal: `node web/scripts/okx-ai-agent.ts`. | "Agents get the same data. / Read live from OKX AI with Onchain OS: / GRIDFLEX, agent thirteen-eight-eight-one, three services." |
| 3:06 | Terminal: `node web/scripts/hedge-agent.ts --mw 1 --day 2026-09-30 --execute`. | "This agent has its own X Layer wallet. / It calls those three endpoints: free today, / with OKX's x402 payments built in." |
| 3:17 | *Hedge placed.* → OKLink address page. | "Then it buys the hedge itself, on X Layer." |

### 7 · Why it grows (3:22–3:41) · growth, OKX ecosystem

| Time | Screen | Say |
|---|---|---|
| **3:22** | **TC 7**: *06 / Two natural sides* (1 s) |  |
| 3:23 | TC 7 figures. | "Miners lose when power is expensive; / wind and solar lose when it's cheap. / Each side hedges the other." |
| 3:31 | TC 7 *Revenue*, then README *What's next*. | "Revenue: a cent per agent call, and a trading fee in the next contracts. / Next: cash-outs before settlement, weekly contracts, and more US grids." |

### 8 · Close (3:41–3:47)

| Time | Screen | Say |
|---|---|---|
| **3:41** | `GRIDFLEX-promo.mp4`, **34.45 → 40.00**: *Hedge the grid.* / *Or trade it.* on the heat field, then the end card: wordmark, *Hedge Texas power from your wallet.*, *Try it on X Layer testnet →*, the URL, *BUILT ON X LAYER · OKX WALLET · REGISTERED ON OKX AI*. | *(nothing: the film's hits carry it)* |
| **3:47** | *End* | |

---

## Production: what makes it look high-end

- **Screen recorder with automatic zoom.** Screen Studio (macOS) or the free
  Cap: smooth zoom onto each click and a smoothed cursor. That's most of the
  "produced" look. Record the browser at 1440×900; export 1920×1080 at
  60 fps, to match the promo.
- **The promo bookends** come from `~/Desktop/GRIDFLEX-promo.mp4` (today's
  render, with *Margin calls.*). Trim 0.00–19.00 for the open and
  34.45–40.00 for the close, and keep their sound at full level.
- **Chapter cards** (TC 2–7): record each full screen for 3 seconds and use
  the last settled second. Record them from today's `title-cards.html`; the
  Verify, Hedge, Settle, Agents and Revenue lines changed this morning.
- **Voice last.** Record the screen takes at a natural pace, cut them
  roughly, then record the voice one section at a time while watching the
  cut: quiet room, mic about 15 cm away. Trim the picture to the voice.
  Normalise to about −16 LUFS.
- **Music under the voice:** one quiet instrumental bed from 0:19 to 3:41,
  about 20 dB under the voice, fading out into the close. Royalty-free only
  (YouTube Audio Library, Artlist, Epidemic). Or no bed at all: the
  bookends carry the energy.
- **Burned-in captions.** Judges often watch muted. CapCut's auto-captions
  are fine; check every figure by hand.
- **Cuts:** jump-cut every wallet wait and caption it *sped up*. Hold every
  number the voice says on screen for at least one second.
- **Look:** one browser window, no bookmarks bar, 100% zoom, dark mode, Do
  Not Disturb on, the same wallet account throughout.
- **Optional face camera:** a small round camera in a corner for sections 1
  and 7 only. It helps a remote entry feel like a team.
- **Status holds:** on each buy, hold every step's status (*Approve…*,
  *Mint…*, *Approve…*, *Swap…*, *Confirmed*) for about a second and cut
  the spinner between them.
- **Upload:** YouTube, visibility *Public* or *Unlisted* (both open for anyone
  with the link), title *GRIDFLEX: hedge Texas power from your wallet · OKX
  Dev Day 2026*. Cover image: the promo's end card as a still.

## Timing and cuts

Runs **3:47** at 150 words a minute. If the finished edit runs over 3:55,
cut in this order:

| Section | Length | If it runs long |
|---|---|---|
| 0 Cold open | 19 s | **Untouchable.** |
| 1 Proof and pitch | 19 s | **Untouchable.** |
| 2 Verify | 31 s | Drop "which ran from twenty-six to fifty-six dollars this past month" (saves 3 s). Never drop "one publisher today". |
| 3 Trade | 53 s | The research chart at 1:11 goes first (saves 6 s). Never cut connect, buy, or "no account, no custody". |
| 4 Hedge | 18 s | **Untouchable.** It's the customer. |
| 5 Settle | 36 s | **Untouchable.** The replay framing and the resolve are the proof. |
| 6 Agents | 25 s | **Untouchable.** It's the OKX AI proof. |
| 7 Growth | 19 s | Keep both lines; drop the README shot if needed. |
| 8 Close | 5.5 s | **Untouchable.** |

Last resort: drop the chapter cards (saves 6 s) and put each chapter name
in a small corner label instead.

**Add back if the edit runs short** (David's beats, both true and checked):

| After | Screen | Say |
|---|---|---|
| Positions (2:03) | **Switch position**: YES → NO, **25%**, approve, switch; the amount clears; Positions update. | "Changed your mind? Switch part of it to NO. / It changes sides; it isn't a cash-out." (8 s) |
| Redeem (2:57) | `/trade?market=0x62D65F4e15CdC15EC4A1cf707EE6ba4A5cF4BE07`: the 12 Aug West-vs-North market, *Resolved · NO*; then the footer's contract addresses. | "The other side works too: this market resolved NO. / And if a reading never comes, every token refunds half." (5.5 s) |

## Record in this order today

The replay market's 45-minute clock changes what the terminal shows. While
it trades, `/trade` opens on it (it closes soonest), lists it first under
*Next day*, and puts 11 Sep 2025 at the front of the Hedge tab's week strip.
So record everything else **before** creating it. (The 26 Sep markets close
at 18:30 UK today; nothing in the script uses them.)

**Part A, before the clock:**

1. Off camera: fund the demo wallet and the agent wallet, then rehearse the
   agent (see *The agent's terminal* below).
2. Record the chapter cards, the settled 8 Sep market (0:19), the landing
   beats (0:26–1:10) and the OKLink beat at 1:00.
3. Record **Trade (1:10–2:03)** with the fresh wallet: the research chart,
   connect, mint, the 2 Oct buy, Positions and History. (Optional: the
   Switch beat, straight after.)
4. Record **Hedge (2:03–2:21)** straight after.
5. Record **Agents (2:57–3:22)** and the README shot (3:31).

**Part B, the replay clock (any time after Part A):**

6. **T−2:** `python3 create_markets.py --market 1 --live`. Write down the
   close time it prints.
7. **T0 → T+8:** `./refresh_data.sh --no-fetch` (it deploys). Then commit
   `shared/addresses.json` and `data/market-ledger.json`.
8. **T+10:** hard-reload `/trade`; it opens on the replay market. Record the
   replay buy (2:21–2:36). **It must be confirmed by T+40.**
9. **T+46:** record **2:36–2:57**: *Awaiting resolution*, **Resolve market**,
   then **Portfolio → Redeem all**.
10. Edit while the clock runs.

## Shot list

### Browser tabs, in this order

Use one clean Chrome profile. The only extension should be the wallet.
Hide the bookmarks bar. Set zoom to 100%, with the window at 1440×900 or
larger.

1. <https://gridflex-web.teslenko-platon.workers.dev/trade?market=0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1>,
   the settled 8 Sep market, for the opening shot (0:19).
2. <https://gridflex-web.teslenko-platon.workers.dev/>. Don't load it until
   you record the landing beats, so the headline reveal is captured.
3. <https://www.oklink.com/x-layer-testnet/tx/0xf6bdfc4e4c775eca150fff4d380f915411d6bf4e5389d8e3228dfbeff00cb44f>
   is the 8 Sep oracle reading. The diagram's *Oracle tx* link opens this.
   Keep it pre-loaded as a backup.
4. <https://gridflex-web.teslenko-platon.workers.dev/trade>. Leave it as it
   loads; the script clicks 30 Sep $40, 2 Oct $45 and then 30 Sep $45 on
   camera. Check
   the chart shows **Settlement price** and **90 days**.
5. <https://github.com/Kemu-Ri-Kage/gridflex/tree/feat/judging-sprint#why-x-layer-and-okx>,
   the README on the branch, scrolled to **Why X Layer and OKX**. (The
   footer's *Source on GitHub* opens `main`, whose README is out of date
   until the branch is merged.)
6. `shared/video/title-cards.html`, opened from Finder in its own full-screen
   window. Record the cards separately and cut them in.

Load every OKLink tab once before recording, so none of them loads on camera.

### The agent's terminal (2:58)

One terminal window, large font (18 pt+), dark theme, nothing else in its
history, in `~/Desktop/gridflex`. Two commands, typed or pasted on camera:

```bash
node web/scripts/okx-ai-agent.ts
```

```bash
node web/scripts/hedge-agent.ts --mw 1 --day 2026-09-30 --execute
```

- `okx-ai-agent.ts` reads GRIDFLEX's registration live from OKX AI through
  the Onchain OS CLI. It's read-only. If `onchainos` isn't on the terminal's
  PATH, put `ONCHAINOS=~/.local/bin/onchainos` in front.
- `--day 2026-09-30` ties the agent to the day the Hedge tab showed, and
  keeps it off the 26 Sep pools, which close at 18:30 UK.
- The agent's wallet is `0x151f1e03A3cac922D374eA4e660b89Fe077bfE61`, a
  throwaway testnet key in `web/.agent-wallet.json` (git-ignored). Before
  recording, off camera:
  1. **Test OKB for gas:** `python3 fund_demo_wallet.py --to 0x151f1e03A3cac922D374eA4e660b89Fe077bfE61 --live`
     (it asks for the keystore password).
  2. **mUSDT:** `node web/scripts/hedge-agent.ts --fund` mints 1,000 test
     mUSDT. A 1 MW, 24-hour ladder on 30 Sep costs about 630.
  3. **Rehearse:** `--execute` has never run. Run the exact command once off
     camera, check it ends with *Hedge placed.*, then `--fund` again so the
     take on camera has enough.

### Wallet, before recording

- **Account:** a new account that has never touched GRIDFLEX. Don't use the
  deployer `0x27Aa…e902` (it holds approvals on the 2 Oct $45 market that
  would skip two of the four prompts) or `0xD95B…8059` (its old trades crowd
  History).
- **A seed-phrase account, not a social-login one.** OKX Wallet accounts made
  with Apple ID or another social login are smart accounts: the site
  confirms their trades, but each step lands as a bundled operation and a
  prompt can grey out while the wallet catches up. Not what you want on
  camera.
- **Network:** X Layer Testnet, added and selected in the wallet in advance.
  - Chain ID `1952`, currency `OKB`.
  - RPC `https://testrpc.xlayer.tech/terigon`. The backup is
    `https://xlayertestrpc.okx.com/terigon`.
  - Explorer `https://www.oklink.com/x-layer-testnet`.
- **OKB: 0.01 test OKB, sent by `fund_demo_wallet.py`.** The take sends
  about 11 transactions (1 mint, 4 for the 2 Oct buy, 4 for the replay buy,
  resolve, redeem), well under 0.0001 OKB of gas.
  - **Dry run:** `python3 fund_demo_wallet.py --to 0xNEW` shows the
    account's OKB, mUSDT and transaction count, and whether it's fresh. It
    loads no key.
  - **Send:** `python3 fund_demo_wallet.py --to 0xNEW --live`, after a typed
    `yes`. It refuses any address in `shared/addresses.json` and any
    contract, and caps at 0.05 OKB.
- **mUSDT: 0.** The *Get 1,000 test mUSDT* button is on camera at 1:28.
- **Not connected to the site.** If the account has connected before, remove
  the site from the wallet's connected sites, so *Connect* is real.
- If you use OKX Wallet, check beforehand that it answers the site's connect
  request, not another installed wallet.

### The replay market

Each replay market **can be created only once**: `create_markets.py` skips a
market whose metric, day and strike already exist on chain, and in live mode
it refuses a replay market that `--market` didn't name. There are two:

| Row | Question on screen | Strike | Published price | Result | Create with |
|---|---|---|---|---|---|
| 1 | Will Texas power cost more than $25 on 11 Sep 2025? | $25.00 | $26.38 | YES | `--market 1` |
| 5 (spare) | Will Texas power cost more than $20 on 10 Sep 2025? | $20.00 | $22.62 | YES | `--market 5`, only if market 1's take fails |

Trading closes **45 minutes after creation.** Wait a full minute past the
close before resolving; the chain's clock can run a few seconds behind the
browser's. Measured on 22 September, approvals and trades confirmed 8–12
seconds apart, so a four-prompt buy with human clicking takes roughly 40–60
seconds.

**When to use the spare.** A resolve or redeem that reverted, or never got
sent, can simply be retried on market 1. Use the spare only when market 1
can't be re-shot: the buy wasn't confirmed before the close, the resolve or
redeem went through but the recording is unusable, or the wallet redeemed
off camera. Repeat Part B with `--market 5`, and change two lines:

| Time | Say instead |
|---|---|
| 2:22 | "Now a full cycle, on a replay of the tenth of September 2025: / its price is already on chain, so it settles today." |
| 2:44 | "…twenty-two sixty-two, above twenty. / YES wins." |

### Never on screen

- The terminal running `create_markets.py`, `fund_demo_wallet.py` or
  `refresh_data.sh`, and any window that could show the keystore or its
  password.
- Coding tools, and any editor with `.env` or `web/.env.local` open.
- `web/.agent-wallet.json`.
- Other tabs, private windows, bookmarks, history and address-bar
  autocomplete.
- Notifications. Turn on Focus / Do Not Disturb.
- The wallet's account list, if it names other accounts, and its
  seed-phrase or private-key screens.

### After recording

- Add the replay market's transactions (create, buy, resolve, redeem) and
  the agent's hedge transactions to `shared/demo-evidence.md`.
- The README lists 17 markets. After the replay it's 18 (19 if the spare
  was used): add its row under *Every market*.
- Put the video's link in the README's *Demo video* line.

---

## Fallbacks

One line each, so the take keeps moving. Say it, fix it, carry on; cut the
fix in the edit if it's long.

| If this happens | Say this | Then do |
|---|---|---|
| A transaction is slow to confirm | "Testnet blocks can take a few seconds. The ticket shows each step while it waits." | Wait. The status line stays up until it lands. |
| The wallet prompt doesn't appear | "The wallet's popup is behind the window. One second." | Click the wallet's toolbar icon. |
| *Could not read X Layer*, or the wallet reports an RPC error | "The public testnet connection dropped a request. I'll reload." | Reload. If the wallet still fails, switch its RPC to `https://xlayertestrpc.okx.com/terigon`. |
| An **Unfinished order** box appears | "The first step landed and the second didn't. The terminal remembers, so I finish it here." | Click **Finish order**. |
| *Live quote unavailable* | "The price is read live from the market. It'll refresh in a moment." | Retype the amount. |
| The chart doesn't load | "The chart reads the published daily prices. The latest is up here." | Point at the instrument bar's latest price. |
| **Resolve market** fails just after the close | "The chain's clock runs a few seconds behind mine. Once more." | Wait 30 seconds and press **Resolve market** again. |
| An OKLink page is slow | "The explorer's slow today. Every transaction link is also in the README." | Switch to the pre-loaded tab, or to the landing page's **03 / Proof** table. |
| The agent stops with *Stopped: the price moved…* | "Someone traded in between, so it stopped rather than overpay. Again." | Run the same command again. |
| **Load in ticket** shows a shortfall | *(nothing; don't buy)* | It's expected: the ladder costs more than the wallet's test dollars. Cut before the warning if it distracts. |

## Questions judges may ask (for the finale)

| Question | Answer |
|---|---|
| Why the daily average, not the 6pm spike? | Because it's one official, published number per day that a contract can settle on. The hourly swing is why the daily price moves; the daily average itself ran from $26 to $56 in the last 30 days. |
| Who takes the other side? | Today, pools GRIDFLEX seeds at 50/50. Natural sellers are wind and solar farms, whose income falls when the price does; they buy NO. |
| Can the price be manipulated? | One publisher today, us, with a SHA-256 fingerprint of the source files, and one hour to correct before anyone can finalize it. Open disputes need more than one publisher; that comes next. |
| Is this legal in the US? | Event contracts on a US commodity price are regulated there. GRIDFLEX runs on testnet with test tokens; a mainnet launch would exclude US persons or run through a licensed partner. |
| Why X Layer? | Low fees and fast confirmation make a hundred-dollar hedge worth doing, OKX Wallet brings the users, and USDT0 on X Layer is the mainnet collateral. |
| How do agents use it? | GRIDFLEX is registered on OKX AI as agent #13881 with three A2MCP services: the price, the markets and a hedge quote. x402 payments at $0.01 a call are built in and not switched on yet. |
