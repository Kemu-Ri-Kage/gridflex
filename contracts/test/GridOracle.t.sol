// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { GridOracle } from "../src/GridOracle.sol";

contract GridOracleTest is Test {
    bytes32 internal constant METRIC_ID = keccak256("ERCOT_HBNORTH_DA_AVG");
    bytes32 internal constant SECOND_METRIC_ID = keccak256("ERCOT_WEST_NORTH_DA_BASIS");
    bytes32 internal constant SOURCE_HASH = keccak256("source files");
    uint64 internal constant DISPUTE_WINDOW = 6 hours;
    uint32 internal constant DAY_KEY = 20_260_908;
    uint64 internal constant MARKET_DAY_START_UTC = 1_788_843_600;
    uint64 internal constant MARKET_DAY_END_UTC = 1_788_930_000;

    address internal reporter = makeAddr("reporter");
    address internal stranger = makeAddr("stranger");
    GridOracle internal oracle;

    event ReadingSubmitted(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, bytes32 sourceHash
    );
    event ReadingFinalized(bytes32 indexed metricId, uint32 indexed dayKey);

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new GridOracle(reporter, DISPUTE_WINDOW);
    }

    function testConstructorRejectsZeroReporter() public {
        vm.expectRevert(GridOracle.ZeroReporter.selector);
        new GridOracle(address(0), DISPUTE_WINDOW);
    }

    function testOnlyReporterCanSubmit() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GridOracle.UnauthorizedReporter.selector, stranger));
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 2_824, SOURCE_HASH
        );
    }

    function testRejectsInvalidInputs() public {
        vm.startPrank(reporter);

        vm.expectRevert(GridOracle.InvalidMetricId.selector);
        oracle.submitReading(
            bytes32(0), DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH
        );

        vm.expectRevert(GridOracle.InvalidDayKey.selector);
        oracle.submitReading(METRIC_ID, 0, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, SOURCE_HASH);

        vm.expectRevert(GridOracle.InvalidSourceHash.selector);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 1, bytes32(0)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracle.InvalidMarketDay.selector, MARKET_DAY_START_UTC, MARKET_DAY_START_UTC
            )
        );
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_START_UTC, 1, SOURCE_HASH
        );

        vm.stopPrank();
    }

    function testStoresSignedReadingAndEmitsFrozenEvent() public {
        int256 negativeBasis = -1_032;

        vm.expectEmit(true, true, false, true, address(oracle));
        emit ReadingSubmitted(METRIC_ID, DAY_KEY, negativeBasis, SOURCE_HASH);

        vm.prank(reporter);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, negativeBasis, SOURCE_HASH
        );

        GridOracle.Reading memory reading = oracle.getReading(METRIC_ID, DAY_KEY);
        assertEq(reading.metricId, METRIC_ID);
        assertEq(reading.dayKey, DAY_KEY);
        assertEq(reading.marketDayStartUtc, MARKET_DAY_START_UTC);
        assertEq(reading.marketDayEndUtc, MARKET_DAY_END_UTC);
        assertEq(reading.value, negativeBasis);
        assertEq(reading.sourceHash, SOURCE_HASH);
        assertEq(reading.publishedAt, block.timestamp);
        assertFalse(reading.finalized);
        assertFalse(oracle.isFinal(METRIC_ID, DAY_KEY));
    }

    function testReporterCanCorrectBeforeFinalizationAndWindowRestarts() public {
        _submit(METRIC_ID, DAY_KEY, 2_824);

        vm.warp(block.timestamp + 1 hours);
        uint64 correctedAt = uint64(block.timestamp);
        bytes32 correctedHash = keccak256("corrected source files");
        vm.prank(reporter);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 3_100, correctedHash
        );

        GridOracle.Reading memory reading = oracle.getReading(METRIC_ID, DAY_KEY);
        assertEq(reading.value, 3_100);
        assertEq(reading.sourceHash, correctedHash);
        assertEq(reading.publishedAt, correctedAt);

        vm.warp(uint256(correctedAt) + DISPUTE_WINDOW - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                GridOracle.DisputeWindowOpen.selector, uint256(correctedAt) + DISPUTE_WINDOW
            )
        );
        oracle.finalize(METRIC_ID, DAY_KEY);
    }

    function testAnyoneCanFinalizeAfterWindowAndReadingBecomesImmutable() public {
        _submit(METRIC_ID, DAY_KEY, 2_824);
        vm.warp(block.timestamp + DISPUTE_WINDOW);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit ReadingFinalized(METRIC_ID, DAY_KEY);
        vm.prank(stranger);
        oracle.finalize(METRIC_ID, DAY_KEY);

        assertTrue(oracle.isFinal(METRIC_ID, DAY_KEY));

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(GridOracle.ReadingAlreadyFinalized.selector, METRIC_ID, DAY_KEY)
        );
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, 3_100, SOURCE_HASH
        );
    }

    function testCannotFinalizeMissingOrAlreadyFinalizedReading() public {
        vm.expectRevert(
            abi.encodeWithSelector(GridOracle.ReadingNotFound.selector, METRIC_ID, DAY_KEY)
        );
        oracle.finalize(METRIC_ID, DAY_KEY);

        _submit(METRIC_ID, DAY_KEY, 2_824);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(METRIC_ID, DAY_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(GridOracle.ReadingAlreadyFinalized.selector, METRIC_ID, DAY_KEY)
        );
        oracle.finalize(METRIC_ID, DAY_KEY);
    }

    function testCompositeKeyKeepsMetricsAndDaysIndependent() public {
        _submit(METRIC_ID, DAY_KEY, 10);
        _submit(SECOND_METRIC_ID, DAY_KEY, -20);
        _submit(METRIC_ID, DAY_KEY + 1, 30);

        assertEq(oracle.getReading(METRIC_ID, DAY_KEY).value, 10);
        assertEq(oracle.getReading(SECOND_METRIC_ID, DAY_KEY).value, -20);
        assertEq(oracle.getReading(METRIC_ID, DAY_KEY + 1).value, 30);
    }

    function _submit(bytes32 metricId, uint32 dayKey, int256 value) internal {
        vm.prank(reporter);
        oracle.submitReading(
            metricId, dayKey, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, value, SOURCE_HASH
        );
    }
}
