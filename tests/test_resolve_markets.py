"""resolve_markets.py: which markets get resolved, and the live-mode guards.

The chain is faked at resolve_markets' own seams (list_market_states,
resolve_market, still_unsettled, make_web3), so no RPC call is made.
"""

import contextlib
import io
import unittest
from unittest.mock import MagicMock, patch

from eth_abi import encode
from eth_account import Account
from hexbytes import HexBytes
from web3 import Web3
from web3.datastructures import AttributeDict
from web3.providers.base import BaseProvider

import resolve_markets as rm
from publish import PublisherError

NOW = 1_790_100_000
HBNORTH = Web3.keccak(text="ERCOT_HBNORTH_DA_AVG").hex().removeprefix("0x")
ADDRESSES = {"chainId": 1952, "oracle": "0x" + "11" * 20, "factory": "0x" + "22" * 20,
             "collateral": "0x" + "33" * 20}
# A throwaway key, only ever used to prove the script never prints one.
TEST_KEY = "0x" + "ab" * 32
MARKET = Web3.to_checksum_address("0x1b89e1dc5e5449b230fa7bf60a08972c05fab8c1")
RESOLVED_TOPIC = Web3.keccak(text="Resolved(bool,int256)")


def resolved_log(yes_won, value, address=MARKET, index=0):
    """A Resolved(bool indexed yesWon, int256 oracleValue) log, ABI-encoded."""
    return AttributeDict({
        "address": address,
        "topics": [RESOLVED_TOPIC, HexBytes(encode(["bool"], [yes_won]))],
        "data": HexBytes(encode(["int256"], [value])),
        "blockHash": HexBytes("0x" + "11" * 32),
        "blockNumber": 41622133,
        "logIndex": index,
        "transactionHash": HexBytes("0x" + "22" * 32),
        "transactionIndex": 0,
        "removed": False,
    })


def receipt(*logs):
    return AttributeDict({"transactionHash": HexBytes("0x" + "22" * 32), "status": 1, "logs": list(logs)})


class LaggingNode(BaseProvider):
    """A node that hasn't reached the resolve block: every eth_call sees the
    pre-resolution state, so yesWon() and resolved() both answer false."""

    def __init__(self):
        super().__init__()
        self.calls = []

    def make_request(self, method, params):
        self.calls.append(method)
        if method == "eth_chainId":
            return {"jsonrpc": "2.0", "id": 1, "result": hex(1952)}
        if method == "eth_call":
            return {"jsonrpc": "2.0", "id": 1, "result": "0x" + "00" * 32}
        raise AssertionError(f"unexpected RPC {method}")


def market(n, **overrides):
    fields = dict(
        address=Web3.to_checksum_address(f"0x{n:040x}"),
        metric_hash=HBNORTH,
        day_key=20260908,
        threshold=3000,
        resolve_after=NOW - 60,
        resolved=False,
        cancelled=False,
        yes_won=False,
        reading_value=3957,
        reading_final=True,
    )
    fields.update(overrides)
    return rm.MarketState(**fields)


class TestClassify(unittest.TestCase):
    def test_closed_with_a_final_reading_is_a_candidate(self):
        self.assertEqual(rm.classify(market(1), NOW), rm.STATUS_CANDIDATE)

    def test_closes_exactly_at_resolve_after(self):
        # resolve() reverts only while block.timestamp < resolveAfter.
        self.assertEqual(rm.classify(market(1, resolve_after=NOW), NOW), rm.STATUS_CANDIDATE)
        self.assertEqual(rm.classify(market(1, resolve_after=NOW + 1), NOW), rm.STATUS_NOT_CLOSED)

    def test_skips(self):
        cases = {
            rm.STATUS_RESOLVED: market(1, resolved=True),
            rm.STATUS_CANCELLED: market(1, cancelled=True),
            rm.STATUS_NOT_CLOSED: market(1, resolve_after=NOW + 3600),
            rm.STATUS_NOT_PUBLISHED: market(1, reading_value=None, reading_final=False),
            rm.STATUS_NOT_FINAL: market(1, reading_final=False),
        }
        for expected, state in cases.items():
            with self.subTest(expected):
                self.assertEqual(rm.classify(state, NOW), expected)

    def test_settled_wins_over_everything_else(self):
        state = market(1, resolved=True, resolve_after=NOW + 3600, reading_value=None)
        self.assertEqual(rm.classify(state, NOW), rm.STATUS_RESOLVED)


class TestOutcome(unittest.TestCase):
    def test_yes_only_strictly_above_the_strike(self):
        self.assertTrue(rm.yes_would_win(3001, 3000))
        self.assertFalse(rm.yes_would_win(3000, 3000))
        self.assertFalse(rm.yes_would_win(2999, 3000))

    def test_negative_basis_against_a_zero_strike(self):
        self.assertFalse(rm.yes_would_win(-1032, 0))

    def test_describe_shows_reading_and_winner(self):
        text = "\n".join(rm.describe(market(1), rm.STATUS_CANDIDATE))
        self.assertIn("ERCOT_HBNORTH_DA_AVG dayKey 20260908, strike $30.00/MWh", text)
        self.assertIn("reading: $39.57/MWh (final)", text)
        self.assertIn("would win: YES", text)

    def test_signed_basis_keeps_its_sign(self):
        self.assertEqual(rm.format_value(474, "ERCOT_WEST_NORTH_DA_BASIS"), "+$4.74/MWh")
        self.assertEqual(rm.format_value(474, "ERCOT_HBNORTH_DA_AVG"), "$4.74/MWh")
        self.assertEqual(rm.format_value(-1032, "ERCOT_WEST_NORTH_DA_BASIS"), "-$10.32/MWh")


class TestOutcomeFromTheReceipt(unittest.TestCase):
    """The outcome comes from the Resolved event, never a follow-up call."""

    def setUp(self):
        self.node = LaggingNode()
        self.w3 = Web3(self.node)

    def resolve(self, the_receipt):
        with patch.object(rm, "send_tx", return_value=(the_receipt, 10**12)):
            return rm.resolve_market(self.w3, MagicMock(), MARKET, "unused.log")

    def test_a_lagging_node_cannot_turn_yes_into_no(self):
        # The node would say yesWon() == false; the receipt says YES on 3957.
        self.assertFalse(bool(self.w3.eth.contract(address=MARKET, abi=rm.load_abi("BinaryMarket"))
                              .functions.yesWon().call()))
        tx_hash, gas, yes_won, value = self.resolve(receipt(resolved_log(True, 3957)))
        self.assertTrue(yes_won)
        self.assertEqual(value, 3957)
        self.assertEqual(tx_hash, "0x" + "22" * 32)
        self.assertEqual(self.node.calls.count("eth_call"), 1)  # only the probe above

    def test_a_no_outcome_is_read_the_same_way(self):
        self.assertEqual(self.resolve(receipt(resolved_log(False, -1032)))[2:], (False, -1032))

    def test_a_receipt_without_the_event_stops_the_run(self):
        with self.assertRaisesRegex(PublisherError, "expected one Resolved event"):
            self.resolve(receipt())

    def test_another_contracts_event_is_ignored(self):
        other = Web3.to_checksum_address("0x" + "99" * 20)
        with self.assertRaisesRegex(PublisherError, "found 0"):
            self.resolve(receipt(resolved_log(True, 3957, address=other)))


class TestReadMarket(unittest.TestCase):
    def contracts(self, published_at, finalized):
        w3 = MagicMock()
        m = w3.eth.contract.return_value.functions
        m.metricId.return_value.call.return_value = bytes.fromhex(HBNORTH)
        m.dayKey.return_value.call.return_value = 20260908
        m.threshold.return_value.call.return_value = 3000
        m.resolveAfter.return_value.call.return_value = NOW
        m.resolved.return_value.call.return_value = False
        m.cancelled.return_value.call.return_value = False
        m.yesWon.return_value.call.return_value = False
        oracle = MagicMock()
        oracle.functions.getReading.return_value.call.return_value = (
            bytes.fromhex(HBNORTH), 20260908, 0, 0, 3957, b"\x00" * 32, published_at, finalized)
        oracle.functions.isFinal.return_value.call.return_value = finalized
        return w3, oracle

    def test_published_final_reading(self):
        w3, oracle = self.contracts(published_at=1789000000, finalized=True)
        state = rm.read_market(w3, oracle, "0x" + "44" * 20, [], 41622133)
        self.assertEqual(state.reading_value, 3957)
        self.assertTrue(state.reading_final)
        self.assertEqual(state.metric_name, "ERCOT_HBNORTH_DA_AVG")

    def test_all_reads_use_the_same_block(self):
        w3, oracle = self.contracts(published_at=1789000000, finalized=True)
        rm.read_market(w3, oracle, "0x" + "44" * 20, [], 41622133)
        fns = w3.eth.contract.return_value.functions
        calls = [getattr(fns, n).return_value.call for n in
                 ("metricId", "dayKey", "threshold", "resolveAfter", "resolved", "cancelled", "yesWon")]
        calls += [oracle.functions.getReading.return_value.call, oracle.functions.isFinal.return_value.call]
        for call in calls:
            call.assert_called_once_with(block_identifier=41622133)

    def test_unpublished_reading(self):
        w3, oracle = self.contracts(published_at=0, finalized=False)
        state = rm.read_market(w3, oracle, "0x" + "44" * 20, [], 41622133)
        self.assertIsNone(state.reading_value)
        self.assertFalse(state.reading_final)
        oracle.functions.isFinal.assert_not_called()


class TestMain(unittest.TestCase):
    def setUp(self):
        self.w3 = MagicMock()
        self.w3.eth.chain_id = 1952
        self.w3.eth.get_block.return_value = {"number": 41622200, "timestamp": NOW}
        self.w3.eth.get_balance.return_value = 10**18
        self.w3.eth.get_code.return_value = b"\x60\x80"
        self.states = [
            market(1),                                           # candidate, YES
            market(2, reading_value=2500),                       # candidate, NO
            market(3, resolved=True, yes_won=True),
            market(4, resolve_after=NOW + 3600, reading_value=None),
            market(5, reading_final=False),
        ]
        # The receipt's Resolved event: YES on 3957 for market 1, NO on 2500 for market 2.
        self.resolve = MagicMock(side_effect=lambda w3, account, address, log: (
            "0x" + "cd" * 32, 10**12, address == self.states[0].address,
            3957 if address == self.states[0].address else 2500))
        self.patches = [
            patch.object(rm, "load_addresses", return_value=ADDRESSES),
            patch.object(rm, "make_web3", return_value=self.w3),
            patch.object(rm, "list_market_states", side_effect=lambda w3, a, block: self.states),
            patch.object(rm, "resolve_market", self.resolve),
            patch.object(rm, "still_unsettled", return_value=True),
            patch.dict("os.environ", {"FINALIZER_PRIVATE_KEY": TEST_KEY}, clear=False),
        ]
        for one in self.patches:
            one.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    def main(self, *argv, answer="yes"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                patch("builtins.input", return_value=answer) as prompt:
            code = rm.main(list(argv))
        self.prompt = prompt
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_sends_nothing_and_needs_no_key(self):
        with patch.object(rm, "load_finalizer_account") as load_key:
            code, out, _ = self.main()
        self.assertEqual(code, 0)
        load_key.assert_not_called()
        self.resolve.assert_not_called()
        self.prompt.assert_not_called()
        self.assertIn("DRY RUN ONLY", out)
        self.assertEqual(out.count("CANDIDATE"), 2)
        self.assertIn("SKIP already resolved", out)
        self.assertIn("SKIP trading not closed", out)
        self.assertIn("SKIP reading not final", out)
        self.assertIn("would win: NO", out)
        self.assertIn("resolve_markets summary", out)
        self.assertIn("Candidates:                     2", out)

    def test_wrong_chain_stops_before_reading_markets(self):
        self.w3.eth.chain_id = 1
        code, out, err = self.main()
        self.assertEqual(code, 1)
        self.assertIn("Wrong chain: got 1, expected 1952", err)
        rm.list_market_states.assert_not_called()
        self.assertIn("resolve_markets summary", out)

    def test_live_requires_typed_yes(self):
        code, out, _ = self.main("--live", answer="y")
        self.assertEqual(code, 0)
        self.resolve.assert_not_called()
        self.assertIn("cancelled at confirmation", out)
        self.assertIn("resolve_markets summary", out)

    def test_live_resolves_only_candidates(self):
        code, out, _ = self.main("--live")
        self.assertEqual(code, 0)
        sent = [c.args[2] for c in self.resolve.call_args_list]
        self.assertEqual(sent, [self.states[0].address, self.states[1].address])
        self.assertIn("Resolved this run:              2", out)
        self.assertIn(f"RESOLVED {self.states[0].address} -> YES", out)
        self.assertIn(f"RESOLVED {self.states[1].address} -> NO", out)

    def test_live_never_prints_the_key(self):
        code, out, err = self.main("--live")
        self.assertEqual(code, 0)
        signer = Account.from_key(TEST_KEY).address
        self.assertIn(signer, out)
        for text in (out, err):
            self.assertNotIn(TEST_KEY.removeprefix("0x"), text.lower())

    def test_a_market_resolved_by_someone_else_is_skipped(self):
        with patch.object(rm, "still_unsettled", side_effect=[False, True]):
            code, out, _ = self.main("--live")
        self.assertEqual(code, 0)
        self.assertEqual(self.resolve.call_count, 1)
        self.assertIn("Resolved by someone else first: 1", out)

    def test_nothing_to_resolve_loads_no_key(self):
        self.states = [market(3, resolved=True)]
        with patch.object(rm, "load_finalizer_account") as load_key:
            code, out, _ = self.main("--live")
        self.assertEqual(code, 0)
        load_key.assert_not_called()
        self.assertIn("Nothing to resolve", out)

    def test_an_event_outcome_that_contradicts_the_reading_stops_the_run(self):
        self.resolve.side_effect = lambda *a: ("0x" + "cd" * 32, 1, False, 3957)  # NO on 3957 > 3000
        code, out, err = self.main("--live")
        self.assertEqual(code, 1)
        self.assertEqual(self.resolve.call_count, 1)
        self.assertIn("the Resolved event says NO on $39.57/MWh", err)
        self.assertIn("Stopped early", out)

    def test_an_event_value_that_differs_from_the_reading_stops_the_run(self):
        self.resolve.side_effect = lambda *a: ("0x" + "cd" * 32, 1, True, 4100)
        code, _, err = self.main("--live")
        self.assertEqual(code, 1)
        self.assertIn("but the final reading is $39.57/MWh", err)

    def test_every_read_is_pinned_to_the_snapshot_block(self):
        self.main()
        rm.list_market_states.assert_called_once_with(self.w3, ADDRESSES, 41622200)

    def test_a_failed_transaction_still_prints_the_summary(self):
        self.resolve.side_effect = PublisherError("resolve: transaction reverted; aborting.")
        code, out, _ = self.main("--live")
        self.assertEqual(code, 1)
        self.assertIn("resolve_markets summary", out)

    def test_an_unexpected_error_still_prints_the_summary(self):
        rm.list_market_states.side_effect = ConnectionError("rpc down")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(ConnectionError):
            rm.main([])
        self.assertIn("resolve_markets summary", out.getvalue())

    def test_market_filter(self):
        code, out, _ = self.main("--market", self.states[1].address.lower())
        self.assertEqual(code, 0)
        self.assertEqual(out.count("CANDIDATE"), 1)
        self.assertIn("Markets listed by factory:      5", out)

    def test_unknown_market_filter_is_refused(self):
        code, _, err = self.main("--market", "0x" + "99" * 20)
        self.assertEqual(code, 1)
        self.assertIn("not listed by MarketFactory", err)


if __name__ == "__main__":
    unittest.main()
