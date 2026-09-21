import contextlib
import io
import json
import tempfile
import unittest
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
) -> create_markets.CandidateMarket:
    return create_markets.CandidateMarket(
        row=row, metric_id=metric_id, day_key=day_key, threshold=threshold,
        label=f"{metric_id} dayKey {day_key}",
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
                exit_code = create_markets.main(["--live"])

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


if __name__ == "__main__":
    unittest.main()
