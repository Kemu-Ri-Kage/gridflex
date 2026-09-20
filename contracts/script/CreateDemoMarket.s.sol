// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { BinaryMarket } from "../src/BinaryMarket.sol";
import { MarketFactory } from "../src/MarketFactory.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

/// @notice Mints demo collateral and creates one seeded GRIDFLEX market on X Layer testnet.
contract CreateDemoMarket is Script {
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;
    uint256 public constant DEFAULT_INITIAL_LIQUIDITY = 10_000e6;
    uint64 public constant DEFAULT_MARKET_DISPUTE_WINDOW = 1 hours;

    error WrongChain(uint256 actualChainId);
    error ValueDoesNotFitUint32(uint256 value);
    error ValueDoesNotFitUint64(uint256 value);

    struct MarketConfig {
        MarketFactory factory;
        MockUSDT collateral;
        address oracle;
        bytes32 metricId;
        uint32 dayKey;
        int256 threshold;
        uint64 resolveAfter;
        uint64 disputeWindow;
        uint256 initialLiquidity;
    }

    function run() external returns (BinaryMarket market) {
        if (block.chainid != XLAYER_TESTNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }

        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        MarketConfig memory config = _loadConfig();

        // The matching signer is supplied by Forge (for example via --account).
        vm.startBroadcast(deployer);
        config.collateral.mint(deployer, config.initialLiquidity);
        config.collateral.approve(address(config.factory), config.initialLiquidity);
        address marketAddress = config.factory
            .createMarket(
                config.oracle,
                config.metricId,
                config.dayKey,
                config.threshold,
                address(config.collateral),
                config.resolveAfter,
                config.disputeWindow,
                config.initialLiquidity
            );
        vm.stopBroadcast();

        market = BinaryMarket(marketAddress);
        console2.log("BinaryMarket:", marketAddress);
        console2.log("YES token:", address(market.yesToken()));
        console2.log("NO token:", address(market.noToken()));
        console2.logBytes32(config.metricId);
    }

    function _loadConfig() internal view returns (MarketConfig memory config) {
        string memory metricName = vm.envString("MARKET_METRIC_ID");
        uint256 dayKeyValue = vm.envUint("MARKET_DAY_KEY");
        uint256 resolveAfterValue = vm.envUint("MARKET_RESOLVE_AFTER");
        uint256 disputeWindowValue =
            vm.envOr("MARKET_DISPUTE_WINDOW", uint256(DEFAULT_MARKET_DISPUTE_WINDOW));

        if (dayKeyValue > type(uint32).max) {
            revert ValueDoesNotFitUint32(dayKeyValue);
        }
        if (resolveAfterValue > type(uint64).max) {
            revert ValueDoesNotFitUint64(resolveAfterValue);
        }
        if (disputeWindowValue > type(uint64).max) {
            revert ValueDoesNotFitUint64(disputeWindowValue);
        }

        config = MarketConfig({
            factory: MarketFactory(vm.envAddress("MARKET_FACTORY_ADDRESS")),
            collateral: MockUSDT(vm.envAddress("MOCK_USDT_ADDRESS")),
            oracle: vm.envAddress("GRID_ORACLE_ADDRESS"),
            metricId: keccak256(bytes(metricName)),
            dayKey: uint32(dayKeyValue),
            threshold: vm.envInt("MARKET_THRESHOLD"),
            resolveAfter: uint64(resolveAfterValue),
            disputeWindow: uint64(disputeWindowValue),
            initialLiquidity: vm.envOr("INITIAL_LIQUIDITY", DEFAULT_INITIAL_LIQUIDITY)
        });
    }
}
