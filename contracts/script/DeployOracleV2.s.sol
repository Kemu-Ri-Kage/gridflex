// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { GridOracleV2 } from "../src/GridOracleV2.sol";

/// @notice Deploys GridOracleV2 to X Layer testnet (shared/oracle-v2.md). The market factory
///         and collateral stay as they are: new markets name this oracle when created.
///
///         OWNER_ADDRESS     a key that never goes online (hardware wallet or Safe); it can
///                           replace the reporter and guardian and is the only one to unpause
///         REPORTER_ADDRESS  the key the settle job publishes with; never the owner's
///         GUARDIAN_ADDRESS  a key a person can reach quickly (a phone wallet) to pause the
///                           oracle and void a bad reading; never the reporter's
///         DEPLOYER_ADDRESS  pays for the deploy; it gets no role
contract DeployOracleV2 is Script {
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;
    uint64 public constant DEFAULT_ORACLE_DISPUTE_WINDOW = 1 hours;

    error WrongChain(uint256 actualChainId);
    error ValueDoesNotFitUint64(uint256 value);

    function run() external returns (GridOracleV2 oracle) {
        if (block.chainid != XLAYER_TESTNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }

        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        address reporter = vm.envAddress("REPORTER_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        uint256 disputeWindowValue =
            vm.envOr("ORACLE_DISPUTE_WINDOW", uint256(DEFAULT_ORACLE_DISPUTE_WINDOW));
        if (disputeWindowValue > type(uint64).max) {
            revert ValueDoesNotFitUint64(disputeWindowValue);
        }

        // The matching signer is supplied by Forge (for example via --account).
        vm.startBroadcast(deployer);
        oracle = new GridOracleV2(owner, reporter, guardian, uint64(disputeWindowValue));
        vm.stopBroadcast();

        console2.log("GridOracleV2:", address(oracle));
        console2.log("Owner:", owner);
        console2.log("Reporter:", reporter);
        console2.log("Guardian:", guardian);
        console2.log("Oracle dispute window:", disputeWindowValue);
    }
}
