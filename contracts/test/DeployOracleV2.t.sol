// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { DeployOracleV2 } from "../script/DeployOracleV2.s.sol";
import { GridOracleV2 } from "../src/GridOracleV2.sol";

contract DeployOracleV2Test is Test {
    address internal deployer;
    address internal owner;
    address internal reporter;
    address internal guardian;
    DeployOracleV2 internal deployment;

    function setUp() public {
        deployer = makeAddr("deployer");
        owner = makeAddr("owner");
        reporter = makeAddr("reporter");
        guardian = makeAddr("guardian");
        deployment = new DeployOracleV2();
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(deployer));
        vm.setEnv("OWNER_ADDRESS", vm.toString(owner));
        vm.setEnv("REPORTER_ADDRESS", vm.toString(reporter));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));
        vm.setEnv("ORACLE_DISPUTE_WINDOW", "3600");
    }

    function testDeploysWithSeparateRolesOnXLayerTestnet() public {
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());

        GridOracleV2 oracle = deployment.run();

        assertEq(oracle.owner(), owner);
        assertEq(oracle.reporter(), reporter);
        assertEq(oracle.guardian(), guardian);
        assertEq(oracle.disputeWindow(), 1 hours);
        assertFalse(oracle.paused());
    }

    function testRefusesTheReporterAsOwner() public {
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());
        vm.setEnv("OWNER_ADDRESS", vm.toString(reporter));
        vm.expectRevert(GridOracleV2.ReporterIsOwner.selector);
        deployment.run();
    }

    function testRejectsAnyOtherChain() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(DeployOracleV2.WrongChain.selector, 196));
        deployment.run();
    }
}
