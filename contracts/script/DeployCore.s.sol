// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { GridOracle } from "../src/GridOracle.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

/// @notice Deploys the three shared GRIDFLEX contracts to X Layer testnet.
contract DeployCore is Script {
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;
    uint64 public constant DEFAULT_ORACLE_DISPUTE_WINDOW = 1 hours;

    error WrongChain(uint256 actualChainId);
    error ValueDoesNotFitUint64(uint256 value);

    function run()
        external
        returns (GridOracle oracle, MockUSDT collateral, MarketFactory factory)
    {
        if (block.chainid != XLAYER_TESTNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }

        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address reporter = vm.envOr("REPORTER_ADDRESS", deployer);
        if (reporter == address(0)) reporter = deployer;
        uint256 oracleDisputeWindowValue =
            vm.envOr("ORACLE_DISPUTE_WINDOW", uint256(DEFAULT_ORACLE_DISPUTE_WINDOW));
        if (oracleDisputeWindowValue > type(uint64).max) {
            revert ValueDoesNotFitUint64(oracleDisputeWindowValue);
        }
        uint64 oracleDisputeWindow = uint64(oracleDisputeWindowValue);

        // The matching signer is supplied by Forge (for example via --account).
        // Keeping the private key in an encrypted keystore avoids plaintext secrets in .env.
        vm.startBroadcast(deployer);
        oracle = new GridOracle(reporter, oracleDisputeWindow);
        collateral = new MockUSDT();
        factory = new MarketFactory();
        vm.stopBroadcast();

        console2.log("GridOracle:", address(oracle));
        console2.log("MockUSDT:", address(collateral));
        console2.log("MarketFactory:", address(factory));
        console2.log("Reporter:", reporter);
        console2.log("Oracle dispute window:", oracleDisputeWindow);
    }
}
