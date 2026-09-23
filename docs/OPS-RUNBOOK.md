# Operations runbook, 23 September to 7 October 2026

Nothing on GRIDFLEX runs unattended. Every reading is published, finalized
and resolved by a person at a keyboard, on purpose (`shared/publish-spec.md`
and `shared/finalize-spec.md` say why). That makes the calendar the product:
a live market that closes on a day nobody runs the cycle sits at "Awaiting
resolution" in front of whoever is looking. This file is the calendar.

Times are UTC. Texas is CDT, UTC-5, until 1 November. London is BST, UTC+1,
until 25 October. Singapore is UTC+8.

## The daily cycle for a live market

A market on day D closes at 12:30 Texas time on D-1, which is 17:30 UTC.
ERCOT publishes D's day-ahead prices about an hour later, 13:30 Texas time,
18:30 UTC. From then the cycle is:

| Step | When | Command | Notes |
|---|---|---|---|
| 1. Fetch | from 18:40 | `./refresh_data.sh --tomorrow` | On a feature branch, never `main`. `--tomorrow` reads D itself; without it D is only read after 00:00 UTC. Commits the metric file and redeploys the site. |
| 2. Publish | right after | `python3 publish.py --start <D> --end <D> --live` | Reporter key. `<D>` is the dayKey, e.g. `20260926`. Dry-run first by dropping `--live`. |
| 3. Wait | 60 minutes | | The oracle's dispute window is 3,600 s. `finalize.py --check` shows the countdown. |
| 4. Finalize | from publish + 1 h | `python3 finalize.py --day-key <D> --live` | Finalizer key. Permissionless, any funded wallet. |
| 5. Resolve | right after | `python3 resolve_markets.py --live` | Resolves every closed market whose reading is final. Prints YES or NO and the value. |
| 6. Redeem | right after | On the site, Positions tab, Redeem | With every wallet that holds the winning side. This is the step judges look for. |
| 7. Claim the pool | optional | `python3 claim_liquidity.py --live` | Returns the seeded 10,000 mUSDT (winning side) to the provider. |
| 8. Check | any time | `python3 verify_reading.py --day-key <D> --fetch` | Independent recompute from GridStatus. Paste the PASS lines into `shared/demo-evidence.md`. |
| 9. Evidence | same evening | edit `shared/demo-evidence.md` and `README.md` | Resolve, redeem and claim transaction hashes, read back with `cast`. |

Whole cycle: about 90 minutes, of which 60 are waiting. Start by 18:40 UTC
and it is done by 20:15 UTC, 21:15 London.

Before a cycle on a machine that has not run one, `python3 fetch_ercot.py
--plan --days 3 --fill-gaps --tomorrow` shows what the fetch will spend
without calling GridStatus, and `python3 fetch_ercot.py --usage` shows
what is left of the allowance. Both fetchers stop by themselves above
`--max-requests` (default 10); a routine cycle is one request.

Merge the data branch into `main` afterwards. Data commits are not code
changes and do not break the "do not touch code after submission" rule.

## Calendar

### Wednesday 23 September (today)

- [ ] **Publish the full price history.** The site's Proof section reads
      "3 of 376 days published onchain". Every committed
      `ERCOT_HBNORTH_DA_AVG` file is eligible:
      `python3 publish.py --metric ERCOT_HBNORTH_DA_AVG --start 20250910 --end 20260923`
      (dry run), then the same with `--live`. About 376 transactions, sent
      one after another, roughly 20 minutes. One hour later:
      `python3 finalize.py --metric ERCOT_HBNORTH_DA_AVG --start 20250910 --end 20260923 --live`.
      Then `./refresh_data.sh --no-fetch` so the site shows the new count.
- [ ] **Prove the whole cycle onchain, with a trade in it.** Neither
      resolved market ever had a position or a `redeem()`. Add a replay row
      to `shared/demo-markets.md` on a day whose reading is final (8 Sep
      2026 at a strike other than $30, or any day published above), then
      `python3 create_markets.py --market <row> --live`. Trading closes 45
      minutes after creation. Buy YES with the demo wallet on the site, wait
      for the close, `resolve_markets.py --live`, Redeem on the site,
      `claim_liquidity.py --live`. Record every hash in
      `shared/demo-evidence.md` and the README's "The first live trade"
      section. This is the rehearsal for the video and the finale.
- [ ] **Take a position on the 26 September market** (`0xb1FaDd61…2F94`,
      strike $45) with the demo wallet, before it closes on Friday. Finalist
      selection runs 28 to 30 September; this is the market that will have
      settled with a real position by then.
- [ ] **Verify the contracts' source on OKLink** so address pages show
      Solidity: `OKLINK_API_KEY=… contracts/scripts/verify_contracts.sh`.
      Needs a free OKLink API key.
- [ ] Push this repository state and check the `check` workflow is green on
      GitHub.

### Thursday 24 September

- [ ] Record the demo video from `shared/demo-video-script.md`. Fund the
      recording wallet first: `python3 fund_demo_wallet.py --to 0x… --live`.
- [ ] Five-slide deck.
- [ ] README: demo video link, redeem hashes, test counts.
- [ ] `./scripts/check_all.sh` green. Nothing else changes after this.

### Friday 25 September, submission day

| UTC | London | What |
|---|---|---|
| by 14:00 | 15:00 | Submit. Code freeze. |
| 17:30 | 18:30 | The 26 Sep market closes (`resolveAfter 1790357400`). |
| 18:40 | 19:40 | Run the cycle for `20260926`. |
| ~20:15 | 21:15 | Resolved, redeemed, evidence updated, site refreshed. |
| 23:59 | 00:59 Sat | Hard submission deadline. |

### Saturday 26 to Wednesday 30 September, finalist selection

- Keep the site up. Once a day open the terminal in a fresh browser and
  confirm the markets load and a Buy quote appears; if the public RPC is
  flaky the site's second endpoint takes over, but check.
- **Tuesday 29 September, 17:30 UTC:** both 30 Sep markets close ($45 and
  $40). Run the cycle for `20260930` from 18:40 UTC. Two markets resolve
  from one reading.

### Thursday 1 October

- **17:30 UTC:** both 2 Oct markets close ($45 and $38). Run the cycle for
  `20261002` from 18:40 UTC. The first live trade (19.990009 YES at $45)
  redeems here if the day settles above $45. Redeem it on camera or on the
  explorer either way: a winning redeem or a losing position that pays
  nothing are both evidence the settlement is real.

### Friday 2 to Sunday 4 October, prepare the finale

After 1 October no listed market is open. The finale is in Singapore on
**Wednesday 7 October** (the OKX Builder Kit). The organisers have not
given a time of day in writing; until they do, plan for any hour of that
day, Singapore being UTC+8 and the whole of 7 October there running from
16:00 UTC on the 6th to 16:00 UTC on the 7th.

Three markets cover every case:

- **`20261007`** closes at 17:30 UTC on 6 October and ERCOT publishes its
  price about 18:30 UTC. Run the cycle that evening (from 18:40 UTC; it is
  done by about 20:15 UTC, before 7 October begins in Singapore) and this
  market is **resolved before the presentation**: a settled reading,
  outcome and redeem to show, all from the last 24 hours.
- **`20261008`** closes at 17:30 UTC on 7 October, which is 01:30 on
  8 October in Singapore, so it is **open for trading during the whole of
  7 October there**, at any hour of the presentation.
- **`20261009`** closes a day later and stays open as well, so a second
  strike ladder can be traded live.

- [ ] Add live rows to `shared/demo-markets.md` for `20261007`, `20261008`
      and `20261009` (one or two strikes each, calibrated on the latest
      week of prices as before), then `python3 create_markets.py --live`.
- [ ] `./refresh_data.sh --no-fetch` so `web/public/data/addresses.json`
      lists them and the site is redeployed. Open the terminal and confirm
      they appear.
- [ ] Publish and finalize the readings for 1, 2 and 3 October as they
      arrive (the daily cycle, whether or not a market closes), so the
      Proof section is current on stage.
- [ ] Add a replay row for a recent finalized day (2 October, strike chosen
      so the answer is not obvious) and rehearse the full cycle once more
      end to end: create, buy, close, resolve, redeem, all within an hour.
- [ ] Fund two demo wallets with OKB and 1,000 mUSDT each. One is for the
      stage, one is a spare. Add chain 1952 to both wallets and confirm the
      saved RPC works (the site's Connection help shows how).
- [ ] Offline fallback: screenshots of every screen, the recorded video on
      local disk, and `shared/demo-evidence.md` open in a tab.

### Monday 5 October

- [ ] Full dry run of the stage demo from the hotel network. Time it.
- [ ] Check the OKLink explorer renders the market and transaction pages.

### Tuesday 6 October

- **17:30 UTC:** the 7 October market closes. Run the cycle for `20261007`
  from 18:40 UTC: publish, finalize, resolve, redeem, evidence, site
  refresh. This is the resolved market for the stage.

### Wednesday 7 October, finale in Singapore (time of day unconfirmed)

- Live: buy on the open 8 or 9 October market, show the position, then show
  the 7 October market: its reading, outcome and a redeem from the night
  before.
- If the replay market is used on stage, create it at the start of the slot
  (trading closes 45 minutes later, so resolve and redeem fit inside the
  same session).
- If the RPC or the wallet fails, switch to the recorded video and the
  evidence file. Say "simulated market on testnet" once, out loud.

## After the hackathon

The two rules that made this calendar necessary are worth revisiting once
the demo is over: a scheduled publish and finalize (a small server or a
scheduled workflow with the reporter key in a secret store) and a second
reporter. Both are listed as next steps in the README.
