// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { BinaryMarket } from "../src/BinaryMarket.sol";
import { GridOracle } from "../src/GridOracle.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

contract MarketFactoryTest is Test {
    bytes32 internal constant METRIC_ID = keccak256("ERCOT_HBNORTH_DA_AVG");
    uint32 internal constant DAY_KEY = 20_260_908;
    uint64 internal constant START_TIME = 1_800_000_000;
    uint64 internal constant RESOLVE_AFTER = START_TIME + 1 days;
    uint64 internal constant DISPUTE_WINDOW = 1 hours;
    int256 internal constant THRESHOLD = 3_000;
    uint256 internal constant INITIAL_LIQUIDITY = 10_000e6;

    address internal reporter;
    address internal creator;
    GridOracle internal oracle;
    MockUSDT internal collateral;
    MarketFactory internal factory;

    function setUp() public {
        vm.warp(START_TIME);
        reporter = makeAddr("reporter");
        creator = makeAddr("creator");
        oracle = new GridOracle(reporter, 1 hours);
        collateral = new MockUSDT();
        factory = new MarketFactory();

        collateral.mint(creator, 30_000e6);
        vm.prank(creator);
        collateral.approve(address(factory), type(uint256).max);
    }

    function testCreatesSeedsAndRegistersMarketAtomically() public {
        vm.prank(creator);
        address marketAddress = _create(DAY_KEY, THRESHOLD, RESOLVE_AFTER);

        BinaryMarket market = BinaryMarket(marketAddress);
        assertEq(factory.marketCount(), 1);
        assertEq(factory.marketAt(0), marketAddress);
        assertEq(factory.getMarkets()[0], marketAddress);
        assertEq(market.factory(), address(factory));
        assertEq(market.dayKey(), DAY_KEY);
        assertEq(market.disputeWindow(), DISPUTE_WINDOW);
        assertEq(market.liquidityProvider(), creator);
        assertEq(market.yesReserve(), INITIAL_LIQUIDITY);
        assertEq(market.noReserve(), INITIAL_LIQUIDITY);
        assertEq(collateral.balanceOf(marketAddress), INITIAL_LIQUIDITY);
        assertEq(collateral.balanceOf(address(factory)), 0);
        assertEq(collateral.allowance(address(factory), marketAddress), 0);
    }

    function testRejectsZeroInitialLiquidity() public {
        vm.prank(creator);
        vm.expectRevert(MarketFactory.ZeroInitialLiquidity.selector);
        factory.createMarket(
            address(oracle),
            METRIC_ID,
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            RESOLVE_AFTER,
            DISPUTE_WINDOW,
            0
        );
    }

    function testInvalidMarketTermsRollbackRegistry() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.InvalidResolveTime.selector, START_TIME)
        );
        factory.createMarket(
            address(oracle),
            METRIC_ID,
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            START_TIME,
            DISPUTE_WINDOW,
            INITIAL_LIQUIDITY
        );

        assertEq(factory.marketCount(), 0);
    }

    function testCreatesMultipleMarketsInOrder() public {
        vm.startPrank(creator);
        address first = _create(DAY_KEY, THRESHOLD, RESOLVE_AFTER);
        address second = _create(DAY_KEY + 1, THRESHOLD + 100, RESOLVE_AFTER + 1 days);
        vm.stopPrank();

        assertEq(factory.marketCount(), 2);
        assertEq(factory.marketAt(0), first);
        assertEq(factory.marketAt(1), second);
    }

    function _create(uint32 dayKey, int256 threshold, uint64 resolveAfter)
        internal
        returns (address)
    {
        return factory.createMarket(
            address(oracle),
            METRIC_ID,
            dayKey,
            threshold,
            address(collateral),
            resolveAfter,
            DISPUTE_WINDOW,
            INITIAL_LIQUIDITY
        );
    }
}
