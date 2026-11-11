// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";

import { LivePriceFeed } from "../src/LivePriceFeed.sol";
import { MockUSDT } from "../src/MockUSDT.sol";
import { TexasPowerPerp } from "../src/TexasPowerPerp.sol";

/// Reproductions of what the market simulation (web/sim) found, in the setup of
/// test/TexasPowerPerp.t.sol. Both tests PASS today, which shows the problem.
contract SimFindingsTest is Test {
    bytes32 internal constant FEED = keccak256("ERCOT_HBNORTH_RT_5MIN");
    bytes32 internal constant SOURCE = keccak256("rows");
    uint64 internal constant INTERVAL = 300;
    uint64 internal constant T0 = 1_794_233_100;
    int64 internal constant FLOOR = -5000;
    int64 internal constant CAP = 30_000;
    uint256 internal constant MWH = 1000;

    address internal owner = makeAddr("owner");
    address internal reporter = makeAddr("reporter");
    address internal guardian = makeAddr("guardian");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockUSDT internal usdt;
    LivePriceFeed internal feed;
    TexasPowerPerp internal perp;
    uint64 internal nextEnd = T0;

    function setUp() public {
        vm.warp(T0 + 30);
        usdt = new MockUSDT();
        feed = new LivePriceFeed(owner, reporter, guardian, INTERVAL, -25_100, 500_000);
        perp = new TexasPowerPerp(owner, guardian, IERC20(address(usdt)), feed, FEED, FLOOR, CAP);
        address[3] memory people = [lp, alice, bob];
        for (uint256 i; i < people.length; ++i) {
            usdt.mint(people[i], 10_000_000e6);
            vm.prank(people[i]);
            usdt.approve(address(perp), type(uint256).max);
        }
        vm.prank(lp);
        perp.deposit(1_000_000e6);
    }

    function _publish(int64 priceCents) internal returns (uint64 roundId) {
        if (block.timestamp < nextEnd + 30) vm.warp(nextEnd + 30);
        vm.prank(reporter);
        roundId = feed.submitPrice(FEED, nextEnd, priceCents, SOURCE);
        nextEnd += INTERVAL;
    }

    /// Finding 1: an owner fee increase between request and fill makes the fill panic, and the
    /// order can no longer be cancelled either (its fill round exists).
    function testFeeRaiseBetweenRequestAndFillLocksTheOrder() public {
        _publish(4000);
        _publish(4000);
        _publish(4000);
        vm.prank(alice);
        uint256 orderId = perp.requestOpen(true, 10 * MWH, 4000); // a long at no more than $40.00

        vm.prank(owner);
        perp.setSettings(100, 1, 15 minutes, 15 minutes, 1000 * MWH); // fee 0.10% -> 1.00%
        uint64 fillRound = _publish(4000); // the index there is exactly $40.00

        // escrow = $900 collateral + $3 max fee at 0.10%; the fill wants $900 + $4 at 1.00%
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x01));
        perp.executeOrder(orderId, fillRound);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.OrderCannotBeCancelledYet.selector, orderId)
        );
        perp.cancelOrder(orderId);
        assertTrue(perp.getOrder(orderId).pending, "stuck: neither fills nor cancels");
    }

    /// Finding 2: a withdrawal that waits for free cash is priced, when it finally executes, from
    /// the positions open THEN at its fill round's price, not from the pool at its fill round.
    function testAWaitingWithdrawalIsPricedWithPositionsOpenedAfterIt() public {
        vm.prank(bob);
        perp.deposit(1_000_000e6); // two providers, half the pool each
        vm.prank(owner);
        perp.setSettings(10, 1, 15 minutes, 15 minutes, 100_000 * MWH); // room for big longs
        _publish(4000);
        _publish(4000);
        _publish(4000);

        // alice uses most of the pool with longs at $40
        vm.prank(alice);
        uint256 o1 = perp.requestOpen(true, 5700 * MWH, 4500);
        perp.executeOrder(o1, _publish(4000));
        vm.prank(alice);
        uint256 o2 = perp.requestOpen(true, 1400 * MWH, 4500);
        perp.executeOrder(o2, _publish(4000));

        // bob asks for all his shares; at his fill round ($40) there is not enough free cash
        uint256 shares = perp.balanceOf(bob);
        vm.prank(bob);
        uint256 req = perp.requestWithdraw(shares);
        uint64 fill = _publish(4000);
        vm.expectRevert();
        perp.executePoolRequest(req, fill);

        // the price goes to $150; alice takes profit on the first long, which frees cash
        _publish(15_000);
        _publish(15_000);
        _publish(15_000);
        vm.prank(alice);
        uint256 c1 = perp.requestClose(1);
        perp.executeOrder(c1, _publish(15_000));

        // what bob's half is worth now, with alice's second long up $110/MWh
        uint256 fairNow = shares * (perp.poolValue() + 1) / (perp.totalSupply() + 1e3);
        uint256 before = usdt.balanceOf(bob);
        perp.executePoolRequest(req, fill);
        uint256 paid = usdt.balanceOf(bob) - before;

        // he is paid as if that long had no gain (valued at the $40 of his fill round)
        assertGt(paid, fairNow + 70_000e6, "overpaid against today's pool");
        emit log_named_decimal_uint("paid", paid, 6);
        emit log_named_decimal_uint("fair share now", fairNow, 6);
    }
}
