// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Test } from "forge-std/Test.sol";

import { LivePriceFeed } from "../src/LivePriceFeed.sol";

contract LivePriceFeedTest is Test {
    bytes32 internal constant FEED = keccak256("ERCOT_HBNORTH_RT_5MIN");
    bytes32 internal constant SOURCE = keccak256("gridstatus + ercot rows");
    uint64 internal constant INTERVAL = 300;
    int64 internal constant MIN_PRICE = -25_100; // ERCOT floor, -$251/MWh
    int64 internal constant MAX_PRICE = 500_000; // ERCOT cap, $5,000/MWh
    // 9 Nov 2026 14:05 UTC, a five-minute boundary
    uint64 internal constant T0 = 1_794_233_100;

    address internal owner = makeAddr("owner");
    address internal reporter = makeAddr("reporter");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    LivePriceFeed internal feed;

    event PriceSubmitted(
        bytes32 indexed feedId,
        uint64 indexed roundId,
        uint64 intervalEnd,
        int64 priceCents,
        bytes32 sourceHash
    );
    event ReporterChanged(address indexed previousReporter, address indexed newReporter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    function setUp() public {
        assertEq(T0 % INTERVAL, 0);
        vm.warp(T0 + 60);
        feed = new LivePriceFeed(owner, reporter, guardian, INTERVAL, MIN_PRICE, MAX_PRICE);
    }

    function _submit(uint64 intervalEnd, int64 price) internal returns (uint64) {
        if (block.timestamp < intervalEnd) vm.warp(intervalEnd + 30);
        vm.prank(reporter);
        return feed.submitPrice(FEED, intervalEnd, price, SOURCE);
    }

    // ------------------------------------------------------------ deploy

    function testConstructorSetsRolesAndLimits() public view {
        assertEq(feed.owner(), owner);
        assertEq(feed.reporter(), reporter);
        assertEq(feed.guardian(), guardian);
        assertEq(feed.interval(), INTERVAL);
        assertEq(feed.minPriceCents(), MIN_PRICE);
        assertEq(feed.maxPriceCents(), MAX_PRICE);
        assertFalse(feed.paused());
        assertEq(feed.latestRoundId(FEED), 0);
    }

    function testConstructorRejectsBadRolesAndLimits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LivePriceFeed(address(0), reporter, guardian, INTERVAL, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(LivePriceFeed.ZeroReporter.selector);
        new LivePriceFeed(owner, address(0), guardian, INTERVAL, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(LivePriceFeed.ZeroGuardian.selector);
        new LivePriceFeed(owner, reporter, address(0), INTERVAL, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(LivePriceFeed.ReporterIsOwner.selector);
        new LivePriceFeed(owner, owner, guardian, INTERVAL, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(LivePriceFeed.ReporterIsGuardian.selector);
        new LivePriceFeed(owner, reporter, reporter, INTERVAL, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(LivePriceFeed.InvalidInterval.selector);
        new LivePriceFeed(owner, reporter, guardian, 0, MIN_PRICE, MAX_PRICE);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.InvalidPriceBounds.selector, int64(10), int64(10))
        );
        new LivePriceFeed(owner, reporter, guardian, INTERVAL, 10, 10);
    }

    // ------------------------------------------------------------ publishing

    function testReporterPublishesRounds() public {
        vm.expectEmit(true, true, false, true);
        emit PriceSubmitted(FEED, 1, T0, 4423, SOURCE);
        vm.prank(reporter);
        uint64 roundId = feed.submitPrice(FEED, T0, 4423, SOURCE);

        assertEq(roundId, 1);
        assertEq(feed.latestRoundId(FEED), 1);
        LivePriceFeed.Round memory round = feed.getRound(FEED, 1);
        assertEq(round.priceCents, 4423);
        assertEq(round.intervalEnd, T0);
        assertEq(round.publishedAt, T0 + 60);
        assertEq(round.sourceHash, SOURCE);

        assertEq(_submit(T0 + INTERVAL, 4510), 2);
    }

    function testOnlyReporterPublishes() public {
        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.UnauthorizedReporter.selector, stranger)
        );
        vm.prank(stranger);
        feed.submitPrice(FEED, T0, 4423, SOURCE);

        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.UnauthorizedReporter.selector, owner));
        vm.prank(owner);
        feed.submitPrice(FEED, T0, 4423, SOURCE);
    }

    function testRejectsMalformedRounds() public {
        vm.startPrank(reporter);

        vm.expectRevert(LivePriceFeed.InvalidFeedId.selector);
        feed.submitPrice(bytes32(0), T0, 4423, SOURCE);

        vm.expectRevert(LivePriceFeed.InvalidSourceHash.selector);
        feed.submitPrice(FEED, T0, 4423, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.IntervalNotAligned.selector, T0 + 1));
        feed.submitPrice(FEED, T0 + 1, 4423, SOURCE);

        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.IntervalNotAligned.selector, 0));
        feed.submitPrice(FEED, 0, 4423, SOURCE);

        // the interval that ends at T0 + 300 is still running at T0 + 60
        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.IntervalNotOver.selector, T0 + INTERVAL)
        );
        feed.submitPrice(FEED, T0 + INTERVAL, 4423, SOURCE);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.PriceOutOfBounds.selector, MAX_PRICE + 1)
        );
        feed.submitPrice(FEED, T0, MAX_PRICE + 1, SOURCE);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.PriceOutOfBounds.selector, MIN_PRICE - 1)
        );
        feed.submitPrice(FEED, T0, MIN_PRICE - 1, SOURCE);

        vm.stopPrank();
    }

    function testAcceptsTheBoundsThemselvesAndNegativePrices() public {
        _submit(T0, MIN_PRICE);
        _submit(T0 + INTERVAL, MAX_PRICE);
        _submit(T0 + 2 * INTERVAL, -720);
        assertEq(feed.getRound(FEED, 3).priceCents, -720);
    }

    function testIntervalsOnlyMoveForward() public {
        _submit(T0 + INTERVAL, 4423);

        vm.startPrank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(
                LivePriceFeed.IntervalNotAfterLatest.selector, T0 + INTERVAL, T0 + INTERVAL
            )
        );
        feed.submitPrice(FEED, T0 + INTERVAL, 9999, SOURCE);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.IntervalNotAfterLatest.selector, T0, T0 + INTERVAL)
        );
        feed.submitPrice(FEED, T0, 4423, SOURCE);
        vm.stopPrank();

        // a different feed has its own history
        vm.prank(reporter);
        assertEq(feed.submitPrice(keccak256("ERCOT_HBWEST_RT_5MIN"), T0, 3000, SOURCE), 1);
    }

    function testGetRoundRevertsForMissingRounds() public {
        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.RoundNotFound.selector, FEED, 1));
        feed.getRound(FEED, 1);
    }

    // ------------------------------------------------------------ index

    function testIndexIsTheAverageOfThreeConsecutiveRounds() public {
        _submit(T0, 4400);
        _submit(T0 + INTERVAL, 4500);
        _submit(T0 + 2 * INTERVAL, 4700);
        assertEq(feed.indexAt(FEED, 3), 4533); // 13,600 / 3, rounded toward zero

        _submit(T0 + 3 * INTERVAL, 9000);
        assertEq(feed.indexAt(FEED, 4), 6066); // (4500 + 4700 + 9000) / 3
    }

    function testIndexRoundsTowardZeroForNegativePrices() public {
        _submit(T0, -100);
        _submit(T0 + INTERVAL, -100);
        _submit(T0 + 2 * INTERVAL, -101);
        assertEq(feed.indexAt(FEED, 3), -100); // -301 / 3 = -100.33
    }

    function testNoIndexBeforeThreeRounds() public {
        _submit(T0, 4400);
        _submit(T0 + INTERVAL, 4500);
        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.IndexGap.selector, FEED, 2));
        feed.indexAt(FEED, 2);

        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.RoundNotFound.selector, FEED, 0));
        feed.indexAt(FEED, 0);
    }

    function testAMissedIntervalMeansNoIndexUntilThreeConsecutiveRounds() public {
        _submit(T0, 4400);
        _submit(T0 + INTERVAL, 4500);
        // T0 + 600 is never published
        _submit(T0 + 3 * INTERVAL, 4600);
        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.IndexGap.selector, FEED, 3));
        feed.indexAt(FEED, 3);

        _submit(T0 + 4 * INTERVAL, 4700);
        vm.expectRevert(abi.encodeWithSelector(LivePriceFeed.IndexGap.selector, FEED, 4));
        feed.indexAt(FEED, 4);

        _submit(T0 + 5 * INTERVAL, 4800);
        assertEq(feed.indexAt(FEED, 5), 4700);
    }

    function testLatestIndexServesFreshPricesOnly() public {
        _submit(T0, 4400);
        _submit(T0 + INTERVAL, 4500);
        _submit(T0 + 2 * INTERVAL, 4600);

        (int64 indexCents, uint64 roundId, uint64 intervalEnd) = feed.latestIndex(FEED, 900);
        assertEq(indexCents, 4500);
        assertEq(roundId, 3);
        assertEq(intervalEnd, T0 + 2 * INTERVAL);

        vm.warp(T0 + 2 * INTERVAL + 901);
        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.StalePrice.selector, T0 + 2 * INTERVAL, 900)
        );
        feed.latestIndex(FEED, 900);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.RoundNotFound.selector, keccak256("x"), 0)
        );
        feed.latestIndex(keccak256("x"), 900);
    }

    // ------------------------------------------------------------ pause and keys

    function testGuardianPausesAndOnlyOwnerUnpauses() public {
        _submit(T0, 4400);
        _submit(T0 + INTERVAL, 4500);
        _submit(T0 + 2 * INTERVAL, 4600);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.UnauthorizedGuardian.selector, stranger)
        );
        vm.prank(stranger);
        feed.pause();

        vm.expectEmit(true, false, false, false);
        emit Paused(guardian);
        vm.prank(guardian);
        feed.pause();
        assertTrue(feed.paused());

        vm.expectRevert(LivePriceFeed.FeedPaused.selector);
        feed.latestIndex(FEED, 900);

        vm.warp(T0 + 3 * INTERVAL + 30);
        vm.expectRevert(LivePriceFeed.FeedPaused.selector);
        vm.prank(reporter);
        feed.submitPrice(FEED, T0 + 3 * INTERVAL, 4700, SOURCE);

        // history stays readable for settlement
        assertEq(feed.indexAt(FEED, 3), 4500);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        vm.prank(guardian);
        feed.unpause();

        vm.expectEmit(true, false, false, false);
        emit Unpaused(owner);
        vm.prank(owner);
        feed.unpause();
        assertFalse(feed.paused());
    }

    function testOwnerReplacesALeakedReporter() public {
        address newReporter = makeAddr("newReporter");

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        vm.prank(guardian);
        feed.setReporter(newReporter);

        vm.expectEmit(true, true, false, false);
        emit ReporterChanged(reporter, newReporter);
        vm.prank(owner);
        feed.setReporter(newReporter);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.UnauthorizedReporter.selector, reporter)
        );
        vm.prank(reporter);
        feed.submitPrice(FEED, T0, 4423, SOURCE);

        vm.prank(newReporter);
        feed.submitPrice(FEED, T0, 4423, SOURCE);

        vm.startPrank(owner);
        vm.expectRevert(LivePriceFeed.ZeroReporter.selector);
        feed.setReporter(address(0));
        vm.expectRevert(LivePriceFeed.ReporterIsOwner.selector);
        feed.setReporter(owner);
        vm.expectRevert(LivePriceFeed.ReporterIsGuardian.selector);
        feed.setReporter(guardian);
        vm.stopPrank();
    }

    function testOwnerReplacesTheGuardian() public {
        address newGuardian = makeAddr("newGuardian");
        vm.expectEmit(true, true, false, false);
        emit GuardianChanged(guardian, newGuardian);
        vm.prank(owner);
        feed.setGuardian(newGuardian);
        assertEq(feed.guardian(), newGuardian);

        vm.expectRevert(
            abi.encodeWithSelector(LivePriceFeed.UnauthorizedGuardian.selector, guardian)
        );
        vm.prank(guardian);
        feed.pause();

        vm.prank(owner);
        vm.expectRevert(LivePriceFeed.ReporterIsGuardian.selector);
        feed.setGuardian(reporter);
    }

    function testOwnershipNeverReachesTheReporterAndCannotBeRenounced() public {
        vm.startPrank(owner);
        vm.expectRevert(LivePriceFeed.ReporterIsOwner.selector);
        feed.transferOwnership(reporter);

        vm.expectRevert(LivePriceFeed.OwnershipCannotBeRenounced.selector);
        feed.renounceOwnership();

        address newOwner = makeAddr("newOwner");
        feed.transferOwnership(newOwner);
        vm.stopPrank();
        vm.prank(newOwner);
        feed.acceptOwnership();
        assertEq(feed.owner(), newOwner);
    }

    function testFuzzIndexMatchesTheAverage(int64 a, int64 b, int64 c) public {
        a = int64(bound(a, MIN_PRICE, MAX_PRICE));
        b = int64(bound(b, MIN_PRICE, MAX_PRICE));
        c = int64(bound(c, MIN_PRICE, MAX_PRICE));
        _submit(T0, a);
        _submit(T0 + INTERVAL, b);
        _submit(T0 + 2 * INTERVAL, c);
        assertEq(feed.indexAt(FEED, 3), int64((int256(a) + b + c) / 3));
    }
}
