import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hexbytes import HexBytes
from web3 import Web3
from web3.exceptions import BadFunctionCallOutput

import create_markets
from publish import PublisherError


class TestFactoryCompatibilityGuard(unittest.TestCase):
    def test_loads_runtime_from_local_build_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "MarketFactory.json"
            artifact.write_text(
                json.dumps({"deployedBytecode": {"object": "0x6001600055"}}),
                encoding="utf-8",
            )
            with patch.object(create_markets, "MARKET_FACTORY_ARTIFACT_PATH", artifact):
                self.assertEqual(
                    create_markets.expected_factory_runtime(), HexBytes("0x6001600055")
                )

    def test_missing_artifact_stops_before_any_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.json"
            with patch.object(create_markets, "MARKET_FACTORY_ARTIFACT_PATH", missing):
                with self.assertRaisesRegex(PublisherError, "forge build"):
                    create_markets.expected_factory_runtime()

    def test_preflight_rejects_obsolete_factory_runtime(self):
        w3 = MagicMock()
        w3.eth.chain_id = create_markets.EXPECTED_CHAIN_ID
        w3.eth.get_code.side_effect = [
            HexBytes("0x01"),
            HexBytes("0xdeadbeef"),
            HexBytes("0x02"),
        ]
        w3.eth.get_balance.return_value = 1
        addresses = {
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")

        with patch.object(
            create_markets, "expected_factory_runtime", return_value=HexBytes("0xcafebabe")
        ):
            with self.assertRaisesRegex(PublisherError, "does not match"):
                create_markets.preflight(w3, addresses, account)

    def test_preflight_accepts_exact_factory_runtime(self):
        expected = HexBytes("0xcafebabe")
        w3 = MagicMock()
        w3.eth.chain_id = create_markets.EXPECTED_CHAIN_ID
        w3.eth.get_code.side_effect = [HexBytes("0x01"), expected, HexBytes("0x02")]
        w3.eth.get_balance.return_value = 123
        addresses = {
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        account = SimpleNamespace(address="0x0000000000000000000000000000000000000004")

        with patch.object(create_markets, "expected_factory_runtime", return_value=expected):
            self.assertEqual(
                create_markets.preflight(w3, addresses, account),
                (create_markets.EXPECTED_CHAIN_ID, 123),
            )


def make_candidate(
    row: int = 1,
    metric_id: str = "ERCOT_HBNORTH_DA_AVG",
    day_key: int = 20260908,
    threshold: int = 3000,
    kind: str = create_markets.KIND_REPLAY,
) -> create_markets.CandidateMarket:
    return create_markets.CandidateMarket(
        row=row, metric_id=metric_id, day_key=day_key, threshold=threshold,
        label=f"{metric_id} dayKey {day_key}", kind=kind,
    )


class TestCallWithRetry(unittest.TestCase):
    """RPC-lag recovery for a view call against a market just returned by
    createMarket's own receipt - not a decoding bug, not a wrong address."""

    def test_succeeds_immediately_without_sleeping(self):
        with patch.object(create_markets.time, "sleep") as mock_sleep:
            result = create_markets.call_with_retry(lambda: 42)
        self.assertEqual(result, 42)
        mock_sleep.assert_not_called()

    def test_retries_empty_return_data_then_succeeds(self):
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise BadFunctionCallOutput("empty return data")
            return "ok"

        with patch.object(create_markets.time, "sleep") as mock_sleep:
            result = create_markets.call_with_retry(flaky, attempts=5, delay=1.0)
        self.assertEqual(result, "ok")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(mock_sleep.call_count, 2)

    def test_raises_the_original_error_after_exhausting_attempts(self):
        def always_empty():
            raise BadFunctionCallOutput("still empty")

        with patch.object(create_markets.time, "sleep"):
            with self.assertRaises(BadFunctionCallOutput):
                create_markets.call_with_retry(always_empty, attempts=3, delay=0)

    def test_a_different_exception_is_never_retried(self):
        calls = {"n": 0}

        def broken():
            calls["n"] += 1
            raise ValueError("not a call-output problem")

        with self.assertRaises(ValueError):
            create_markets.call_with_retry(broken, attempts=5, delay=0)
        self.assertEqual(calls["n"], 1)


class TestFactoryDeploymentBlock(unittest.TestCase):
    def test_reads_the_block_number_from_the_recorded_deployment_transaction(self):
        w3 = MagicMock()
        w3.eth.get_transaction_receipt.return_value = SimpleNamespace(blockNumber=41569303)
        addresses_content = {"chainId": 1952, "transactions": {"MarketFactory": "0xdeadbeef"}}
        with patch.object(create_markets, "load_json", return_value=addresses_content):
            block = create_markets.factory_deployment_block(w3)
        self.assertEqual(block, 41569303)
        w3.eth.get_transaction_receipt.assert_called_once_with("0xdeadbeef")

    def test_raises_when_addresses_json_has_no_deployment_tx(self):
        w3 = MagicMock()
        with patch.object(create_markets, "load_json", return_value={"transactions": {}}):
            with self.assertRaisesRegex(PublisherError, "no transactions.MarketFactory"):
                create_markets.factory_deployment_block(w3)


class TestFindMarketCreatedEvent(unittest.TestCase):
    """The pagination this RPC endpoint requires: a single wide-range
    eth_getLogs call is rejected outright (see module docstring), so every
    call here must carry an explicit, bounded from_block/to_block."""

    def test_paginates_backward_in_bounded_windows_until_found(self):
        w3 = MagicMock()
        w3.eth.block_number = 1000
        factory_contract = MagicMock()
        found = [{"args": {}, "transactionHash": HexBytes("0x01"), "blockNumber": 900}]
        factory_contract.events.MarketCreated.get_logs.side_effect = [[], [], found]

        with patch.object(create_markets.time, "sleep"):
            event = create_markets.find_market_created_event(
                w3, factory_contract, "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", earliest_block=800
            )

        self.assertIsNotNone(event)
        self.assertEqual(factory_contract.events.MarketCreated.get_logs.call_count, 3)
        for call in factory_contract.events.MarketCreated.get_logs.call_args_list:
            kwargs = call.kwargs
            self.assertIn("from_block", kwargs)
            self.assertIn("to_block", kwargs)
            span = kwargs["to_block"] - kwargs["from_block"] + 1
            self.assertLessEqual(span, create_markets.GET_LOGS_CHUNK_BLOCKS)

    def test_gives_up_and_returns_none_at_earliest_block_without_raising(self):
        w3 = MagicMock()
        w3.eth.block_number = 850
        factory_contract = MagicMock()
        factory_contract.events.MarketCreated.get_logs.return_value = []

        with patch.object(create_markets.time, "sleep"):
            event = create_markets.find_market_created_event(
                w3, factory_contract, "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", earliest_block=800
            )

        self.assertIsNone(event)


class TestBackfillExistingMarket(unittest.TestCase):
    """Recording a market that already exists on chain but is missing from
    the local ledger. Core parameters are read directly from the market
    contract and cross-checked against the candidate; find_market_created_
    event (tested above) supplies only the tx hash / initial liquidity
    provenance, and its absence must not block the rest of the record."""

    def setUp(self):
        self.candidate = make_candidate()
        self.market_address = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"
        self.w3 = MagicMock()
        self.market_contract = MagicMock()
        self.market_contract.functions.threshold().call.return_value = 3000
        self.market_contract.functions.yesToken().call.return_value = (
            "0x22347e66F45397bDfdA3263474ecc9f07786616c"
        )
        self.market_contract.functions.noToken().call.return_value = (
            "0xce563Ebad699d7b211ED387BaF4e08cef2C33677"
        )
        self.market_contract.functions.resolveAfter().call.return_value = 1790031068
        self.market_contract.functions.disputeWindow().call.return_value = 0
        self.w3.eth.contract.return_value = self.market_contract
        self.factory_contract = MagicMock()

    def test_builds_the_record_from_contract_reads_plus_the_creation_event(self):
        event = {
            "args": {"initialLiquidity": 10_000_000_000},
            "transactionHash": HexBytes(
                "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677"
            ),
            "blockNumber": 41571661,
        }
        self.w3.eth.get_block.return_value = {"timestamp": 1758000000}

        with patch.object(create_markets, "factory_deployment_block", return_value=41569303), \
                patch.object(
                    create_markets, "find_market_created_event", return_value=event
                ) as mock_find:
            record = create_markets.backfill_existing_market(
                self.w3, self.factory_contract, [], self.candidate, self.market_address
            )

        mock_find.assert_called_once_with(
            self.w3, self.factory_contract, self.market_address, 41569303
        )
        self.assertEqual(record["market"], self.market_address)
        self.assertEqual(record["metricId"], "ERCOT_HBNORTH_DA_AVG")
        self.assertEqual(record["dayKey"], 20260908)
        self.assertEqual(record["threshold"], 3000)
        self.assertEqual(record["resolveAfter"], 1790031068)
        self.assertEqual(record["disputeWindow"], 0)
        self.assertEqual(record["initialLiquidity"], 10_000_000_000)
        self.assertEqual(
            record["yesToken"], Web3.to_checksum_address("0x22347e66F45397bDfdA3263474ecc9f07786616c")
        )
        self.assertEqual(
            record["noToken"], Web3.to_checksum_address("0xce563Ebad699d7b211ED387BaF4e08cef2C33677")
        )
        self.assertEqual(
            record["createTxHash"],
            "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677",
        )
        self.assertEqual(record["totalGasCost"], 0)
        self.assertTrue(record["backfilled"])

    def test_refuses_when_on_chain_threshold_does_not_match_the_candidate(self):
        self.market_contract.functions.threshold().call.return_value = 999
        with patch.object(create_markets, "factory_deployment_block", return_value=41569303), \
                patch.object(create_markets, "find_market_created_event", return_value=None):
            with self.assertRaisesRegex(PublisherError, "does not match"):
                create_markets.backfill_existing_market(
                    self.w3, self.factory_contract, [], self.candidate, self.market_address
                )

    def test_still_records_core_parameters_when_the_creation_event_cannot_be_found(self):
        with patch.object(create_markets, "factory_deployment_block", return_value=41569303), \
                patch.object(create_markets, "find_market_created_event", return_value=None):
            buffer = io.StringIO()
            with contextlib.redirect_stderr(buffer):
                record = create_markets.backfill_existing_market(
                    self.w3, self.factory_contract, [], self.candidate, self.market_address
                )
        self.assertEqual(record["threshold"], 3000)
        self.assertEqual(record["resolveAfter"], 1790031068)
        self.assertIsNone(record["createTxHash"])
        self.assertIsNone(record["initialLiquidity"])
        self.assertIn("WARNING", buffer.getvalue())


class TestExistingMarketsMapsPairToAddress(unittest.TestCase):
    def test_returns_a_dict_not_a_bare_set(self):
        w3 = MagicMock()
        market_contract = MagicMock()
        market_contract.functions.metricId().call.return_value = HexBytes("0x" + "aa" * 32)
        market_contract.functions.dayKey().call.return_value = 20260908
        w3.eth.contract.return_value = market_contract
        factory_contract = MagicMock()
        factory_contract.functions.getMarkets().call.return_value = ["0x1234567890123456789012345678901234567890"]

        with patch.object(create_markets.time, "sleep"):
            pairs = create_markets.existing_markets(w3, factory_contract, [])

        self.assertIsInstance(pairs, dict)
        self.assertEqual(
            pairs[f"{('aa' * 32)}:20260908"],
            Web3.to_checksum_address("0x1234567890123456789012345678901234567890"),
        )


class TestBackfillDoesNotDuplicateCreation(unittest.TestCase):
    """The regression this fix addresses: a market that already exists on
    chain (found via existing_markets) but is missing from the local ledger
    must be recorded, never recreated - create_one_market must not be
    called for it, and the one truly missing market is still created."""

    def setUp(self):
        self.addresses = {
            "chainId": create_markets.EXPECTED_CHAIN_ID,
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        self.candidate_1 = make_candidate(row=1)
        self.candidate_4 = make_candidate(
            row=4, metric_id="ERCOT_WEST_NORTH_DA_BASIS", day_key=20260812, threshold=0
        )
        self.existing_market_address = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"

    def test_live_run_records_the_existing_market_and_creates_only_the_missing_one(self):
        w3 = MagicMock()
        w3.eth.contract.return_value.functions.threshold().call.return_value = (
            self.candidate_1.threshold
        )
        account = SimpleNamespace(address="0x0000000000000000000000000000000000000009")

        backfilled_record = {
            "metricId": "ERCOT_HBNORTH_DA_AVG", "dayKey": 20260908, "threshold": 3000,
            "market": self.existing_market_address, "yesToken": "0xYes", "noToken": "0xNo",
            "resolveAfter": 1, "disputeWindow": 0, "initialLiquidity": 1,
            "createTxHash": "0xold", "createdAt": "2026-01-01T00:00:00Z",
            "totalGasCost": 0, "backfilled": True,
        }
        created_record = {
            "metricId": "ERCOT_WEST_NORTH_DA_BASIS", "dayKey": 20260812, "threshold": 0,
            "market": "0xNewMarket", "yesToken": "0xYes4", "noToken": "0xNo4",
            "resolveAfter": 2, "disputeWindow": 0, "initialLiquidity": 1,
            "createTxHash": "0xnew", "createdAt": "2026-01-01T00:00:00Z",
            "totalGasCost": 100,
        }
        existing_pair_key = f"{self.candidate_1.metric_hash.hex()}:{self.candidate_1.day_key}"

        with patch.object(create_markets, "load_addresses", return_value=self.addresses), \
                patch.object(create_markets, "make_web3", return_value=w3), \
                patch.object(create_markets, "load_abi", return_value=[]), \
                patch.object(
                    create_markets, "parse_demo_markets_candidates",
                    return_value=[self.candidate_1, self.candidate_4],
                ), \
                patch.object(
                    create_markets, "existing_markets",
                    return_value={existing_pair_key: self.existing_market_address},
                ), \
                patch.object(
                    create_markets, "chain_oracle_reading",
                    return_value={"value": -1032, "finalized": True},
                ), \
                patch.object(create_markets, "load_market_ledger", return_value={}), \
                patch.object(create_markets, "save_market_ledger"), \
                patch.object(create_markets, "load_finalizer_account", return_value=account), \
                patch.object(
                    create_markets, "preflight",
                    return_value=(create_markets.EXPECTED_CHAIN_ID, 10**18),
                ), \
                patch.object(
                    create_markets, "backfill_existing_market", return_value=backfilled_record
                ) as mock_backfill, \
                patch.object(
                    create_markets, "create_one_market", return_value=created_record
                ) as mock_create, \
                patch.object(create_markets, "write_addresses_file") as mock_write_addresses, \
                patch.object(create_markets, "write_web_env"), \
                patch("builtins.input", return_value="yes"):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                # Both rows are replay markets, so both must be named.
                exit_code = create_markets.main(
                    ["--live", "--market", "1", "--market", "4"]
                )

        self.assertEqual(exit_code, 0)
        mock_backfill.assert_called_once()
        self.assertEqual(mock_backfill.call_args.args[3], self.candidate_1)
        self.assertEqual(mock_backfill.call_args.args[4], self.existing_market_address)
        mock_create.assert_called_once()
        self.assertEqual(mock_create.call_args.args[6], self.candidate_4)
        mock_write_addresses.assert_called_once_with([created_record, backfilled_record])
        output = buffer.getvalue()
        self.assertIn("RECORDED", output)
        self.assertIn("CREATED", output)

    def test_dry_run_flags_an_existing_unrecorded_market_without_writing_anything(self):
        w3 = MagicMock()
        w3.eth.contract.return_value.functions.threshold().call.return_value = (
            self.candidate_1.threshold
        )
        existing_pair_key = f"{self.candidate_1.metric_hash.hex()}:{self.candidate_1.day_key}"

        with patch.object(create_markets, "load_addresses", return_value=self.addresses), \
                patch.object(create_markets, "make_web3", return_value=w3), \
                patch.object(create_markets, "load_abi", return_value=[]), \
                patch.object(
                    create_markets, "parse_demo_markets_candidates",
                    return_value=[self.candidate_1, self.candidate_4],
                ), \
                patch.object(
                    create_markets, "existing_markets",
                    return_value={existing_pair_key: self.existing_market_address},
                ), \
                patch.object(
                    create_markets, "chain_oracle_reading",
                    return_value={"value": -1032, "finalized": True},
                ), \
                patch.object(create_markets, "load_market_ledger", return_value={}), \
                patch.object(create_markets, "backfill_existing_market") as mock_backfill, \
                patch.object(create_markets, "create_one_market") as mock_create, \
                patch("builtins.input", side_effect=AssertionError("dry run must not prompt")):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = create_markets.main([])

        self.assertEqual(exit_code, 0)
        mock_backfill.assert_not_called()
        mock_create.assert_not_called()
        output = buffer.getvalue()
        self.assertIn("ALREADY EXISTS, verified - skipping", output)
        self.assertIn("not yet in local ledger; --live will record it", output)
        self.assertIn("ELIGIBLE", output)
        self.assertIn("DRY RUN ONLY", output)


class TestRecordIsComplete(unittest.TestCase):
    def test_none_is_incomplete(self):
        self.assertFalse(create_markets.record_is_complete(None))

    def test_missing_entry_key_is_incomplete(self):
        self.assertFalse(create_markets.record_is_complete({}.get("anything")))

    def test_partial_record_with_only_a_tx_hash_is_incomplete(self):
        self.assertFalse(
            create_markets.record_is_complete({"createTxHash": "0xabc", "market": "0xMarket"})
        )

    def test_full_record_is_complete(self):
        self.assertTrue(
            create_markets.record_is_complete(
                {"yesToken": "0xYes", "noToken": "0xNo", "createTxHash": "0xabc"}
            )
        )


class TestCreateOneMarketPartialLedgerWrite(unittest.TestCase):
    """The recovery this whole feature depends on: the createTxHash must
    already be in the ledger the instant createMarket confirms, not only
    after the yesToken()/noToken() reads that have previously crashed."""

    def test_writes_the_tx_hash_to_the_ledger_before_the_crash_prone_reads(self):
        w3 = MagicMock()
        account = SimpleNamespace(address="0xSigner")
        addresses = {
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        factory_contract = MagicMock()
        collateral_contract = MagicMock()
        candidate = make_candidate()
        ledger: dict = {}

        receipt = SimpleNamespace(
            transactionHash=HexBytes(
                "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677"
            )
        )
        factory_contract.events.MarketCreated().process_receipt.return_value = [
            {"args": {"market": "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"}}
        ]
        market_contract = MagicMock()
        market_contract.functions.yesToken().call.side_effect = ValueError("simulated crash")
        w3.eth.contract.return_value = market_contract

        with patch.object(
            create_markets, "send_tx",
            side_effect=[(MagicMock(), 1), (MagicMock(), 1), (receipt, 1)],
        ), patch.object(create_markets, "save_market_ledger") as mock_save:
            with self.assertRaises(ValueError):
                create_markets.create_one_market(
                    w3, account, addresses, factory_contract, collateral_contract, [],
                    candidate, 2700, 10_000_000_000, Path("/tmp/x.log"), ledger,
                )

        self.assertIn(candidate.key, ledger)
        self.assertEqual(
            ledger[candidate.key]["createTxHash"],
            "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677",
        )
        self.assertNotIn("yesToken", ledger[candidate.key])
        self.assertFalse(create_markets.record_is_complete(ledger[candidate.key]))
        mock_save.assert_called_once()


class TestEventFromKnownTxHash(unittest.TestCase):
    """The fast path: one eth_getTransactionReceipt call, no block-range
    search, used whenever the ledger already names the creation tx."""

    def test_returns_the_event_matching_the_given_market(self):
        w3 = MagicMock()
        w3.eth.get_transaction_receipt.return_value = MagicMock()
        factory_contract = MagicMock()
        market = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"
        factory_contract.events.MarketCreated().process_receipt.return_value = [
            {"args": {"market": "0x0000000000000000000000000000000000000099"}},
            {"args": {"market": market}},
        ]

        event = create_markets.event_from_known_tx_hash(w3, factory_contract, market, "0xabc")

        self.assertIsNotNone(event)
        self.assertEqual(Web3.to_checksum_address(event["args"]["market"]), market)
        w3.eth.get_transaction_receipt.assert_called_once_with("0xabc")

    def test_returns_none_when_the_receipt_lookup_fails(self):
        w3 = MagicMock()
        w3.eth.get_transaction_receipt.side_effect = Exception("not found")
        factory_contract = MagicMock()

        event = create_markets.event_from_known_tx_hash(
            w3, factory_contract, "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", "0xabc"
        )

        self.assertIsNone(event)

    def test_returns_none_when_no_event_in_the_receipt_matches_the_market(self):
        w3 = MagicMock()
        w3.eth.get_transaction_receipt.return_value = MagicMock()
        factory_contract = MagicMock()
        factory_contract.events.MarketCreated().process_receipt.return_value = [
            {"args": {"market": "0x0000000000000000000000000000000000000099"}},
        ]

        event = create_markets.event_from_known_tx_hash(
            w3, factory_contract, "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", "0xabc"
        )

        self.assertIsNone(event)


class TestBackfillPrefersTheKnownTxHash(unittest.TestCase):
    """backfill_existing_market must try the ledger's own createTxHash
    (one RPC call) before ever falling back to the paginated block search
    (many RPC calls) - this is the whole point of the optimization."""

    def setUp(self):
        self.candidate = make_candidate()
        self.market_address = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"
        self.w3 = MagicMock()
        self.market_contract = MagicMock()
        self.market_contract.functions.threshold().call.return_value = self.candidate.threshold
        self.market_contract.functions.yesToken().call.return_value = (
            "0x22347e66F45397bDfdA3263474ecc9f07786616c"
        )
        self.market_contract.functions.noToken().call.return_value = (
            "0xce563Ebad699d7b211ED387BaF4e08cef2C33677"
        )
        self.market_contract.functions.resolveAfter().call.return_value = 1790031068
        self.market_contract.functions.disputeWindow().call.return_value = 0
        self.w3.eth.contract.return_value = self.market_contract
        self.w3.eth.get_block.return_value = {"timestamp": 1758000000}
        self.factory_contract = MagicMock()

    def test_skips_the_paginated_search_when_the_known_hash_resolves(self):
        event = {
            "args": {"initialLiquidity": 10_000_000_000},
            "transactionHash": HexBytes(
                "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677"
            ),
            "blockNumber": 41571661,
        }
        with patch.object(
            create_markets, "event_from_known_tx_hash", return_value=event
        ) as mock_known, \
                patch.object(create_markets, "find_market_created_event") as mock_search:
            record = create_markets.backfill_existing_market(
                self.w3, self.factory_contract, [], self.candidate, self.market_address,
                known_tx_hash="0x17b554e0...",
            )

        mock_known.assert_called_once_with(
            self.w3, self.factory_contract, self.market_address, "0x17b554e0..."
        )
        mock_search.assert_not_called()
        self.assertEqual(
            record["createTxHash"],
            "0x17b554e029718fcdd1aaf79a60a7db2de0523f5038717e3abdb1ef2ed13de677",
        )

    def test_falls_back_to_the_paginated_search_when_the_known_hash_does_not_resolve(self):
        with patch.object(create_markets, "event_from_known_tx_hash", return_value=None) as mock_known, \
                patch.object(create_markets, "factory_deployment_block", return_value=1), \
                patch.object(create_markets, "find_market_created_event", return_value=None) as mock_search:
            record = create_markets.backfill_existing_market(
                self.w3, self.factory_contract, [], self.candidate, self.market_address,
                known_tx_hash="0xstale",
            )

        mock_known.assert_called_once()
        mock_search.assert_called_once()
        self.assertIsNone(record["createTxHash"])

    def test_no_known_hash_goes_straight_to_the_paginated_search(self):
        with patch.object(create_markets, "event_from_known_tx_hash") as mock_known, \
                patch.object(create_markets, "factory_deployment_block", return_value=1), \
                patch.object(create_markets, "find_market_created_event", return_value=None) as mock_search:
            create_markets.backfill_existing_market(
                self.w3, self.factory_contract, [], self.candidate, self.market_address,
                known_tx_hash=None,
            )

        mock_known.assert_not_called()
        mock_search.assert_called_once()


class TestToBackfillIncludesPartialLedgerEntries(unittest.TestCase):
    """main()'s selection of what to backfill must catch a partial ledger
    entry (createTxHash saved, tokens not), not just a fully-missing one -
    and must pass its known createTxHash through so backfill uses the fast
    path instead of searching for it all over again."""

    def test_partial_entry_is_backfilled_using_its_own_known_tx_hash(self):
        candidate = make_candidate()
        market_address = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"
        w3 = MagicMock()
        w3.eth.contract.return_value.functions.threshold().call.return_value = candidate.threshold
        addresses = {
            "chainId": create_markets.EXPECTED_CHAIN_ID,
            "oracle": "0x0000000000000000000000000000000000000001",
            "factory": "0x0000000000000000000000000000000000000002",
            "collateral": "0x0000000000000000000000000000000000000003",
        }
        existing_pair_key = f"{candidate.metric_hash.hex()}:{candidate.day_key}"
        partial_ledger = {candidate.key: {"createTxHash": "0xpartial", "market": market_address}}
        backfilled_record = {
            "metricId": candidate.metric_id, "dayKey": candidate.day_key,
            "threshold": candidate.threshold, "market": market_address,
            "yesToken": "0xYes", "noToken": "0xNo", "resolveAfter": 1, "disputeWindow": 0,
            "initialLiquidity": 1, "createTxHash": "0xpartial", "createdAt": "2026-01-01T00:00:00Z",
            "totalGasCost": 0, "backfilled": True,
        }

        with patch.object(create_markets, "load_addresses", return_value=addresses), \
                patch.object(create_markets, "make_web3", return_value=w3), \
                patch.object(create_markets, "load_abi", return_value=[]), \
                patch.object(
                    create_markets, "parse_demo_markets_candidates", return_value=[candidate]
                ), \
                patch.object(
                    create_markets, "existing_markets",
                    return_value={existing_pair_key: market_address},
                ), \
                patch.object(create_markets, "load_market_ledger", return_value=partial_ledger), \
                patch.object(create_markets, "save_market_ledger"), \
                patch.object(
                    create_markets, "load_finalizer_account",
                    return_value=SimpleNamespace(address="0xSigner"),
                ), \
                patch.object(
                    create_markets, "preflight",
                    return_value=(create_markets.EXPECTED_CHAIN_ID, 10**18),
                ), \
                patch.object(
                    create_markets, "backfill_existing_market", return_value=backfilled_record
                ) as mock_backfill, \
                patch.object(create_markets, "write_addresses_file"), \
                patch.object(create_markets, "write_web_env"), \
                patch("builtins.input", return_value="yes"):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                exit_code = create_markets.main(["--live"])

        self.assertEqual(exit_code, 0)
        mock_backfill.assert_called_once()
        self.assertEqual(mock_backfill.call_args.kwargs.get("known_tx_hash"), "0xpartial")



def utc_epoch(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp())


SUMMARY_HEADER = (
    "## Summary table\n\n"
    "| # | Metric | Question threshold | dayKey | Date | Kind | Trading close |\n"
    "|---|---|---|---|---|---|---|\n"
)


class TestDemoMarketsDocument(unittest.TestCase):
    """The real shared/demo-markets.md: the five markets it names, and a
    Trading close column that says exactly what the script will send."""

    def setUp(self):
        self.candidates = create_markets.parse_demo_markets_candidates()

    def test_parses_two_replay_and_three_live_texas_power_markets(self):
        self.assertEqual(
            [(c.row, c.kind, c.metric_id, c.day_key, c.threshold) for c in self.candidates],
            [
                (1, "replay", "ERCOT_HBNORTH_DA_AVG", 20250911, 2500),
                (2, "live", "ERCOT_HBNORTH_DA_AVG", 20260926, 4500),
                (3, "live", "ERCOT_HBNORTH_DA_AVG", 20260930, 4500),
                (4, "live", "ERCOT_HBNORTH_DA_AVG", 20261002, 4500),
                (5, "replay", "ERCOT_HBNORTH_DA_AVG", 20250910, 2000),
            ],
        )

    def test_trading_close_column_matches_what_the_script_computes(self):
        text = create_markets.DEMO_MARKETS_PATH.read_text(encoding="utf-8")
        table = create_markets._table_lines(text, create_markets.SUMMARY_TABLE_HEADING)
        documented = {
            int(cells[3].strip("`")): cells[6]
            for cells in ([c.strip() for c in line.strip("|").split("|")] for line in table[2:])
        }
        for candidate in self.candidates:
            if candidate.kind == create_markets.KIND_LIVE:
                expected = create_markets.format_close(
                    create_markets.live_trading_close(candidate.day_key)
                )
            else:
                expected = f"{create_markets.DEFAULT_REPLAY_WINDOW_MINUTES} min after creation"
            self.assertEqual(documented[candidate.day_key], expected, candidate.day_key)

    def test_finalize_verify_still_parses_the_same_table(self):
        import finalize

        self.assertEqual(
            finalize.parse_demo_markets_summary_table(),
            [(c.metric_id, c.day_key) for c in self.candidates],
        )


class TestSummaryTableValidation(unittest.TestCase):
    def parse(self, rows: str):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "demo-markets.md"
            path.write_text(SUMMARY_HEADER + rows, encoding="utf-8")
            return create_markets.parse_demo_markets_candidates(path)

    def test_rejects_an_unknown_kind(self):
        with self.assertRaisesRegex(PublisherError, "expected one of live, replay"):
            self.parse("| 1 | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20260926` | x | forward | x |\n")

    def test_rejects_the_same_metric_and_day_key_twice(self):
        row = "| {n} | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20260926` | x | live | x |\n"
        with self.assertRaisesRegex(PublisherError, "same metric/dayKey twice"):
            self.parse(row.format(n=1) + row.format(n=2))

    def test_rejects_a_day_key_that_is_not_a_date(self):
        with self.assertRaisesRegex(PublisherError, "not a YYYYMMDD date"):
            self.parse("| 1 | `ERCOT_HBNORTH_DA_AVG` | > $45 | `20260931` | x | live | x |\n")


class TestTradingClose(unittest.TestCase):
    def test_live_close_is_1230_texas_the_day_before(self):
        # 12:30 CDT (UTC-5) on 25 Sep = 17:30 UTC = 18:30 BST.
        self.assertEqual(
            create_markets.live_trading_close(20260926), utc_epoch("2026-09-25T17:30:00+00:00")
        )
        self.assertEqual(
            create_markets.format_close(create_markets.live_trading_close(20260926)),
            "2026-09-25 12:30 CDT (Texas) / 18:30 BST (London)",
        )

    def test_live_close_stays_1230_local_after_texas_leaves_daylight_time(self):
        # Texas falls back on 1 Nov 2026: 12:30 CST (UTC-6) = 18:30 UTC.
        self.assertEqual(
            create_markets.live_trading_close(20261103), utc_epoch("2026-11-02T18:30:00+00:00")
        )

    def test_london_clock_follows_its_own_dst_change(self):
        # London leaves BST on 25 Oct, a week before Texas leaves CDT.
        self.assertEqual(
            create_markets.format_close(create_markets.live_trading_close(20261028)),
            "2026-10-27 12:30 CDT (Texas) / 17:30 GMT (London)",
        )

    def test_replay_close_counts_from_now(self):
        replay = make_candidate(kind=create_markets.KIND_REPLAY)
        self.assertEqual(create_markets.trading_close(replay, 1_000, 2_700), 3_700)

    def test_live_close_ignores_now(self):
        live = make_candidate(day_key=20260926, kind=create_markets.KIND_LIVE)
        self.assertEqual(
            create_markets.trading_close(live, 1_000, 2_700),
            create_markets.live_trading_close(20260926),
        )

    def test_dispute_window_by_kind(self):
        self.assertEqual(make_candidate(kind=create_markets.KIND_REPLAY).dispute_window, 0)
        self.assertEqual(
            make_candidate(kind=create_markets.KIND_LIVE).dispute_window, 7 * 24 * 60 * 60
        )


class TestBuildPlanByKind(unittest.TestCase):
    NOW = utc_epoch("2026-09-22T12:00:00+00:00")

    def plan(self, candidates, reading=None, existing=None):
        oracle = MagicMock()
        w3 = MagicMock()
        w3.eth.contract.return_value.functions.threshold().call.return_value = 4500
        with patch.object(
            create_markets, "chain_oracle_reading", return_value=reading
        ) as mock_reading, patch.object(create_markets.time, "sleep"):
            evaluations = create_markets.build_plan(
                candidates, oracle, existing or {}, w3, [], now=self.NOW,
                replay_window_seconds=2_700,
            )
        return evaluations, mock_reading

    def test_future_live_market_is_eligible_without_any_reading(self):
        live = make_candidate(day_key=20260926, threshold=4500, kind="live")
        [evaluation], mock_reading = self.plan([live])
        self.assertEqual(evaluation.status, create_markets.STATUS_ELIGIBLE)
        self.assertEqual(evaluation.trading_close, create_markets.live_trading_close(20260926))
        mock_reading.assert_not_called()

    def test_live_market_past_its_close_is_refused(self):
        live = make_candidate(day_key=20260922, threshold=4500, kind="live")
        [evaluation], _ = self.plan([live])
        self.assertEqual(evaluation.status, create_markets.STATUS_CLOSE_PASSED)

    def test_live_market_too_near_its_close_is_refused(self):
        live = make_candidate(day_key=20260926, threshold=4500, kind="live")
        close = create_markets.live_trading_close(20260926)
        with patch.object(create_markets.time, "sleep"):
            [evaluation] = create_markets.build_plan(
                [live], MagicMock(), {}, MagicMock(), [], now=close - 60,
            )
        self.assertEqual(evaluation.status, create_markets.STATUS_CLOSE_PASSED)

    def test_replay_needs_a_finalized_reading(self):
        replay = make_candidate(day_key=20250911, threshold=2500)
        [evaluation], _ = self.plan([replay], reading={"value": 2638, "finalized": False})
        self.assertEqual(evaluation.status, create_markets.STATUS_NOT_FINALIZED)

    def test_replay_with_a_finalized_reading_closes_45_minutes_out(self):
        replay = make_candidate(day_key=20250911, threshold=2500)
        [evaluation], _ = self.plan([replay], reading={"value": 2638, "finalized": True})
        self.assertEqual(evaluation.status, create_markets.STATUS_ELIGIBLE)
        self.assertEqual(evaluation.oracle_value, 2638)
        self.assertEqual(evaluation.trading_close, self.NOW + 2_700)

    def test_replay_without_a_reading_is_skipped(self):
        replay = make_candidate(day_key=20250911, threshold=2500)
        [evaluation], _ = self.plan([replay], reading=None)
        self.assertEqual(evaluation.status, create_markets.STATUS_NOT_PUBLISHED)

    def test_an_existing_live_market_is_never_offered_again(self):
        live = make_candidate(day_key=20260926, threshold=4500, kind="live")
        key = f"{live.metric_hash.hex()}:{live.day_key}"
        [evaluation], _ = self.plan([live], existing={key: "0x" + "11" * 20})
        self.assertEqual(evaluation.status, create_markets.STATUS_EXISTS)


class TestCreateOneMarketByKind(unittest.TestCase):
    ADDRESSES = {
        "oracle": "0x0000000000000000000000000000000000000001",
        "factory": "0x0000000000000000000000000000000000000002",
        "collateral": "0x0000000000000000000000000000000000000003",
    }
    MARKET = "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"

    def create(self, candidate, now):
        w3 = MagicMock()
        factory_contract = MagicMock()
        factory_contract.events.MarketCreated().process_receipt.return_value = [
            {"args": {"market": self.MARKET}}
        ]
        w3.eth.contract.return_value.functions.yesToken().call.return_value = "0x" + "22" * 20
        w3.eth.contract.return_value.functions.noToken().call.return_value = "0x" + "33" * 20
        receipt = SimpleNamespace(transactionHash=HexBytes("0x" + "ab" * 32))
        with patch.object(
            create_markets, "send_tx",
            side_effect=[(MagicMock(), 1), (MagicMock(), 1), (receipt, 1)],
        ) as mock_send, patch.object(create_markets, "save_market_ledger"), \
                patch.object(create_markets.time, "time", return_value=now):
            record = create_markets.create_one_market(
                w3, SimpleNamespace(address="0xSigner"), self.ADDRESSES, factory_contract,
                MagicMock(), [], candidate, 2_700, 10_000_000_000, Path("/tmp/x.log"), {},
            )
        return record, factory_contract.functions.createMarket, mock_send

    def test_replay_window_runs_from_creation_with_no_dispute_window(self):
        replay = make_candidate(day_key=20250911, threshold=2500)
        now = utc_epoch("2026-09-22T12:00:00+00:00")
        record, create_market, _ = self.create(replay, now)
        args = create_market.call_args.args
        self.assertEqual(args[5], now + 2_700)  # resolveAfter
        self.assertEqual(args[6], 0)  # disputeWindow
        self.assertEqual(record["kind"], "replay")
        self.assertEqual(record["resolveAfter"], now + 2_700)

    def test_live_market_uses_its_fixed_close_and_seven_day_dispute_window(self):
        live = make_candidate(day_key=20260926, threshold=4500, kind="live")
        record, create_market, _ = self.create(live, utc_epoch("2026-09-22T12:00:00+00:00"))
        args = create_market.call_args.args
        self.assertEqual(args[5], utc_epoch("2026-09-25T17:30:00+00:00"))
        self.assertEqual(args[6], 7 * 24 * 60 * 60)
        self.assertEqual(record["kind"], "live")

    def test_live_market_past_its_close_sends_no_transaction(self):
        live = make_candidate(day_key=20260926, threshold=4500, kind="live")
        with patch.object(create_markets, "send_tx") as mock_send, \
                patch.object(
                    create_markets.time, "time",
                    return_value=utc_epoch("2026-09-25T17:29:00+00:00"),
                ):
            with self.assertRaisesRegex(PublisherError, "no transaction was sent"):
                create_markets.create_one_market(
                    MagicMock(), SimpleNamespace(address="0xSigner"), self.ADDRESSES,
                    MagicMock(), MagicMock(), [], live, 2_700, 1, Path("/tmp/x.log"), {},
                )
        mock_send.assert_not_called()


class TestMainDryRunByKind(unittest.TestCase):
    ADDRESSES = {
        "chainId": create_markets.EXPECTED_CHAIN_ID,
        "oracle": "0x0000000000000000000000000000000000000001",
        "factory": "0x0000000000000000000000000000000000000002",
        "collateral": "0x0000000000000000000000000000000000000003",
    }

    def run_main(self, argv):
        with patch.object(create_markets, "load_addresses", return_value=self.ADDRESSES), \
                patch.object(create_markets, "make_web3", return_value=MagicMock()), \
                patch.object(create_markets, "load_abi", return_value=[]), \
                patch.object(create_markets, "existing_markets", return_value={}), \
                patch.object(
                    create_markets, "chain_oracle_reading",
                    return_value={"value": 2638, "finalized": True},
                ), \
                patch.object(create_markets, "load_market_ledger", return_value={}), \
                patch.object(create_markets.time, "sleep"), \
                patch.object(
                    create_markets.time, "time",
                    return_value=utc_epoch("2026-09-22T12:00:00+00:00"),
                ), \
                patch.object(create_markets, "load_finalizer_account") as mock_key, \
                patch.object(create_markets, "create_one_market") as mock_create, \
                patch("builtins.input", side_effect=AssertionError("dry run must not prompt")):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                exit_code = create_markets.main(argv)
        mock_key.assert_not_called()
        mock_create.assert_not_called()
        return exit_code, out.getvalue(), err.getvalue()

    def test_dry_run_numbers_each_market_and_shows_both_clocks(self):
        exit_code, output, _ = self.run_main([])
        self.assertEqual(exit_code, 0)
        for row in ("#1 [replay]", "#2 [live]", "#3 [live]", "#4 [live]", "#5 [replay]"):
            self.assertIn(row, output)
        self.assertIn("2026-09-25 12:30 CDT (Texas) / 18:30 BST (London)", output)
        self.assertIn(
            "45 min after creation - if created now, "
            "2026-09-22 07:45 CDT (Texas) / 13:45 BST (London)",
            output,
        )
        self.assertIn("Eligible to create:           5", output)
        self.assertIn("DRY RUN ONLY", output)

    def test_unknown_market_row_is_an_error(self):
        exit_code, _, err = self.run_main(["--market", "9"])
        self.assertEqual(exit_code, 1)
        self.assertIn("no such row", err)

    def test_live_run_without_market_refuses_before_loading_the_key(self):
        # run_main also asserts the key is never loaded and nothing is created
        # or prompted: rows 1 and 5 are replay markets nobody named.
        exit_code, _, err = self.run_main(["--live"])
        self.assertEqual(exit_code, 1)
        self.assertIn("#1 dayKey 20250911, #5 dayKey 20250910", err)
        self.assertIn("no transaction was sent", err)


class TestRefuseUnnamedReplays(unittest.TestCase):
    def evaluation(self, candidate):
        return create_markets.Evaluation(candidate, create_markets.STATUS_ELIGIBLE)

    def test_an_unnamed_replay_is_refused(self):
        spare = make_candidate(row=5, day_key=20250910, threshold=2000)
        with self.assertRaisesRegex(PublisherError, "#5 dayKey 20250910"):
            create_markets.refuse_unnamed_replays([self.evaluation(spare)], None)

    def test_a_replay_named_with_market_passes(self):
        replay = make_candidate(row=1, day_key=20250911, threshold=2500)
        create_markets.refuse_unnamed_replays([self.evaluation(replay)], [1])

    def test_naming_one_replay_does_not_cover_the_other(self):
        first = make_candidate(row=1, day_key=20250911, threshold=2500)
        spare = make_candidate(row=5, day_key=20250910, threshold=2000)
        with self.assertRaisesRegex(PublisherError, "#5 dayKey 20250910") as caught:
            create_markets.refuse_unnamed_replays(
                [self.evaluation(first), self.evaluation(spare)], [1]
            )
        self.assertNotIn("#1", str(caught.exception))

    def test_live_markets_need_no_market_flag(self):
        live = make_candidate(
            row=2, day_key=20260926, threshold=4500, kind=create_markets.KIND_LIVE
        )
        create_markets.refuse_unnamed_replays([self.evaluation(live)], None)


if __name__ == "__main__":
    unittest.main()
