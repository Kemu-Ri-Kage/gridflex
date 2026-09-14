// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { BinaryMarket } from "../src/BinaryMarket.sol";
import { GridOracle } from "../src/GridOracle.sol";
import { MockUSDT } from "../src/MockUSDT.sol";
import { OutcomeToken } from "../src/OutcomeToken.sol";

contract BinaryMarketTest is Test {
    bytes32 internal constant METRIC_ID = keccak256("ERCOT_HBNORTH_DA_AVG");
    bytes32 internal constant BASIS_METRIC_ID = keccak256("ERCOT_WEST_NORTH_DA_BASIS");
    bytes32 internal constant FEED_ONLY_METRIC_ID = keccak256("ERCOT_HBWEST_NEG_INTERVALS");
    bytes32 internal constant SOURCE_HASH = keccak256("ercot source");
    uint32 internal constant DAY_KEY = 20_260_908;
    uint64 internal constant MARKET_DAY_START_UTC = 1_788_843_600;
    uint64 internal constant MARKET_DAY_END_UTC = 1_788_930_000;
    uint64 internal constant START_TIME = 1_800_000_000;
    uint64 internal constant RESOLVE_AFTER = START_TIME + 2 hours;
    uint64 internal constant DISPUTE_WINDOW = 1 hours;
    int256 internal constant THRESHOLD = 3_000;
    uint256 internal constant SEED = 10_000e6;
    uint256 internal constant SET_AMOUNT = 1_000e6;

    address internal reporter;
    address internal alice;
    address internal bob;
    address internal liquidityProvider;

    GridOracle internal oracle;
    MockUSDT internal collateral;
    BinaryMarket internal market;
    OutcomeToken internal yesToken;
    OutcomeToken internal noToken;

    function setUp() public {
        vm.warp(START_TIME);
        reporter = makeAddr("reporter");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        liquidityProvider = makeAddr("liquidityProvider");

        oracle = new GridOracle(reporter, DISPUTE_WINDOW);
        collateral = new MockUSDT();
        market = _deployMarket(METRIC_ID, DAY_KEY, THRESHOLD, RESOLVE_AFTER, DISPUTE_WINDOW);
        yesToken = market.yesToken();
        noToken = market.noToken();

        collateral.mint(alice, 20_000e6);
        vm.prank(alice);
        collateral.approve(address(market), type(uint256).max);
    }

    function testConstructorStoresTermsAndMatchesCollateralDecimals() public view {
        assertEq(address(market.oracle()), address(oracle));
        assertEq(market.metricId(), METRIC_ID);
        assertEq(market.dayKey(), DAY_KEY);
        assertEq(market.threshold(), THRESHOLD);
        assertEq(address(market.collateral()), address(collateral));
        assertEq(market.resolveAfter(), RESOLVE_AFTER);
        assertEq(market.disputeWindow(), DISPUTE_WINDOW);
        assertEq(market.factory(), address(this));
        assertEq(yesToken.decimals(), collateral.decimals());
        assertEq(noToken.decimals(), collateral.decimals());
        assertEq(market.SWAP_FEE_BPS(), 0);
    }

    function testConstructorRejectsInvalidTermsAndFeedOnlyMetric() public {
        vm.expectRevert(BinaryMarket.ZeroAddress.selector);
        new BinaryMarket(
            address(0),
            METRIC_ID,
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            RESOLVE_AFTER,
            DISPUTE_WINDOW
        );

        vm.expectRevert(BinaryMarket.InvalidMetricId.selector);
        new BinaryMarket(
            address(oracle),
            bytes32(0),
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            RESOLVE_AFTER,
            DISPUTE_WINDOW
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                BinaryMarket.InvalidSettlementMetric.selector, FEED_ONLY_METRIC_ID
            )
        );
        new BinaryMarket(
            address(oracle),
            FEED_ONLY_METRIC_ID,
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            RESOLVE_AFTER,
            DISPUTE_WINDOW
        );

        vm.expectRevert(BinaryMarket.InvalidDayKey.selector);
        new BinaryMarket(
            address(oracle),
            METRIC_ID,
            0,
            THRESHOLD,
            address(collateral),
            RESOLVE_AFTER,
            DISPUTE_WINDOW
        );

        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.InvalidResolveTime.selector, START_TIME)
        );
        new BinaryMarket(
            address(oracle),
            METRIC_ID,
            DAY_KEY,
            THRESHOLD,
            address(collateral),
            START_TIME,
            DISPUTE_WINDOW
        );
    }

    function testFactoryCanSeedTenThousandPoolOnce() public {
        _seedPool();

        assertEq(market.liquidityProvider(), liquidityProvider);
        assertEq(market.yesReserve(), SEED);
        assertEq(market.noReserve(), SEED);
        assertEq(yesToken.balanceOf(address(market)), SEED);
        assertEq(noToken.balanceOf(address(market)), SEED);
        assertEq(collateral.balanceOf(address(market)), SEED);
        assertEq(market.price(), 0.5e18);

        collateral.mint(address(this), SEED);
        collateral.approve(address(market), SEED);
        vm.expectRevert(BinaryMarket.PoolAlreadySeeded.selector);
        market.seedPool(liquidityProvider, SEED);
    }

    function testNonFactoryCannotSeedPool() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BinaryMarket.UnauthorizedFactory.selector, alice));
        market.seedPool(alice, SEED);
    }

    function testMintSetLocksCollateralAndMintsBothOutcomes() public {
        _mintSetForAlice(SET_AMOUNT);

        assertEq(yesToken.balanceOf(alice), SET_AMOUNT);
        assertEq(noToken.balanceOf(alice), SET_AMOUNT);
        assertEq(collateral.balanceOf(address(market)), SET_AMOUNT);
    }

    function testMintAndTradingCloseAtResolveTime() public {
        _seedPool();
        vm.warp(RESOLVE_AFTER);

        vm.prank(alice);
        vm.expectRevert(BinaryMarket.TradingClosed.selector);
        market.mintSet(SET_AMOUNT);

        vm.prank(alice);
        vm.expectRevert(BinaryMarket.TradingClosed.selector);
        market.swap(true, SET_AMOUNT);
    }

    function testOneThousandTradeMovesPriceByVisibleAmount() public {
        _seedPool();
        _mintSetForAlice(SET_AMOUNT);
        uint256 invariantBefore = market.yesReserve() * market.noReserve();

        vm.prank(alice);
        yesToken.approve(address(market), SET_AMOUNT);
        vm.prank(alice);
        uint256 amountOut = market.swap(true, SET_AMOUNT);

        assertEq(amountOut, 909_090_909);
        assertEq(market.yesReserve(), SEED + SET_AMOUNT);
        assertEq(market.noReserve(), SEED - amountOut);
        assertGe(market.yesReserve() * market.noReserve(), invariantBefore);
        assertLt(market.price(), 0.46e18);
    }

    function testSellingNoForYesRaisesYesPrice() public {
        _seedPool();
        _mintSetForAlice(SET_AMOUNT);

        vm.prank(alice);
        noToken.approve(address(market), SET_AMOUNT);
        vm.prank(alice);
        market.swap(false, SET_AMOUNT);

        assertGt(market.price(), 0.5e18);
    }

    function testSwapRejectsMissingPoolAndZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.PoolNotSeeded.selector);
        market.swap(true, SET_AMOUNT);

        _seedPool();
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.ZeroAmount.selector);
        market.swap(true, 0);
    }

    function testResolveRejectsEarlyOrUnfinalizedReading() public {
        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.ResolveTooEarly.selector, RESOLVE_AFTER)
        );
        market.resolve();

        vm.warp(RESOLVE_AFTER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BinaryMarket.OracleReadingNotFinalized.selector, METRIC_ID, DAY_KEY
            )
        );
        market.resolve();
    }

    function testStrictlyAboveThresholdResolvesYesAndEqualResolvesNo() public {
        _resolveWithValue(THRESHOLD + 1);
        assertTrue(market.resolved());
        assertTrue(market.yesWon());

        BinaryMarket equalMarket = _deployMarket(
            METRIC_ID, DAY_KEY + 1, THRESHOLD, uint64(block.timestamp + 1 hours), DISPUTE_WINDOW
        );
        _submitAndFinalize(DAY_KEY + 1, THRESHOLD);
        vm.warp(equalMarket.resolveAfter());
        equalMarket.resolve();
        assertFalse(equalMarket.yesWon());
    }

    function testNegativeBasisAndNegativeThresholdResolveCorrectly() public {
        BinaryMarket basisMarket =
            _deployMarket(BASIS_METRIC_ID, 20_260_812, -1_500, RESOLVE_AFTER, DISPUTE_WINDOW);
        _submitAndFinalizeFor(BASIS_METRIC_ID, 20_260_812, -1_032);
        vm.warp(RESOLVE_AFTER);
        basisMarket.resolve();
        assertTrue(basisMarket.yesWon());
    }

    function testWinnerRedeemsOneForOne() public {
        _mintSetForAlice(SET_AMOUNT);
        uint256 balanceAfterMint = collateral.balanceOf(alice);
        _resolveWithValue(THRESHOLD + 1);

        vm.prank(alice);
        market.redeem();

        assertEq(yesToken.balanceOf(alice), 0);
        assertEq(noToken.balanceOf(alice), SET_AMOUNT);
        assertEq(collateral.balanceOf(alice), balanceAfterMint + SET_AMOUNT);
    }

    function testCannotRedeemBeforeSettlement() public {
        _mintSetForAlice(SET_AMOUNT);
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.MarketNotSettled.selector);
        market.redeem();
    }

    function testLiquidityProviderClaimsWinningReserveAfterResolution() public {
        _seedPool();
        _mintSetForAlice(SET_AMOUNT);
        vm.prank(alice);
        yesToken.approve(address(market), SET_AMOUNT);
        vm.prank(alice);
        market.swap(true, SET_AMOUNT);
        uint256 expectedPayout = market.yesReserve();

        _resolveWithValue(THRESHOLD + 1);
        vm.prank(liquidityProvider);
        market.claimLiquidity();

        assertEq(collateral.balanceOf(liquidityProvider), expectedPayout);
        assertEq(market.yesReserve(), 0);
        assertEq(market.noReserve(), 0);
    }

    function testCancelWaitsForGraceAndRejectsAvailableReading() public {
        vm.warp(RESOLVE_AFTER + DISPUTE_WINDOW - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                BinaryMarket.CancellationTooEarly.selector, uint256(RESOLVE_AFTER) + DISPUTE_WINDOW
            )
        );
        market.cancel();

        _submitAndFinalize(DAY_KEY, THRESHOLD + 1);
        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.OracleReadingAvailable.selector, METRIC_ID, DAY_KEY)
        );
        market.cancel();
    }

    function testCancelledCompleteSetRefundsCollateralOneForOne() public {
        _mintSetForAlice(SET_AMOUNT);
        uint256 balanceAfterMint = collateral.balanceOf(alice);
        _cancelMarket();

        vm.prank(alice);
        market.redeem();

        assertEq(yesToken.balanceOf(alice), 0);
        assertEq(noToken.balanceOf(alice), 0);
        assertEq(collateral.balanceOf(alice), balanceAfterMint + SET_AMOUNT);
    }

    function testCancelCannotRaceAnExistingUnfinalizedReading() public {
        vm.warp(RESOLVE_AFTER);
        vm.prank(reporter);
        oracle.submitReading(
            METRIC_ID, DAY_KEY, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, THRESHOLD + 1, SOURCE_HASH
        );
        vm.warp(RESOLVE_AFTER + DISPUTE_WINDOW);

        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.OracleReadingAvailable.selector, METRIC_ID, DAY_KEY)
        );
        market.cancel();

        oracle.finalize(METRIC_ID, DAY_KEY);
        market.resolve();
        assertTrue(market.resolved());
    }

    function testCancelledUnbalancedPositionPaysHalfPerOutcomeToken() public {
        _seedPool();
        _mintSetForAlice(SET_AMOUNT);
        vm.prank(alice);
        yesToken.approve(address(market), SET_AMOUNT);
        vm.prank(alice);
        market.swap(true, SET_AMOUNT);

        uint256 tokenTotal = yesToken.balanceOf(alice) + noToken.balanceOf(alice);
        uint256 expectedPayout = tokenTotal / 2;
        uint256 balanceBefore = collateral.balanceOf(alice);
        _cancelMarket();

        vm.prank(alice);
        market.redeem();
        assertEq(collateral.balanceOf(alice), balanceBefore + expectedPayout);
    }

    function testCancelledOddDustDoesNotRevertFinalRedemption() public {
        _mintSetForAlice(1);
        vm.prank(alice);
        noToken.transfer(bob, 1);
        _cancelMarket();

        vm.prank(alice);
        market.redeem();
        vm.prank(bob);
        market.redeem();

        assertEq(yesToken.balanceOf(alice), 0);
        assertEq(noToken.balanceOf(bob), 0);
        assertEq(collateral.balanceOf(address(market)), 1);
    }

    function testLiquidityProviderClaimsFairCancelledPoolPayout() public {
        _seedPool();
        _cancelMarket();

        vm.prank(liquidityProvider);
        market.claimLiquidity();

        assertEq(collateral.balanceOf(liquidityProvider), SEED);
        assertEq(market.yesReserve(), 0);
        assertEq(market.noReserve(), 0);
        assertTrue(market.liquidityRedeemed());
    }

    function testOnlyLiquidityProviderCanClaim() public {
        _seedPool();
        _cancelMarket();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(BinaryMarket.UnauthorizedLiquidityProvider.selector, bob)
        );
        market.claimLiquidity();
    }

    function testSettledMarketCannotResolveOrCancelAgain() public {
        _cancelMarket();
        vm.expectRevert(BinaryMarket.MarketAlreadySettled.selector);
        market.cancel();
        vm.expectRevert(BinaryMarket.MarketAlreadySettled.selector);
        market.resolve();
    }

    function testFuzzSwapKeepsConstantProduct(uint96 rawAmount) public {
        _seedPool();
        uint256 amount = bound(uint256(rawAmount), 2, 2_000e6);
        collateral.mint(alice, amount);
        _mintSetForAlice(amount);
        vm.prank(alice);
        yesToken.approve(address(market), amount);

        uint256 invariantBefore = market.yesReserve() * market.noReserve();
        vm.prank(alice);
        uint256 amountOut = market.swap(true, amount);

        assertGt(amountOut, 0);
        assertGe(market.yesReserve() * market.noReserve(), invariantBefore);
    }

    function _deployMarket(
        bytes32 metricId,
        uint32 dayKey,
        int256 threshold,
        uint64 resolveAfter,
        uint64 disputeWindow
    ) internal returns (BinaryMarket) {
        return new BinaryMarket(
            address(oracle),
            metricId,
            dayKey,
            threshold,
            address(collateral),
            resolveAfter,
            disputeWindow
        );
    }

    function _seedPool() internal {
        collateral.mint(address(this), SEED);
        collateral.approve(address(market), SEED);
        market.seedPool(liquidityProvider, SEED);
    }

    function _mintSetForAlice(uint256 amount) internal {
        vm.prank(alice);
        market.mintSet(amount);
    }

    function _resolveWithValue(int256 value) internal {
        _submitAndFinalize(DAY_KEY, value);
        vm.warp(RESOLVE_AFTER);
        market.resolve();
    }

    function _submitAndFinalize(uint32 dayKey, int256 value) internal {
        _submitAndFinalizeFor(METRIC_ID, dayKey, value);
    }

    function _submitAndFinalizeFor(bytes32 metricId, uint32 dayKey, int256 value) internal {
        vm.prank(reporter);
        oracle.submitReading(
            metricId, dayKey, MARKET_DAY_START_UTC, MARKET_DAY_END_UTC, value, SOURCE_HASH
        );
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(metricId, dayKey);
    }

    function _cancelMarket() internal {
        vm.warp(RESOLVE_AFTER + DISPUTE_WINDOW);
        market.cancel();
    }
}
