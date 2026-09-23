import contextlib
import io
import unittest
from unittest.mock import MagicMock, patch

import claim_liquidity
from publish import EXPECTED_CHAIN_ID

PROVIDER = "0x27Aad02480f1DC01ebCb53fd7321a4629BCbe902"
OTHER = "0xD95Bd9f3E641974515B53adE252AD43e7cB28059"
ADDRESSES = {
    "chainId": EXPECTED_CHAIN_ID,
    "oracle": "0x0000000000000000000000000000000000000001",
    "factory": "0x0000000000000000000000000000000000000002",
    "collateral": "0x0000000000000000000000000000000000000003",
}


def pool(resolved=False, cancelled=False, yes_won=False, claimed=False,
         yes_reserve=10_000_000_000, no_reserve=10_000_000_000, provider=PROVIDER):
    return claim_liquidity.PoolState(
        address="0x1b89e1dC5e5449b230fa7BF60A08972C05FAB8c1", day_key=20260908, threshold=3000,
        provider=provider, resolved=resolved, cancelled=cancelled, yes_won=yes_won,
        liquidity_redeemed=claimed, yes_reserve=yes_reserve, no_reserve=no_reserve,
    )


class TestPayoutRule(unittest.TestCase):
    def test_open_market_pays_nothing(self):
        self.assertEqual(pool().status, claim_liquidity.STATUS_OPEN)
        self.assertEqual(pool().payout, 0)

    def test_resolved_yes_pays_the_yes_reserve(self):
        p = pool(resolved=True, yes_won=True, yes_reserve=9_091_000_000, no_reserve=11_000_000_000)
        self.assertEqual(p.status, claim_liquidity.STATUS_CLAIMABLE)
        self.assertEqual(p.payout, 9_091_000_000)

    def test_resolved_no_pays_the_no_reserve(self):
        p = pool(resolved=True, yes_won=False, yes_reserve=9_091_000_000, no_reserve=11_000_000_000)
        self.assertEqual(p.payout, 11_000_000_000)

    def test_cancelled_pays_half_of_each_reserve_rounded_down(self):
        p = pool(cancelled=True, yes_reserve=3, no_reserve=4)
        self.assertEqual(p.payout, 3)

    def test_already_claimed_pays_nothing_again(self):
        p = pool(resolved=True, yes_won=True, claimed=True)
        self.assertEqual(p.status, claim_liquidity.STATUS_CLAIMED)
        self.assertEqual(p.payout, 0)


class TestClaimableFor(unittest.TestCase):
    def test_only_the_signers_own_settled_pools_are_sent(self):
        pools = [
            pool(resolved=True, yes_won=True),
            pool(resolved=True, yes_won=True, provider=OTHER),
            pool(),
            pool(resolved=True, claimed=True),
        ]
        mine = claim_liquidity.claimable_for(pools, PROVIDER.lower())
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0].provider, PROVIDER)


class TestDryRun(unittest.TestCase):
    def test_dry_run_lists_pools_and_loads_no_key(self):
        w3 = MagicMock()
        w3.eth.chain_id = EXPECTED_CHAIN_ID
        pools = [pool(resolved=True, yes_won=True), pool()]
        out = io.StringIO()
        with patch.object(claim_liquidity, "load_addresses", return_value=ADDRESSES), \
             patch.object(claim_liquidity, "make_web3", return_value=w3), \
             patch.object(claim_liquidity, "list_pools", return_value=pools), \
             patch.object(claim_liquidity, "load_finalizer_account") as load_key, \
             contextlib.redirect_stdout(out):
            code = claim_liquidity.main([])
        self.assertEqual(code, 0)
        load_key.assert_not_called()
        text = out.getvalue()
        self.assertIn("1 claimable", text)
        self.assertIn("10,000.000000 mUSDT in total", text)
        self.assertIn("DRY RUN ONLY", text)

    def test_wrong_chain_sends_nothing(self):
        w3 = MagicMock()
        w3.eth.chain_id = 196
        err = io.StringIO()
        with patch.object(claim_liquidity, "load_addresses", return_value=ADDRESSES), \
             patch.object(claim_liquidity, "make_web3", return_value=w3), \
             patch.object(claim_liquidity, "list_pools") as listed, \
             contextlib.redirect_stderr(err):
            code = claim_liquidity.main(["--live"])
        self.assertEqual(code, 1)
        listed.assert_not_called()
        self.assertIn("196", err.getvalue())


if __name__ == "__main__":
    unittest.main()
