// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { LivePriceFeed } from "../src/LivePriceFeed.sol";
import { TexasPowerOptions } from "../src/TexasPowerOptions.sol";
import { TexasPowerPerp } from "../src/TexasPowerPerp.sol";
import { IGridOracle } from "../src/interfaces/IGridOracle.sol";

/// @notice Deploys the futures and options markets to X Layer testnet in one run
///         (GRIDFLEX Trading Platform Plan): LivePriceFeed, then TexasPowerPerp on it, then
///         TexasPowerOptions on an existing GridOracle. Every contract is owned from the start
///         by OWNER_ADDRESS, a key that never goes online; the deployer only pays gas.
///         Settings are the plan's: 5-minute rounds within ERCOT's limits, a -$50 to $300 band,
///         $5 strikes. Seeding the pools comes after: TexasPowerPerp.deposit while no position is
///         open, and TexasPowerOptions.fundPool from the owner.
contract DeployDerivatives is Script {
    uint256 public constant XLAYER_TESTNET_CHAIN_ID = 1952;
    bytes32 public constant LIVE_FEED_ID = keccak256("ERCOT_HBNORTH_RT_5MIN");
    uint64 public constant INTERVAL = 300;
    int64 public constant FEED_MIN_CENTS = -25_100; // ERCOT's floor, -$251/MWh
    int64 public constant FEED_MAX_CENTS = 500_000; // ERCOT's cap, $5,000/MWh
    int64 public constant BAND_FLOOR_CENTS = -5000;
    int64 public constant BAND_CAP_CENTS = 30_000;
    int64 public constant STRIKE_STEP_CENTS = 500;

    error WrongChain(uint256 actualChainId);
    error SameKeyTwice(string roles);

    struct Config {
        address deployer;
        address owner;
        address guardian;
        address reporter;
        address quoter;
        IERC20 collateral;
        IGridOracle oracle;
        string metric;
    }

    /// @notice Reads the deployment from the environment and deploys.
    function run()
        external
        returns (LivePriceFeed feed, TexasPowerPerp perp, TexasPowerOptions options)
    {
        return deploy(configFromEnv());
    }

    function configFromEnv() public view returns (Config memory c) {
        c.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        c.owner = vm.envAddress("OWNER_ADDRESS");
        c.guardian = vm.envAddress("GUARDIAN_ADDRESS");
        c.reporter = vm.envAddress("REPORTER_ADDRESS");
        c.quoter = vm.envAddress("QUOTER_ADDRESS");
        c.collateral = IERC20(vm.envAddress("COLLATERAL_ADDRESS"));
        c.oracle = IGridOracle(vm.envAddress("ORACLE_ADDRESS"));
        // ERCOT_HBNORTH_DA_AVG until the oracle publishes a real-time daily average; with
        // the day-ahead metric the quote bot must keep OPTIONS_CLOSE=dayAheadAuction
        c.metric = vm.envOr("OPTIONS_METRIC", string("ERCOT_HBNORTH_DA_AVG"));
    }

    function deploy(Config memory c)
        public
        returns (LivePriceFeed feed, TexasPowerPerp perp, TexasPowerOptions options)
    {
        if (block.chainid != XLAYER_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        // the online bot keys must each be their own: one leaked key, one role to replace
        if (c.reporter == c.quoter) revert SameKeyTwice("reporter and quoter");
        if (c.owner == c.deployer) revert SameKeyTwice("owner and deployer");

        // The matching signer is supplied by Forge (for example via --account).
        vm.startBroadcast(c.deployer);
        feed = new LivePriceFeed(
            c.owner, c.reporter, c.guardian, INTERVAL, FEED_MIN_CENTS, FEED_MAX_CENTS
        );
        perp = new TexasPowerPerp(
            c.owner, c.guardian, c.collateral, feed, LIVE_FEED_ID, BAND_FLOOR_CENTS, BAND_CAP_CENTS
        );
        options = new TexasPowerOptions(
            c.owner,
            c.quoter,
            c.guardian,
            c.collateral,
            c.oracle,
            keccak256(bytes(c.metric)),
            BAND_FLOOR_CENTS,
            BAND_CAP_CENTS,
            STRIKE_STEP_CENTS
        );
        vm.stopBroadcast();

        console2.log("LivePriceFeed:", address(feed));
        console2.log("TexasPowerPerp:", address(perp));
        console2.log("TexasPowerOptions:", address(options));
        console2.log("Options settle on:", c.metric);
    }
}
