// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Test } from "forge-std/Test.sol";

import { BinaryMarket } from "../src/BinaryMarket.sol";
import { GridOracleV2 } from "../src/GridOracleV2.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

contract GridOracleV2Test is Test {
    bytes32 internal constant METRIC_ID = keccak256("ERCOT_HBNORTH_DA_AVG");
    bytes32 internal constant SOURCE_HASH = keccak256("source files");
    uint64 internal constant DISPUTE_WINDOW = 1 hours;
    uint32 internal constant DAY_KEY = 20_260_908;
    uint64 internal constant MARKET_DAY_START_UTC = 1_788_843_600;
    uint64 internal constant MARKET_DAY_END_UTC = 1_788_930_000;

    address internal owner = makeAddr("owner");
    address internal reporter = makeAddr("reporter");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    GridOracleV2 internal oracle;

    event ReadingSubmitted(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, bytes32 sourceHash
    );
    event ReadingFinalized(bytes32 indexed metricId, uint32 indexed dayKey);
    event ReadingVoided(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, address indexed by
    );
    event ReporterChanged(address indexed previousReporter, address indexed newReporter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new GridOracleV2(owner, reporter, guardian, DISPUTE_WINDOW);
    }

    // ------------------------------------------------------------ roles at deploy

    function testConstructorSetsRoles() public view {
        assertEq(oracle.owner(), owner);
        assertEq(oracle.reporter(), reporter);
        assertEq(oracle.guardian(), guardian);
        assertEq(oracle.disputeWindow(), DISPUTE_WINDOW);
        assertFalse(oracle.paused());
    }

    function testConstructorRejectsMissingOrMergedRoles() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new GridOracleV2(address(0), reporter, guardian, DISPUTE_WINDOW);

        vm.expectRevert(GridOracleV2.ZeroReporter.selector);
        new GridOracleV2(owner, address(0), guardian, DISPUTE_WINDOW);

        vm.expectRevert(GridOracleV2.ZeroGuardian.selector);
        new GridOracleV2(owner, reporter, address(0), DISPUTE_WINDOW);

        vm.expectRevert(GridOracleV2.ReporterIsOwner.selector);
        new GridOracleV2(owner, owner, guardian, DISPUTE_WINDOW);

        vm.expectRevert(GridOracleV2.ReporterIsGuardian.selector);
        new GridOracleV2(owner, reporter, reporter, DISPUTE_WINDOW);
    }

    function testGuardianMayBeTheOwner() public {
        GridOracleV2 solo = new GridOracleV2(owner, reporter, owner, DISPUTE_WINDOW);
        assertEq(solo.guardian(), owner);
    }

    // ------------------------------------------------------------ v1 behaviour

    function testOnlyReporterCanSubmit() public {
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.UnauthorizedReporter.selector, stranger)
        );
        _submitAs(stranger, 2_824);

        vm.expectRevert(abi.encodeWithSelector(GridOracleV2.UnauthorizedReporter.selector, owner));
        _submitAs(owner, 2_824);
    }

    function testRejectsInvalidInputs() public {
        vm.startPrank(reporter);

        vm.expectRevert(GridOracleV2.InvalidMetricId.selector);
        oracle.submitReading(
            bytes32(0), DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH
        );

        vm.expectRevert(GridOracleV2.InvalidDayKey.selector);
        oracle.submitReading(METRIC_ID, 0, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH);

        vm.expectRevert(GridOracleV2.InvalidSourceHash.selector);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, bytes32(0)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracleV2.InvalidMarketDay.selector, MARKET_DAY_END_UTC, MARKET_DAY_END_UTC
            )
        );
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_END_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH
        );

        vm.stopPrank();
    }

    function testSubmitStoresReadingAndEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(oracle));
        emit ReadingSubmitted(METRIC_ID, DAY_KEY, -125, SOURCE_HASH);
        _submit(-125);

        GridOracleV2.Reading memory reading = oracle.getReading(METRIC_ID, DAY_KEY);
        assertEq(reading.metricId, METRIC_ID);
        assertEq(reading.dayKey, DAY_KEY);
        assertEq(reading.marketDayStartUtc, MARKET_DAY_START_UTC);
        assertEq(reading.marketDayEndUtc, MARKET_DAY_END_UTC);
        assertEq(reading.value, -125);
        assertEq(reading.sourceHash, SOURCE_HASH);
        assertEq(reading.publishedAt, block.timestamp);
        assertFalse(reading.finalized);
        assertFalse(oracle.isFinal(METRIC_ID, DAY_KEY));
    }

    function testCorrectionRestartsDisputeWindow() public {
        _submit(2_800);
        vm.warp(block.timestamp + DISPUTE_WINDOW - 1);
        _submit(2_824);

        vm.warp(block.timestamp + DISPUTE_WINDOW - 1);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.DisputeWindowOpen.selector, block.timestamp + 1)
        );
        oracle.finalize(METRIC_ID, DAY_KEY);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, false, address(oracle));
        emit ReadingFinalized(METRIC_ID, DAY_KEY);
        oracle.finalize(METRIC_ID, DAY_KEY);

        assertTrue(oracle.isFinal(METRIC_ID, DAY_KEY));
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).value, 2_824);
    }

    function testFinalizedReadingIsImmutable() public {
        _submitAndFinalize(2_824);

        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracleV2.ReadingAlreadyFinalized.selector, METRIC_ID, DAY_KEY
            )
        );
        _submitAs(reporter, 9_999);

        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracleV2.ReadingAlreadyFinalized.selector, METRIC_ID, DAY_KEY
            )
        );
        oracle.finalize(METRIC_ID, DAY_KEY);
    }

    function testFinalizeMissingReadingReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.ReadingNotFound.selector, METRIC_ID, DAY_KEY)
        );
        oracle.finalize(METRIC_ID, DAY_KEY);
    }

    // ------------------------------------------------------------ no reading before the day ends

    function testRefusesReadingBeforeMarketDayEnds() public {
        vm.warp(MARKET_DAY_END_UTC - 1);
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.MarketDayNotOver.selector, MARKET_DAY_END_UTC)
        );
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 2_824, SOURCE_HASH
        );

        vm.warp(MARKET_DAY_END_UTC);
        _submit(2_824);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).publishedAt, MARKET_DAY_END_UTC);
    }

    // ------------------------------------------------------------ void

    function testGuardianVoidsUnfinalizedReading() public {
        _submit(99_999);

        vm.prank(guardian);
        vm.expectEmit(true, true, true, true, address(oracle));
        emit ReadingVoided(METRIC_ID, DAY_KEY, 99_999, guardian);
        oracle.voidReading(METRIC_ID, DAY_KEY);

        GridOracleV2.Reading memory reading = oracle.getReading(METRIC_ID, DAY_KEY);
        assertEq(reading.publishedAt, 0);
        assertEq(reading.value, 0);
        assertFalse(oracle.isFinal(METRIC_ID, DAY_KEY));

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.ReadingNotFound.selector, METRIC_ID, DAY_KEY)
        );
        oracle.finalize(METRIC_ID, DAY_KEY);

        // The right value can be published again afterwards.
        _submit(2_824);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).value, 2_824);
    }

    function testOwnerCanVoid() public {
        _submit(99_999);
        vm.prank(owner);
        oracle.voidReading(METRIC_ID, DAY_KEY);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).publishedAt, 0);
    }

    function testOnlyGuardianOrOwnerCanVoid() public {
        _submit(99_999);
        for (uint256 i = 0; i < 2; i++) {
            address caller = i == 0 ? reporter : stranger;
            vm.prank(caller);
            vm.expectRevert(
                abi.encodeWithSelector(GridOracleV2.UnauthorizedGuardian.selector, caller)
            );
            oracle.voidReading(METRIC_ID, DAY_KEY);
        }
    }

    function testCannotVoidMissingOrFinalReading() public {
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.ReadingNotFound.selector, METRIC_ID, DAY_KEY)
        );
        oracle.voidReading(METRIC_ID, DAY_KEY);

        _submitAndFinalize(2_824);
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracleV2.ReadingAlreadyFinalized.selector, METRIC_ID, DAY_KEY
            )
        );
        oracle.voidReading(METRIC_ID, DAY_KEY);
    }

    // ------------------------------------------------------------ pause

    function testPauseStopsSubmitAndFinalizeButNotVoid() public {
        _submit(99_999);

        vm.prank(guardian);
        vm.expectEmit(true, false, false, false, address(oracle));
        emit Paused(guardian);
        oracle.pause();
        assertTrue(oracle.paused());

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(GridOracleV2.OraclePaused.selector);
        oracle.finalize(METRIC_ID, DAY_KEY);

        vm.expectRevert(GridOracleV2.OraclePaused.selector);
        _submitAs(reporter, 2_824);

        vm.prank(guardian);
        oracle.voidReading(METRIC_ID, DAY_KEY);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).publishedAt, 0);
    }

    function testOnlyOwnerUnpauses() public {
        vm.prank(guardian);
        oracle.pause();

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        oracle.unpause();

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(oracle));
        emit Unpaused(owner);
        oracle.unpause();
        assertFalse(oracle.paused());
    }

    function testStrangersCannotPause() public {
        for (uint256 i = 0; i < 2; i++) {
            address caller = i == 0 ? reporter : stranger;
            vm.prank(caller);
            vm.expectRevert(
                abi.encodeWithSelector(GridOracleV2.UnauthorizedGuardian.selector, caller)
            );
            oracle.pause();
        }
    }

    // ------------------------------------------------------------ replacing a leaked key

    function testOwnerReplacesReporter() public {
        address newReporter = makeAddr("newReporter");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(oracle));
        emit ReporterChanged(reporter, newReporter);
        oracle.setReporter(newReporter);
        assertEq(oracle.reporter(), newReporter);

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.UnauthorizedReporter.selector, reporter)
        );
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH
        );

        _submitAs(newReporter, 2_824);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).value, 2_824);
    }

    function testSetReporterRules() public {
        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, reporter)
        );
        oracle.setReporter(stranger);

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        oracle.setReporter(stranger);

        vm.startPrank(owner);
        vm.expectRevert(GridOracleV2.ZeroReporter.selector);
        oracle.setReporter(address(0));
        vm.expectRevert(GridOracleV2.ReporterIsOwner.selector);
        oracle.setReporter(owner);
        vm.expectRevert(GridOracleV2.ReporterIsGuardian.selector);
        oracle.setReporter(guardian);
        vm.stopPrank();
    }

    function testOwnerReplacesGuardian() public {
        address newGuardian = makeAddr("newGuardian");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(oracle));
        emit GuardianChanged(guardian, newGuardian);
        oracle.setGuardian(newGuardian);
        assertEq(oracle.guardian(), newGuardian);

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.UnauthorizedGuardian.selector, guardian)
        );
        oracle.pause();
    }

    function testSetGuardianRules() public {
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        oracle.setGuardian(stranger);

        vm.startPrank(owner);
        vm.expectRevert(GridOracleV2.ZeroGuardian.selector);
        oracle.setGuardian(address(0));
        vm.expectRevert(GridOracleV2.ReporterIsGuardian.selector);
        oracle.setGuardian(reporter);
        vm.stopPrank();
    }

    function testOwnershipIsTwoStepAndNeverGoesToTheReporter() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        vm.expectRevert(GridOracleV2.ReporterIsOwner.selector);
        oracle.transferOwnership(reporter);

        vm.prank(owner);
        oracle.transferOwnership(newOwner);
        assertEq(oracle.owner(), owner);
        assertEq(oracle.pendingOwner(), newOwner);

        vm.prank(newOwner);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), newOwner);
    }

    function testReporterCannotAcceptOwnershipOfferedBeforeItBecameReporter() public {
        address next = makeAddr("next");
        vm.startPrank(owner);
        oracle.transferOwnership(next);
        oracle.setReporter(next);
        vm.stopPrank();

        vm.prank(next);
        vm.expectRevert(GridOracleV2.ReporterIsOwner.selector);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), owner);
    }

    function testOwnershipCannotBeRenounced() public {
        vm.prank(owner);
        vm.expectRevert(GridOracleV2.OwnershipCannotBeRenounced.selector);
        oracle.renounceOwnership();
        assertEq(oracle.owner(), owner);
    }

    // ------------------------------------------------------------ the leaked-key drill

    /// The sequence shared/oracle-v2.md tells the team to follow.
    function testLeakedReporterDrill() public {
        address attacker = reporter;
        address newReporter = makeAddr("newReporter");

        _submitAs(attacker, 99_999);

        vm.prank(guardian);
        oracle.pause();
        vm.prank(guardian);
        oracle.voidReading(METRIC_ID, DAY_KEY);

        vm.startPrank(owner);
        oracle.setReporter(newReporter);
        oracle.unpause();
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(GridOracleV2.UnauthorizedReporter.selector, attacker)
        );
        _submitAs(attacker, 99_999);

        _submitAs(newReporter, 2_824);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(METRIC_ID, DAY_KEY);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).value, 2_824);
        assertTrue(oracle.isFinal(METRIC_ID, DAY_KEY));
    }

    // ------------------------------------------------------------ with BinaryMarket

    function testBinaryMarketResolvesAgainstV2() public {
        (BinaryMarket market,) = _market();
        _submitAndFinalize(3_500);
        vm.warp(block.timestamp + 1 days);
        market.resolve();
        assertTrue(market.resolved());
        assertTrue(market.yesWon());
    }

    function testVoidedReadingLetsMarketCancel() public {
        (BinaryMarket market,) = _market();
        _submit(99_999);
        vm.prank(guardian);
        oracle.voidReading(METRIC_ID, DAY_KEY);

        vm.warp(market.resolveAfter() + market.disputeWindow());
        market.cancel();
        assertTrue(market.cancelled());
    }

    // ------------------------------------------------------------ helpers

    function _market() internal returns (BinaryMarket market, MockUSDT collateral) {
        collateral = new MockUSDT();
        MarketFactory factory = new MarketFactory();
        address creator = makeAddr("creator");
        collateral.mint(creator, 10_000e6);
        vm.startPrank(creator);
        collateral.approve(address(factory), type(uint256).max);
        market = BinaryMarket(
            factory.createMarket(
                address(oracle),
                METRIC_ID,
                DAY_KEY,
                3_000,
                address(collateral),
                uint64(block.timestamp + 1 hours),
                7 days,
                10_000e6
            )
        );
        vm.stopPrank();
    }

    function _submit(int256 value) internal {
        _submitAs(reporter, value);
    }

    function _submitAs(address caller, int256 value) internal {
        vm.prank(caller);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, value, SOURCE_HASH
        );
    }

    function _submitAndFinalize(int256 value) internal {
        _submit(value);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(METRIC_ID, DAY_KEY);
    }
}
