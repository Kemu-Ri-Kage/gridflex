import contextlib
import io
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

from eth_account import Account
from hexbytes import HexBytes
from web3 import Web3

import fund_demo_wallet
from publish import EXPECTED_CHAIN_ID, PublisherError

# A throwaway key used only to sign in these tests; never funded anywhere.
TEST_KEY = "0x" + "11" * 32
SIGNER = Account.from_key(TEST_KEY)
FRESH = Web3.to_checksum_address("0x00000000000000000000000000000000000000aa")
DEPLOYER = "0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902"
ADDRESSES = {
    "chainId": EXPECTED_CHAIN_ID,
    "oracle": "0x0000000000000000000000000000000000000001",
    "factory": "0x0000000000000000000000000000000000000002",
    "collateral": "0x0000000000000000000000000000000000000003",
}
ADDRESSES_FILE = {
    "chainId": EXPECTED_CHAIN_ID,
    "deployer": DEPLOYER,
    "MockUSDT": "0x0000000000000000000000000000000000000003",
    "markets": [{"market": "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", "dayKey": 20260908}],
}


def make_w3(chain_id=EXPECTED_CHAIN_ID, code=b"", nonce=0, musdt=0, status=1):
    w3 = MagicMock()
    w3.eth.chain_id = chain_id
    w3.eth.gas_price = 20_000_001
    w3.eth.get_code.return_value = HexBytes(code)
    w3.eth.get_transaction_count.return_value = nonce
    w3.eth.get_balance.return_value = 10**17
    w3.eth.contract.return_value.functions.balanceOf.return_value.call.return_value = musdt
    w3.eth.send_raw_transaction.return_value = HexBytes("0x" + "ab" * 32)
    w3.eth.wait_for_transaction_receipt.return_value = MagicMock(status=status)
    return w3


class TestParseOkb(unittest.TestCase):
    def test_default_is_a_hundredth_of_an_okb(self):
        self.assertEqual(fund_demo_wallet.parse_okb("0.01"), 10**16)

    def test_refuses_zero_negative_and_non_numbers(self):
        for text in ("0", "-1", "abc", "NaN", "inf"):
            with self.assertRaises(PublisherError, msg=text):
                fund_demo_wallet.parse_okb(text)

    def test_refuses_more_than_the_cap(self):
        with self.assertRaisesRegex(PublisherError, "cap"):
            fund_demo_wallet.parse_okb("0.06")
        self.assertEqual(fund_demo_wallet.parse_okb("0.05"), 5 * 10**16)


class TestDemoGasBudget(unittest.TestCase):
    def test_budget_lists_the_thirteen_transactions_the_script_sends(self):
        self.assertEqual(len(fund_demo_wallet.DEMO_TRANSACTIONS), 13)

    def test_the_default_amount_covers_the_demo_many_times_at_todays_gas_price(self):
        # 20000001 wei is the X Layer testnet gas price read on 2026-09-23.
        cost = fund_demo_wallet.demo_gas_total() * 20_000_001
        self.assertLess(Decimal(cost) / 10**18, Decimal("0.0001"))
        self.assertGreater(fund_demo_wallet.parse_okb("0.01") // cost, 100)


class TestCheckRecipient(unittest.TestCase):
    def setUp(self):
        self.known = fund_demo_wallet.known_addresses(ADDRESSES_FILE)

    def test_known_addresses_walks_nested_markets(self):
        self.assertIn("0x1b89e1dc5e5449b230fa7bf60a08972c05fab8c1", self.known)
        self.assertIn(DEPLOYER.lower(), self.known)

    def test_fresh_wallet_passes_and_is_checksummed(self):
        self.assertEqual(
            fund_demo_wallet.check_recipient(make_w3(), FRESH.lower(), self.known), FRESH
        )

    def test_refuses_the_deployer_and_any_recorded_address(self):
        for address in (DEPLOYER, "0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1"):
            with self.assertRaisesRegex(PublisherError, "not a fresh demo wallet"):
                fund_demo_wallet.check_recipient(make_w3(), address, self.known)

    def test_refuses_a_contract(self):
        with self.assertRaisesRegex(PublisherError, "is a contract"):
            fund_demo_wallet.check_recipient(make_w3(code=b"\x60\x80"), FRESH, self.known)

    def test_refuses_the_zero_address_and_non_addresses(self):
        with self.assertRaisesRegex(PublisherError, "zero address"):
            fund_demo_wallet.check_recipient(make_w3(), "0x" + "0" * 40, self.known)
        with self.assertRaisesRegex(PublisherError, "not an address"):
            fund_demo_wallet.check_recipient(make_w3(), "0x1234", self.known)


class TestMain(unittest.TestCase):
    def run_main(self, argv, w3, typed="yes", signer=SIGNER):
        with tempfile.TemporaryDirectory() as logs, \
                patch.object(fund_demo_wallet, "load_addresses", return_value=ADDRESSES), \
                patch.object(fund_demo_wallet, "load_json", return_value=ADDRESSES_FILE), \
                patch.object(fund_demo_wallet, "load_abi", return_value=[]), \
                patch.object(fund_demo_wallet, "make_web3", return_value=w3), \
                patch.object(fund_demo_wallet, "LOGS_DIR", Path(logs)), \
                patch.object(
                    fund_demo_wallet, "load_finalizer_account", return_value=signer
                ) as load_key, \
                patch("builtins.input", return_value=typed) as prompt:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = fund_demo_wallet.main(argv)
            log_text = "".join(p.read_text() for p in Path(logs).glob("*.log"))
        return code, out.getvalue(), err.getvalue(), load_key, prompt, log_text

    def test_dry_run_loads_no_key_prompts_nothing_and_sends_nothing(self):
        w3 = make_w3()
        code, out, _, load_key, prompt, _ = self.run_main(["--to", FRESH], w3)
        self.assertEqual(code, 0)
        load_key.assert_not_called()
        prompt.assert_not_called()
        w3.eth.send_raw_transaction.assert_not_called()
        self.assertIn("Fresh:             yes", out)
        self.assertIn("DRY RUN ONLY", out)

    def test_dry_run_says_when_the_recipient_is_not_fresh(self):
        _, out, _, _, _, _ = self.run_main(["--to", FRESH], make_w3(nonce=3))
        self.assertIn("Fresh:             NO", out)

    def test_wrong_chain_is_refused_before_the_recipient_is_read(self):
        w3 = make_w3(chain_id=196)
        code, _, err, load_key, _, _ = self.run_main(["--to", FRESH, "--live"], w3)
        self.assertEqual(code, 1)
        self.assertIn("expected X Layer testnet 1952", err)
        w3.eth.get_code.assert_not_called()
        load_key.assert_not_called()
        w3.eth.send_raw_transaction.assert_not_called()

    def test_live_without_a_typed_yes_sends_nothing(self):
        w3 = make_w3()
        code, out, _, _, _, _ = self.run_main(["--to", FRESH, "--live"], w3, typed="y")
        self.assertEqual(code, 0)
        self.assertIn("Cancelled", out)
        w3.eth.send_raw_transaction.assert_not_called()

    def test_live_sends_one_transfer_on_chain_1952_and_never_prints_the_key(self):
        w3 = make_w3()
        signer = MagicMock(wraps=SIGNER)
        signer.address = SIGNER.address
        code, out, err, _, _, log_text = self.run_main(
            ["--to", FRESH, "--okb", "0.02", "--live"], w3, signer=signer
        )
        self.assertEqual(code, 0, err)
        tx = signer.sign_transaction.call_args.args[0]
        self.assertEqual(
            (tx["chainId"], tx["to"], tx["value"]), (EXPECTED_CHAIN_ID, FRESH, 2 * 10**16)
        )
        w3.eth.send_raw_transaction.assert_called_once()
        raw = w3.eth.send_raw_transaction.call_args.args[0]
        sent = Account.recover_transaction(raw)
        self.assertEqual(sent, SIGNER.address)
        self.assertIn("SENT 0.020000 OKB", out)
        self.assertIn("CONFIRMED", log_text)
        for text in (out, err, log_text):
            self.assertNotIn(TEST_KEY[2:], text)

    def test_live_refuses_when_the_sender_cannot_cover_it(self):
        w3 = make_w3()
        w3.eth.get_balance.return_value = 10**15  # 0.001 OKB
        code, _, err, _, prompt, _ = self.run_main(["--to", FRESH, "--live"], w3)
        self.assertEqual(code, 1)
        self.assertIn("sending needs", err)
        prompt.assert_not_called()
        w3.eth.send_raw_transaction.assert_not_called()

    def test_a_reverted_transfer_is_an_error(self):
        code, _, err, _, _, log_text = self.run_main(
            ["--to", FRESH, "--live"], make_w3(status=0)
        )
        self.assertEqual(code, 1)
        self.assertIn("reverted", err)
        self.assertIn("REVERTED", log_text)


if __name__ == "__main__":
    unittest.main()
