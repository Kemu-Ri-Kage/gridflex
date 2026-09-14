// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { CreateDemoMarket } from "../script/CreateDemoMarket.s.sol";
import { BinaryMarket } from "../src/BinaryMarket.sol";
import { GridOracle } from "../src/GridOracle.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

contract CreateDemoMarketTest is Test {
    // Keep the shared script environment deterministic when Forge runs suites in parallel.
    string internal constant METRIC_NAME = "ERCOT_HBNORTH_DA_AVG";
    uint32 internal constant DAY_KEY = 20_260_908;
    uint64 internal constant START_TIME = 1_800_000_000;
    uint64 internal constant RESOLVE_AFTER = START_TIME + 1 days;
    int256 internal constant THRESHOLD = 4_500;
    uint64 internal constant MARKET_DISPUTE_WINDOW = 0;
    uint256 internal constant INITIAL_LIQUIDITY = 10_000e6;

    CreateDemoMarket internal deployment;
    GridOracle internal oracle;
    MockUSDT internal collateral;
    MarketFactory internal factory;

    function setUp() public {
        vm.chainId(1952);
        vm.warp(START_TIME);

        address deployer = makeAddr("deployer");
        oracle = new GridOracle(deployer, 1 hours);
        collateral = new MockUSDT();
        factory = new MarketFactory();
        deployment = new CreateDemoMarket();

        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(deployer));
        vm.setEnv("GRID_ORACLE_ADDRESS", vm.toString(address(oracle)));
        vm.setEnv("MARKET_FACTORY_ADDRESS", vm.toString(address(factory)));
        vm.setEnv("MOCK_USDT_ADDRESS", vm.toString(address(collateral)));
        vm.setEnv("MARKET_METRIC_ID", METRIC_NAME);
        vm.setEnv("MARKET_DAY_KEY", vm.toString(DAY_KEY));
        vm.setEnv("MARKET_THRESHOLD", vm.toString(THRESHOLD));
        vm.setEnv("MARKET_RESOLVE_AFTER", vm.toString(RESOLVE_AFTER));
        vm.setEnv("MARKET_DISPUTE_WINDOW", vm.toString(MARKET_DISPUTE_WINDOW));
        vm.setEnv("INITIAL_LIQUIDITY", vm.toString(INITIAL_LIQUIDITY));
    }

    function testCreatesAndSeedsConfiguredMarket() public {
        BinaryMarket market = deployment.run();

        assertEq(factory.marketCount(), 1);
        assertEq(factory.marketAt(0), address(market));
        assertEq(address(market.oracle()), address(oracle));
        assertEq(market.metricId(), keccak256(bytes(METRIC_NAME)));
        assertEq(market.dayKey(), DAY_KEY);
        assertEq(market.threshold(), THRESHOLD);
        assertEq(market.resolveAfter(), RESOLVE_AFTER);
        assertEq(market.disputeWindow(), MARKET_DISPUTE_WINDOW);
        assertEq(market.liquidityProvider(), vm.envAddress("DEPLOYER_ADDRESS"));
        assertEq(market.yesReserve(), INITIAL_LIQUIDITY);
        assertEq(market.noReserve(), INITIAL_LIQUIDITY);
        assertEq(collateral.balanceOf(address(market)), INITIAL_LIQUIDITY);
    }

    function testRejectsWrongChainBeforeReadingConfiguration() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(CreateDemoMarket.WrongChain.selector, 196));
        deployment.run();
    }
}
