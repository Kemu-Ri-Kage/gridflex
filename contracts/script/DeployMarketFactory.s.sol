// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { MarketFactory } from "../src/MarketFactory.sol";

/// @notice Deploys only the current GRIDFLEX MarketFactory to X Layer testnet.
contract DeployMarketFactory is Script {
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;

    error WrongChain(uint256 actualChainId);

    function run() external returns (MarketFactory factory) {
        if (block.chainid != XLAYER_TESTNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }

        address deployer = vm.envAddress("DEPLOYER_ADDRESS");

        vm.startBroadcast(deployer);
        factory = new MarketFactory();
        vm.stopBroadcast();

        console2.log("MarketFactory:", address(factory));
    }
}
