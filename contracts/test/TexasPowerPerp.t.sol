// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";

import { LivePriceFeed } from "../src/LivePriceFeed.sol";
import { MockUSDT } from "../src/MockUSDT.sol";
import { TexasPowerPerp } from "../src/TexasPowerPerp.sol";

contract TexasPowerPerpTest is Test {
    bytes32 internal constant FEED = keccak256("ERCOT_HBNORTH_RT_5MIN");
    bytes32 internal constant SOURCE = keccak256("rows");
    uint64 internal constant INTERVAL = 300;
    uint64 internal constant T0 = 1_794_233_100;
    int64 internal constant FLOOR = -5000; // -$50/MWh
    int64 internal constant CAP = 30_000; // $300/MWh
    uint256 internal constant MWH = 1000;
    uint256 internal constant POOL_SEED = 1_000_000e6; // 1,000,000 mUSDT

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
        perp.deposit(POOL_SEED);
    }

    // ------------------------------------------------------------ helpers

    /// Publishes the next five-minute interval, 30 s after it ends.
    function _publish(int64 priceCents) internal returns (uint64 roundId) {
        if (block.timestamp < nextEnd + 30) vm.warp(nextEnd + 30);
        vm.prank(reporter);
        roundId = feed.submitPrice(FEED, nextEnd, priceCents, SOURCE);
        nextEnd += INTERVAL;
    }

    function _seed(int64 priceCents) internal returns (uint64 roundId) {
        _publish(priceCents);
        _publish(priceCents);
        roundId = _publish(priceCents);
    }

    function _open(address who, bool isLong, uint256 size, int64 limit)
        internal
        returns (uint256 orderId)
    {
        vm.prank(who);
        orderId = perp.requestOpen(isLong, size, limit);
    }

    function _close(address who, uint256 positionId) internal returns (uint256 orderId) {
        vm.prank(who);
        orderId = perp.requestClose(positionId);
    }

    function _position(uint256 positionId) internal view returns (TexasPowerPerp.Position memory) {
        return perp.getPosition(positionId);
    }

    function _pending(uint256 orderId) internal view returns (bool) {
        return perp.getOrder(orderId).pending;
    }

    /// The books always balance and the pool can always pay every reserve.
    function _checkBooks() internal view {
        assertEq(
            usdt.balanceOf(address(perp)),
            perp.poolCash() + perp.traderCollateral() + perp.orderEscrow() + perp.depositEscrow(),
            "token balance = pool + traders + order and deposit escrow"
        );
        assertLe(perp.totalReserved(), perp.poolCash(), "reserves covered");
    }

    // ------------------------------------------------------------ pool

    function testFirstDepositMintsSharesAndValueIsCash() public view {
        assertEq(perp.decimals(), 9);
        assertEq(perp.balanceOf(lp), POOL_SEED * 1e3);
        assertEq(perp.poolCash(), POOL_SEED);
        assertEq(perp.poolValue(), POOL_SEED);
        _checkBooks();
    }

    function testSecondDepositGetsProportionalShares() public {
        vm.prank(bob);
        uint256 shares = perp.deposit(500_000e6);
        // 500,000e6 * (1e15 + 1e3) / (1e12 + 1), rounded down
        assertEq(shares, uint256(500_000e6) * (1e15 + 1e3) / (1e12 + 1));
        _checkBooks();
    }

    // ------------------------------------------------------------ opening

    function testLongFillsAtTheNextPrintAndRefundsTheSpareEscrow() public {
        _seed(4400);
        uint256 before = usdt.balanceOf(alice);
        uint256 orderId = _open(alice, true, 10 * MWH, 4500);

        // escrow: 10 MWh x ($45 + $50) + the largest fee (0.10% of 10 MWh at $300)
        assertEq(before - usdt.balanceOf(alice), 950_000_000 + 3_000_000);
        assertEq(perp.totalReserved(), 3_500_000_000); // 10 MWh x $350, the widest move
        assertEq(perp.accountSize(alice), 10 * MWH);

        uint64 fill = _publish(4500); // index (4400 + 4400 + 4500) / 3 = 4433
        perp.executeOrder(orderId, fill);

        TexasPowerPerp.Position memory p = _position(1);
        assertTrue(p.open && p.isLong);
        assertEq(p.account, alice);
        assertEq(p.entryPriceCents, 4433);
        assertEq(p.collateral, 943_300_000); // 10 MWh x ($44.33 + $50)
        assertEq(p.reserve, 2_556_700_000); // 10 MWh x ($300 - $44.33)
        assertEq(before - usdt.balanceOf(alice), 943_300_000 + 443_300); // collateral + fee
        assertEq(perp.poolCash(), POOL_SEED + 443_300);
        assertEq(perp.totalReserved(), 2_556_700_000);
        assertFalse(_pending(orderId));
        _checkBooks();
    }

    function testShortPostsTheMoveUpToTheCap() public {
        _seed(4400);
        uint256 orderId = _open(bob, false, 5 * MWH, 4300);
        perp.executeOrder(orderId, _publish(4500));

        TexasPowerPerp.Position memory p = _position(1);
        assertFalse(p.isLong);
        assertEq(p.entryPriceCents, 4433);
        assertEq(p.collateral, 1_278_350_000); // 5 MWh x ($300 - $44.33)
        assertEq(p.reserve, 471_650_000); // 5 MWh x ($44.33 + $50)
        _checkBooks();
    }

    function testAPriceTheTraderCouldSeeIsNeverTheFillPrice() public {
        _seed(4400);
        // the next interval has ended; the order and its price land in the same block
        vm.warp(nextEnd + 30);
        uint256 orderId = _open(alice, true, 1 * MWH, 9000);
        uint64 sameBlock = _publish(8000);

        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.NotTheFillRound.selector, orderId, sameBlock)
        );
        perp.executeOrder(orderId, sameBlock);

        uint64 fill = _publish(4400);
        uint64 later = _publish(4400);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.NotTheFillRound.selector, orderId, later)
        );
        perp.executeOrder(orderId, later);

        perp.executeOrder(orderId, fill);
        assertEq(_position(1).entryPriceCents, 5600); // (4400 + 8000 + 4400) / 3
        _checkBooks();
    }

    function testOrderBeyondTheLimitCancelsWithAFullRefund() public {
        _seed(4400);
        uint256 before = usdt.balanceOf(alice);
        uint256 orderId = _open(alice, true, 10 * MWH, 4400);
        perp.executeOrder(orderId, _publish(4500)); // 4433 > 4400

        assertEq(usdt.balanceOf(alice), before);
        assertEq(perp.totalReserved(), 0);
        assertEq(perp.accountSize(alice), 0);
        assertEq(perp.nextPositionId(), 1);
        assertFalse(_pending(orderId));
        _checkBooks();
    }

    function testAGapAtTheFillRoundCancelsTheOrder() public {
        _seed(4400);
        uint256 before = usdt.balanceOf(alice);
        uint256 orderId = _open(alice, true, 10 * MWH, 4500);
        nextEnd += INTERVAL; // the bot missed an interval
        perp.executeOrder(orderId, _publish(4400));
        assertEq(usdt.balanceOf(alice), before);
        assertEq(perp.nextPositionId(), 1);
        _checkBooks();
    }

    function testPricesOnABandEdgeOpenNothing() public {
        _seed(40_000); // index above the $300 cap, clamped to it
        uint256 orderId = _open(bob, false, 1 * MWH, 100);
        perp.executeOrder(orderId, _publish(40_000));
        assertEq(perp.nextPositionId(), 1);
        _checkBooks();
    }

    function testRequestsAreChecked() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerPerp.SizeTooSmall.selector, 99));
        perp.requestOpen(true, 99, 4500);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.AcceptablePriceOutsideBand.selector, CAP)
        );
        perp.requestOpen(true, MWH, CAP);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.AcceptablePriceOutsideBand.selector, FLOOR)
        );
        perp.requestOpen(false, MWH, FLOOR);
        vm.stopPrank();
    }

    function testThePoolMustCoverTheWorstCaseUpFront() public {
        TexasPowerPerp small =
            new TexasPowerPerp(owner, guardian, IERC20(address(usdt)), feed, FEED, FLOOR, CAP);
        vm.startPrank(alice);
        usdt.approve(address(small), type(uint256).max);
        small.deposit(100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                TexasPowerPerp.PoolCannotCoverPosition.selector, 3_500_000_000, 100e6
            )
        );
        small.requestOpen(true, 10 * MWH, 4500);
        vm.stopPrank();
    }

    function testTheAccountLimitCountsPendingOrders() public {
        vm.prank(owner);
        perp.setSettings(10, 1, 15 minutes, 15 minutes, 15 * MWH);
        _open(alice, true, 10 * MWH, 4500);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.AccountLimit.selector, 20 * MWH, 15 * MWH)
        );
        _open(alice, true, 10 * MWH, 4500);
    }

    // ------------------------------------------------------------ closing

    function testLongGainIsPaidMinusFeeAndFunding() public {
        _seed(4400);
        uint256 orderId = _open(alice, true, 10 * MWH, 4500);
        perp.executeOrder(orderId, _publish(4500)); // entry 4433 at T0 + 930
        _publish(5200);
        _publish(5200);
        uint256 closeId = _close(alice, 1);
        uint256 before = usdt.balanceOf(alice);
        perp.executeOrder(closeId, _publish(5200)); // exit 5200 at T0 + 1830

        // only longs are open: they pay 1 cent/MWh/hour; 10 MWh for 15 minutes = 2.5 cents
        uint256 funding = 25_000;
        uint256 fee = 520_000; // 0.10% of 10 MWh at $52
        uint256 pnl = 76_700_000; // 10 MWh x ($52 - $44.33)
        assertEq(usdt.balanceOf(alice) - before, 943_300_000 + pnl - funding - fee);
        assertEq(perp.poolCash(), POOL_SEED + 443_300 + funding + fee - pnl);
        assertEq(perp.totalReserved(), 0);
        assertEq(perp.traderCollateral(), 0);
        assertEq(perp.longSize(), 0);
        assertEq(perp.accountSize(alice), 0);
        assertFalse(_position(1).open);
        _checkBooks();
    }

    function testGainsStopAtTheCap() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        TexasPowerPerp.Position memory p = _position(1);
        _seed(90_000); // $900, clamped to $300
        uint256 closeId = _close(alice, 1);
        uint256 before = usdt.balanceOf(alice);
        uint64 fill = _publish(90_000);
        uint256 funding = perp.fundingOwed(1);
        perp.executeOrder(closeId, fill);

        uint256 fee = 3_000_000; // 0.10% of 10 MWh at $300
        assertEq(usdt.balanceOf(alice) - before, p.collateral + p.reserve - funding - fee);
        _checkBooks();
    }

    function testLossesStopAtTheCollateral() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        _seed(-20_000); // -$200, clamped to -$50
        uint256 closeId = _close(alice, 1);
        uint256 before = usdt.balanceOf(alice);
        uint256 poolBefore = perp.poolCash();
        perp.executeOrder(closeId, _publish(-20_000));

        assertEq(usdt.balanceOf(alice), before); // nothing back, nothing more owed
        assertEq(perp.poolCash(), poolBefore + 943_300_000);
        _checkBooks();
    }

    function testShortGainsWhenThePriceFalls() public {
        _seed(4400);
        perp.executeOrder(_open(bob, false, 5 * MWH, 4300), _publish(4500)); // 4433
        _seed(3000);
        uint256 closeId = _close(bob, 1);
        uint256 before = usdt.balanceOf(bob);
        uint64 fill = _publish(3000);
        uint256 funding = perp.fundingOwed(1);
        perp.executeOrder(closeId, fill);

        uint256 pnl = 71_650_000; // 5 MWh x ($44.33 - $30)
        uint256 fee = 150_000; // 0.10% of 5 MWh at $30
        assertEq(usdt.balanceOf(bob) - before, 1_278_350_000 + pnl - funding - fee);
        _checkBooks();
    }

    function testOnlyTheOwnerClosesAndOnlyOnce() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, MWH, 4500), _publish(4500));

        vm.expectRevert(abi.encodeWithSelector(TexasPowerPerp.NotYourPosition.selector, 1));
        _close(bob, 1);

        _close(alice, 1);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerPerp.CloseAlreadyPending.selector, 1));
        _close(alice, 1);
    }

    function testACloseAcrossAGapIsDroppedAndCanBeAskedAgain() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, MWH, 4500), _publish(4500));
        uint256 closeId = _close(alice, 1);
        nextEnd += INTERVAL;
        perp.executeOrder(closeId, _publish(4400));
        assertTrue(_position(1).open);
        assertEq(_position(1).closeOrderId, 0);

        _publish(4400);
        uint256 again = _close(alice, 1);
        perp.executeOrder(again, _publish(4400));
        assertFalse(_position(1).open);
        _checkBooks();
    }

    // ------------------------------------------------------------ cancelling

    function testTradersCannotCancelOnceTheirFillPriceExists() public {
        _seed(4400);
        uint256 orderId = _open(alice, true, MWH, 4500);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.OrderCannotBeCancelledYet.selector, orderId)
        );
        perp.cancelOrder(orderId);

        _publish(9000); // a fill price exists now, good or bad
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.OrderCannotBeCancelledYet.selector, orderId)
        );
        perp.cancelOrder(orderId);
    }

    function testTradersCancelWhenNoPriceArrivesOrTheFeedIsPaused() public {
        _seed(4400);
        uint256 before = usdt.balanceOf(alice);
        uint256 first = _open(alice, true, MWH, 4500);
        uint256 second = _open(alice, true, MWH, 4500);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerPerp.NotYourOrder.selector, first));
        perp.cancelOrder(first);

        vm.warp(block.timestamp + 15 minutes);
        vm.prank(alice);
        perp.cancelOrder(first);

        vm.prank(guardian);
        feed.pause();
        vm.expectRevert(TexasPowerPerp.FeedIsPaused.selector);
        perp.executeOrder(second, 1);
        vm.prank(alice);
        perp.cancelOrder(second);

        assertEq(usdt.balanceOf(alice), before);
        assertEq(perp.totalReserved(), 0);
        _checkBooks();
    }

    // ------------------------------------------------------------ pool value and funding

    function testPoolValueSubtractsWhatTradersAreUp() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        _seed(5200);
        assertEq(perp.poolValue(), perp.poolCash() - 76_700_000);
        _seed(4000);
        assertEq(perp.poolValue(), perp.poolCash() + 43_300_000); // traders down $43.30
    }

    // ------------------------------------------------------------ pool moves at the next print

    /// Alice long 10 MWh at $44.33 (round 4), then the provider's request; the fill round
    /// (round 5) has index (4400 + 4500 + 5200) / 3 = 4700.
    function _openAliceThenRequest(bool deposit, uint256 amount)
        internal
        returns (uint256 requestId)
    {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        vm.prank(deposit ? bob : lp);
        requestId = deposit ? perp.requestDeposit(amount) : perp.requestWithdraw(amount);
    }

    function testInstantPoolMovesOnlyWhileNoPositionIsOpen() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, MWH, 4500), _publish(4500));
        vm.prank(bob);
        vm.expectRevert(TexasPowerPerp.PositionsOpenUseRequest.selector);
        perp.deposit(1e6);
        vm.prank(lp);
        vm.expectRevert(TexasPowerPerp.PositionsOpenUseRequest.selector);
        perp.withdraw(1e9);
    }

    function testAWithdrawalFillsAtTheNextRoundsPoolValue() public {
        uint256 shares = perp.balanceOf(lp) / 10;
        uint256 requestId = _openAliceThenRequest(false, shares);
        assertEq(perp.balanceOf(address(perp)), shares); // held until the fill
        uint256 cash = perp.poolCash();
        uint256 supply = perp.totalSupply();
        uint256 before = usdt.balanceOf(lp);

        perp.executePoolRequest(requestId, _publish(5200));
        // traders are up 10 MWh x ($47.00 - $44.33) at the fill round
        uint256 value = cash - 26_700_000;
        uint256 expected = shares * (value + 1) / (supply + 1e3);
        assertEq(usdt.balanceOf(lp) - before, expected);
        assertEq(perp.balanceOf(address(perp)), 0);
        assertEq(perp.totalSupply(), supply - shares);
        _checkBooks();
    }

    function testADepositFillsAtTheNextRoundsPoolValue() public {
        uint256 requestId = _openAliceThenRequest(true, 100_000e6);
        assertEq(perp.depositEscrow(), 100_000e6);
        uint256 cash = perp.poolCash();
        uint256 supply = perp.totalSupply();

        perp.executePoolRequest(requestId, _publish(5200));
        uint256 value = cash - 26_700_000;
        assertEq(perp.balanceOf(bob), uint256(100_000e6) * (supply + 1e3) / (value + 1));
        assertEq(perp.depositEscrow(), 0);
        assertEq(perp.poolCash(), cash + 100_000e6);
        _checkBooks();
    }

    function testProvidersCannotBackOutOnceTheFillRoundExists() public {
        uint256 requestId = _openAliceThenRequest(false, 1e12);
        _publish(9000);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.OrderCannotBeCancelledYet.selector, requestId)
        );
        perp.cancelPoolRequest(requestId);
    }

    function testABigWithdrawalWaitsForFreeCashAtTheSamePrice() public {
        uint256 all = perp.balanceOf(lp);
        uint256 requestId = _openAliceThenRequest(false, all);
        uint64 fill = _publish(5200);
        vm.expectRevert(); // FreeLiquidityTooLow: alice's reserve is locked
        perp.executePoolRequest(requestId, fill);
        assertTrue(perp.getPoolRequest(requestId).pending);

        uint256 closeId = _close(alice, 1);
        perp.executeOrder(closeId, _publish(5200)); // alice leaves, freeing the reserve
        perp.executePoolRequest(requestId, fill); // the same fill round, the same terms
        assertFalse(perp.getPoolRequest(requestId).pending);
        assertEq(perp.totalSupply(), 0);
        assertLt(perp.poolCash(), 1e6); // only the rounding left by the virtual shares
        _checkBooks();
    }

    function testPoolRequestsCanBeTakenBackWhileTheFeedIsPaused() public {
        uint256 shares = perp.balanceOf(lp) / 4;
        uint256 withdrawal = _openAliceThenRequest(false, shares);
        vm.prank(bob);
        uint256 deposit = perp.requestDeposit(1000e6);
        uint256 bobBefore = usdt.balanceOf(bob);

        vm.prank(guardian);
        feed.pause();
        vm.prank(lp);
        perp.cancelPoolRequest(withdrawal);
        vm.prank(bob);
        perp.cancelPoolRequest(deposit);

        assertEq(perp.balanceOf(address(perp)), 0);
        assertEq(perp.balanceOf(lp), POOL_SEED * 1e3);
        assertEq(usdt.balanceOf(bob) - bobBefore, 1000e6);
        _checkBooks();
    }

    // ------------------------------------------------------------ feed outage

    function testAnyoneClosesPositionsAfterThreeSilentDays() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        _seed(5200); // latest index $52.00, interval ending T0 + 1800
        uint64 lastEnd = T0 + 1800;

        vm.warp(lastEnd + 3 days - 1);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerPerp.FeedNotSilent.selector, uint256(lastEnd) + 3 days)
        );
        perp.emergencyClose(1);

        vm.warp(lastEnd + 3 days);
        uint256 funding = perp.fundingOwed(1);
        uint256 before = usdt.balanceOf(alice);
        vm.prank(bob);
        perp.emergencyClose(1);
        // at the last index: 10 MWh x ($52 - $44.33), minus funding and the close fee
        assertEq(usdt.balanceOf(alice) - before, 943_300_000 + 76_700_000 - funding - 520_000);
        assertFalse(_position(1).open);
        _checkBooks();
    }

    function testAPausedFeedClosesFlatAtTheEntryPrice() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        _seed(9000); // possibly a bad print, so the guardian pauses
        vm.prank(guardian);
        feed.pause();
        vm.warp(T0 + 1800 + 3 days);
        uint256 funding = perp.fundingOwed(1);
        uint256 before = usdt.balanceOf(alice);
        perp.emergencyClose(1);
        assertEq(usdt.balanceOf(alice) - before, 943_300_000 - funding - 443_300);
        _checkBooks();
    }

    function testAnEmergencyCloseClearsAPendingCloseAndFreesThePool() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, 10 * MWH, 4500), _publish(4500));
        uint256 closeId = _close(alice, 1);
        vm.warp(T0 + 900 + 3 days); // nothing published since the fill
        perp.emergencyClose(1);
        assertFalse(perp.getOrder(closeId).pending);
        assertEq(perp.totalReserved(), 0);

        uint256 shares = perp.balanceOf(lp);
        vm.prank(lp);
        perp.withdraw(shares); // nothing open: instant again
        assertEq(perp.totalSupply(), 0);
        _checkBooks();
    }

    function testTheBiggerSidePaysFundingToThePool() public {
        _seed(4400);
        uint256 longOrder = _open(alice, true, 10 * MWH, 4500);
        uint256 shortOrder = _open(bob, false, 5 * MWH, 4300);
        uint64 fill = _publish(4500);
        perp.executeOrder(longOrder, fill);
        perp.executeOrder(shortOrder, fill);

        assertEq(perp.fundingRate(), int256(1e18) / 3); // 5 of 15 MWh imbalance
        vm.warp(block.timestamp + 1 hours);
        // 10 MWh x 1 cent x 1/3 for an hour = 3.33 cents
        assertEq(perp.fundingOwed(1), 33_333);
        assertEq(perp.fundingOwed(2), 0);
    }

    // ------------------------------------------------------------ pause and settings

    function testPauseStopsOpeningButNotClosing() public {
        _seed(4400);
        perp.executeOrder(_open(alice, true, MWH, 4500), _publish(4500));
        uint256 pendingOpen = _open(bob, true, MWH, 4600);

        vm.prank(guardian);
        perp.pause();
        vm.expectRevert(TexasPowerPerp.MarketPaused.selector);
        _open(alice, true, MWH, 4500);

        uint256 closeId = _close(alice, 1);
        uint64 fill = _publish(4500);
        perp.executeOrder(pendingOpen, fill); // cancelled: market paused
        perp.executeOrder(closeId, fill);
        assertFalse(_position(1).open);
        assertEq(perp.nextPositionId(), 2);

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        perp.unpause();
        vm.prank(owner);
        perp.unpause();
        _checkBooks();
    }

    function testSettingsAreBoundedAndOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        perp.setSettings(10, 1, 15 minutes, 15 minutes, 100 * MWH);

        vm.startPrank(owner);
        vm.expectRevert(TexasPowerPerp.InvalidSetting.selector);
        perp.setSettings(101, 1, 15 minutes, 15 minutes, 100 * MWH);
        vm.expectRevert(TexasPowerPerp.InvalidSetting.selector);
        perp.setSettings(10, 101, 15 minutes, 15 minutes, 100 * MWH);
        vm.expectRevert(TexasPowerPerp.InvalidSetting.selector);
        perp.setSettings(10, 1, 30, 15 minutes, 100 * MWH);
        vm.expectRevert(TexasPowerPerp.OwnershipCannotBeRenounced.selector);
        perp.renounceOwnership();
        perp.setSettings(20, 2, 10 minutes, 10 minutes, 50 * MWH);
        vm.stopPrank();
        assertEq(perp.feeBps(), 20);
        assertEq(perp.maxAccountSize(), 50 * MWH);
    }

    function testConstructorChecks() public {
        vm.expectRevert(abi.encodeWithSelector(TexasPowerPerp.InvalidBand.selector, CAP, FLOOR));
        new TexasPowerPerp(owner, guardian, IERC20(address(usdt)), feed, FEED, CAP, FLOOR);
        vm.expectRevert(TexasPowerPerp.ZeroAddress.selector);
        new TexasPowerPerp(owner, address(0), IERC20(address(usdt)), feed, FEED, FLOOR, CAP);
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the prices, size and side: the payout stays within the pot, nobody is
    /// owed more than was set aside, and the books balance.
    function testFuzzEveryCloseIsCovered(
        int64 entry,
        int64 exit,
        uint256 size,
        bool isLong,
        uint256 holdMinutes
    ) public {
        entry = int64(bound(entry, FLOOR + 1, CAP - 1));
        exit = int64(bound(exit, -25_100, 500_000));
        size = bound(size, 100, 50 * MWH);
        holdMinutes = bound(holdMinutes, 0, 7 days / 60);

        _seed(entry);
        uint256 orderId = _open(alice, isLong, size, isLong ? CAP - 1 : FLOOR + 1);
        perp.executeOrder(orderId, _publish(entry));
        TexasPowerPerp.Position memory p = _position(1);
        assertEq(p.entryPriceCents, entry);

        vm.warp(block.timestamp + holdMinutes * 60);
        uint64 aligned = uint64(block.timestamp / INTERVAL) * INTERVAL;
        if (aligned >= nextEnd) nextEnd = aligned;
        _seed(exit);
        uint256 before = usdt.balanceOf(alice);
        perp.executeOrder(_close(alice, 1), _publish(exit));
        uint256 payout = usdt.balanceOf(alice) - before;

        assertLe(payout, p.collateral + p.reserve);
        assertEq(perp.totalReserved(), 0);
        assertEq(perp.traderCollateral(), 0);
        assertEq(perp.poolCash(), usdt.balanceOf(address(perp)));
        _checkBooks();
    }
}
