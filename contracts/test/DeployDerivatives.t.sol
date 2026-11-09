// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { DeployDerivatives } from "../script/DeployDerivatives.s.sol";
import { GridOracle } from "../src/GridOracle.sol";
import { LivePriceFeed } from "../src/LivePriceFeed.sol";
import { MockUSDT } from "../src/MockUSDT.sol";
import { TexasPowerOptions } from "../src/TexasPowerOptions.sol";
import { TexasPowerPerp } from "../src/TexasPowerPerp.sol";

contract DeployDerivativesTest is Test {
    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal reporter = makeAddr("reporter");
    address internal quoter = makeAddr("quoter");
    MockUSDT internal usdt;
    GridOracle internal oracle;
    DeployDerivatives internal deployment;

    function setUp() public {
        usdt = new MockUSDT();
        oracle = new GridOracle(makeAddr("oracleReporter"), 1 hours);
        deployment = new DeployDerivatives();
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(deployer));
        vm.setEnv("OWNER_ADDRESS", vm.toString(owner));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardian));
        vm.setEnv("REPORTER_ADDRESS", vm.toString(reporter));
        vm.setEnv("QUOTER_ADDRESS", vm.toString(quoter));
        vm.setEnv("COLLATERAL_ADDRESS", vm.toString(address(usdt)));
        vm.setEnv("ORACLE_ADDRESS", vm.toString(address(oracle)));
        vm.setEnv("OPTIONS_METRIC", "ERCOT_HBNORTH_DA_AVG");
    }

    function testDeploysAllThreeWiredTogetherWithTheOfflineOwner() public {
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());
        (LivePriceFeed feed, TexasPowerPerp perp, TexasPowerOptions options) = deployment.run();

        assertEq(feed.owner(), owner);
        assertEq(feed.reporter(), reporter);
        assertEq(feed.guardian(), guardian);
        assertEq(feed.interval(), 300);
        assertEq(feed.minPriceCents(), -25_100);
        assertEq(feed.maxPriceCents(), 500_000);

        assertEq(perp.owner(), owner);
        assertEq(perp.guardian(), guardian);
        assertEq(address(perp.feed()), address(feed));
        assertEq(perp.feedId(), keccak256("ERCOT_HBNORTH_RT_5MIN"));
        assertEq(address(perp.collateral()), address(usdt));
        assertEq(perp.floorCents(), -5000);
        assertEq(perp.capCents(), 30_000);

        assertEq(options.owner(), owner);
        assertEq(options.quoter(), quoter);
        assertEq(options.guardian(), guardian);
        assertEq(address(options.oracle()), address(oracle));
        assertEq(options.metricId(), keccak256("ERCOT_HBNORTH_DA_AVG"));
        assertEq(options.strikeStepCents(), 500);
    }

    function testRefusesSharedKeysAndOtherChains() public {
        // a copy of the environment's config, changed in memory only (tests run in
        // parallel and share the environment)
        DeployDerivatives.Config memory c = deployment.configFromEnv();
        vm.chainId(deployment.XLAYER_TESTNET_CHAIN_ID());

        c.quoter = c.reporter;
        vm.expectRevert(
            abi.encodeWithSelector(DeployDerivatives.SameKeyTwice.selector, "reporter and quoter")
        );
        deployment.deploy(c);

        c.quoter = quoter;
        c.owner = c.deployer;
        vm.expectRevert(
            abi.encodeWithSelector(DeployDerivatives.SameKeyTwice.selector, "owner and deployer")
        );
        deployment.deploy(c);

        c.owner = owner;
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(DeployDerivatives.WrongChain.selector, 196));
        deployment.deploy(c);
    }
}
