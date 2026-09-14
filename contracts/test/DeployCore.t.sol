// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { DeployCore } from "../script/DeployCore.s.sol";
import { GridOracle } from "../src/GridOracle.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

contract DeployCoreTest is Test {
    address internal deployer;
    address internal reporter;
    DeployCore internal deployment;

    function setUp() public {
        deployer = makeAddr("deployer");
        reporter = makeAddr("reporter");
        deployment = new DeployCore();
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(deployer));
        vm.setEnv("REPORTER_ADDRESS", vm.toString(reporter));
        vm.setEnv("ORACLE_DISPUTE_WINDOW", "3600");
    }

    function testDeploysOnlyExpectedCoreContractsOnXLayerTestnet() public {
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());

        (GridOracle oracle, MockUSDT collateral, MarketFactory factory) = deployment.run();

        assertEq(oracle.reporter(), reporter);
        assertEq(oracle.disputeWindow(), 1 hours);
        assertEq(collateral.decimals(), 6);
        assertEq(factory.marketCount(), 0);
    }

    function testRejectsAnyOtherChain() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(DeployCore.WrongChain.selector, 196));
        deployment.run();
    }
}
