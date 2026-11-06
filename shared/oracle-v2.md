# GridOracleV2

**Why it exists.** The first oracle, `GridOracle` at
`0x970cefFC0e75bCa245F3337715992ad520A4D561`, has a permanent reporter: the
address is fixed at deploy, there is no owner, and anyone can finalize a
reading once its hour is up. A leaked reporter key would let anyone publish
any price for any open day and make it final an hour later. Nothing could
stop them or change the key, and every market on that oracle would be
compromised for good. So that key never goes into automation. The oracle is
retired once the 14–20 Oct markets are settled, and the automated settle job
(docs/specs/2026-10-13-daily-settle.md) runs only against v2.

**What stays the same.** The `Reading` struct, `submitReading`, `finalize`,
`getReading`, `isFinal`, `disputeWindow`, `reporter` and the two events are
exactly as in `shared/oracle-interface.md`. `BinaryMarket`, `MarketFactory`,
`publish.py`, `finalize.py`, `resolve_markets.py`, `create_markets.py` and
the site work against v2 unchanged. The factory takes the oracle address as
an argument, so no market or factory contract is redeployed. New markets
simply name v2 when they are created.

**What v2 adds** (`contracts/src/GridOracleV2.sol`, tests in
`contracts/test/GridOracleV2.t.sol`):

| | Who | What |
|---|---|---|
| `setReporter(address)` | owner | Replaces the reporter (one transaction after a leak). |
| `setGuardian(address)` | owner | Replaces the guardian. |
| `pause()` | guardian or owner | Stops new readings and finalizing. |
| `unpause()` | owner only | Starts them again. |
| `voidReading(metricId, dayKey)` | guardian or owner | Deletes a reading that is not final yet. Markets then see no reading, so they can be published again or cancelled as usual. Works while paused. |
| `submitReading` | reporter | As before, but refused until the market day has ended (`block.timestamp >= marketDayEndUtc`), so a value can't be published, and finalized, before the day it describes is over. |
| ownership | owner | Two-step transfer (`transferOwnership` + `acceptOwnership`), can't be renounced, and can never go to the reporter. |

The constructor and the setters refuse a zero reporter or guardian, a
reporter that is the owner, and a reporter that is the guardian.

## The three keys

| Role | Where it lives | Testnet choice |
|---|---|---|
| **Owner** | Offline. Used only to replace a key or to unpause. | The existing deployer key `0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902`, in its encrypted keystore on David's laptop. It never goes into GitHub. Before mainnet, use a Safe that needs both founders. |
| **Reporter** | GitHub Actions, the `settle` Environment. | A brand-new key made only for this: `cast wallet new`. No other job, no other contract. |
| **Guardian** | Someone who reads the Telegram alerts. | A wallet one of the founders controls, separate from both keys above. |

A key that has ever been pasted into a chat, a document or a terminal
transcript gets none of these roles.

## Deploy (David)

```bash
cd contracts
forge fmt --check
forge test
export DEPLOYER_ADDRESS=0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902
export OWNER_ADDRESS=0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902
export REPORTER_ADDRESS=<the new CI reporter's address>
export GUARDIAN_ADDRESS=<the guardian wallet's address>
export ORACLE_DISPUTE_WINDOW=3600
forge script script/DeployOracleV2.s.sol:DeployOracleV2 \
  --rpc-url xlayer_testnet \
  --account gridflex-deployer \
  --sender "$DEPLOYER_ADDRESS" \
  --broadcast
```

The dispute window must stay 3600 s, the same as v1's. `switch_oracle.py`
checks it.

## Switching over

1. The 14–20 Oct markets on v1 are resolved or cancelled, and every row of
   `data/publish-ledger.json` is finalized.
2. v2 is deployed (above).
3. `python scripts/switch_oracle.py --oracle <v2> --deploy-tx <tx>` checks
   both of those from the chain and prints the change.
4. Run the same command with `--write`. It moves v1 to
   `legacyDeployments.GridOracle` as `retired`, with `lastDayKey` (the last
   day it holds). It also points `GridOracle` at v2 and records `reporter`,
   `guardian` and `oracleOwner`.
5. Run `python build_feed_data.py`, then commit `shared/addresses.json` and
   `web/public/data/addresses.json` on a branch and merge as usual. The site
   reads every day up to `lastDayKey` from v1 (`web/lib/oracle-for-day.ts`),
   so settled history stays verified.
6. The next ladder (`scripts/extend_ladder.py` → `create_markets.py`) creates
   markets on v2, all for days after `lastDayKey`.

## If something looks wrong: the drill

The settle job posts every published value to Telegram, then waits an hour
before finalizing. A bad value, or a reading nobody on the team sent:

1. **Guardian: pause.** This stops finalizing. Do it first; the hour may be
   nearly up.
   `cast send <v2> "pause()" --rpc-url https://testrpc.xlayer.tech/terigon --account <guardian>`
2. **Guardian: void the bad reading.**
   `cast send <v2> "voidReading(bytes32,uint32)" $(cast keccak ERCOT_HBNORTH_DA_AVG) <YYYYMMDD> --rpc-url https://testrpc.xlayer.tech/terigon --account <guardian>`
3. **If the reporter key may have leaked:** stop the job
   (`gh workflow disable daily-settle`). Make a new reporter key, then
   **owner: `setReporter(<new>)`**, and replace the GitHub secrets.
4. **Owner: `unpause()`.** The settle job republishes the right value on its
   next run.

`testLeakedReporterDrill` in `contracts/test/GridOracleV2.t.sol` runs exactly
this sequence.
