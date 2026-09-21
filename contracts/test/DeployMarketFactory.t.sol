// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { DeployMarketFactory } from "../script/DeployMarketFactory.s.sol";
import { MarketFactory } from "../src/MarketFactory.sol";

contract DeployMarketFactoryTest is Test {
    DeployMarketFactory internal deployment;

    function setUp() public {
        deployment = new DeployMarketFactory();
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(makeAddr("deployer")));
    }

    function testDeploysEmptyFactoryOnXLayerTestnet() public {
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());

        MarketFactory factory = deployment.run();

        assertEq(factory.marketCount(), 0);
    }

    function testRejectsAnyOtherChain() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(DeployMarketFactory.WrongChain.selector, 196));
        deployment.run();
    }
}
