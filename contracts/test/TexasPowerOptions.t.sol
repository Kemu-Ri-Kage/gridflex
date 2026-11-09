// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";

import { GridOracle } from "../src/GridOracle.sol";
import { IGridOracle } from "../src/interfaces/IGridOracle.sol";
import { MockUSDT } from "../src/MockUSDT.sol";
import { TexasPowerOptions } from "../src/TexasPowerOptions.sol";

contract TexasPowerOptionsTest is Test {
    bytes32 internal constant METRIC = keccak256("ERCOT_HBNORTH_RT_AVG");
    uint32 internal constant DAY = 20_261_112;
    uint64 internal constant T = 1_794_300_000;
    uint64 internal constant CLOSE = T + 1 days; // trading stops when the Texas day starts
    uint64 internal constant DAY_END = CLOSE + 1 days;
    int64 internal constant FLOOR = -5000;
    int64 internal constant CAP = 30_000;
    uint256 internal constant MWH = 1000;
    uint256 internal constant POOL = 1_000_000e6;

    address internal owner = makeAddr("owner");
    address internal quoter = makeAddr("quoter");
    address internal guardian = makeAddr("guardian");
    address internal reporter = makeAddr("reporter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockUSDT internal usdt;
    GridOracle internal oracle;
    TexasPowerOptions internal opt;

    function setUp() public {
        vm.warp(T);
        usdt = new MockUSDT();
        oracle = new GridOracle(reporter, 1 hours);
        opt = new TexasPowerOptions(
            owner,
            quoter,
            guardian,
            IERC20(address(usdt)),
            IGridOracle(address(oracle)),
            METRIC,
            FLOOR,
            CAP,
            500
        );
        address[3] memory people = [owner, alice, bob];
        for (uint256 i; i < people.length; ++i) {
            usdt.mint(people[i], 10_000_000e6);
            vm.prank(people[i]);
            usdt.approve(address(opt), type(uint256).max);
        }
        vm.prank(owner);
        opt.fundPool(POOL);
        vm.prank(quoter);
        opt.openExpiry(DAY, CLOSE);
    }

    // ------------------------------------------------------------ helpers

    function _q(uint64 callAsk, uint64 callBid, uint64 putAsk, uint64 putBid)
        internal
        pure
        returns (TexasPowerOptions.Quote memory)
    {
        return TexasPowerOptions.Quote(callAsk, callBid, putAsk, putBid);
    }

    /// Posts one strike's quotes five minutes later (so earlier orders fill).
    function _post(int64 strike, TexasPowerOptions.Quote memory q) internal returns (uint64) {
        vm.warp(block.timestamp + 5 minutes);
        int64[] memory strikes = new int64[](1);
        TexasPowerOptions.Quote[] memory quotes = new TexasPowerOptions.Quote[](1);
        strikes[0] = strike;
        quotes[0] = q;
        vm.prank(quoter);
        return opt.postQuotes(DAY, strikes, quotes);
    }

    function _buy(address who, int64 strike, bool isCall, uint256 size, uint64 maxPremium)
        internal
        returns (uint256 orderId)
    {
        vm.prank(who);
        orderId = opt.requestBuy(DAY, strike, isCall, size, maxPremium);
    }

    function _settle(int256 value) internal {
        vm.warp(DAY_END + 10 minutes);
        vm.prank(reporter);
        oracle.submitReading(METRIC, DAY, CLOSE, DAY_END, value, keccak256("rows"));
        vm.warp(block.timestamp + 1 hours);
        oracle.finalize(METRIC, DAY);
    }

    function _held(address who, int64 strike, bool isCall) internal view returns (uint256) {
        return opt.balanceOf(opt.seriesId(DAY, strike, isCall), who);
    }

    function _checkBooks() internal view {
        assertEq(
            usdt.balanceOf(address(opt)),
            opt.poolCash() + opt.orderEscrow() + opt.settledOwed(),
            "token balance = pool + escrow + settled payouts"
        );
        assertLe(opt.totalReserved(), opt.poolCash(), "reserves covered");
    }

    // ------------------------------------------------------------ buying

    function testBuyFillsAtTheNextQuoteAndRefundsTheRest() public {
        _post(4500, _q(250, 180, 300, 260));
        uint256 before = usdt.balanceOf(alice);
        uint256 orderId = _buy(alice, 4500, true, 10 * MWH, 300);
        assertEq(before - usdt.balanceOf(alice), 30_000_000); // escrow: 10 MWh x $3
        assertEq(opt.totalReserved(), 2_550_000_000); // 10 MWh x ($300 - $45)

        _post(4500, _q(210, 190, 300, 260)); // fills here, at $2.10
        assertEq(before - usdt.balanceOf(alice), 21_000_000);
        assertEq(_held(alice, 4500, true), 10 * MWH);
        assertFalse(opt.getOrder(orderId).pending);
        assertEq(opt.poolCash(), POOL + 21_000_000);
        assertEq(opt.totalReserved(), 2_550_000_000);
        assertEq(opt.pendingOrders(DAY).length, 0);
        _checkBooks();
    }

    function testOrdersFromTheQuotesOwnBlockWaitForTheNextVersion() public {
        uint256 orderId = _buy(alice, 4500, true, MWH, 300);
        int64[] memory strikes = new int64[](1);
        TexasPowerOptions.Quote[] memory quotes = new TexasPowerOptions.Quote[](1);
        strikes[0] = 4500;
        quotes[0] = _q(100, 90, 300, 260); // same block as the order: a price it could see
        vm.prank(quoter);
        opt.postQuotes(DAY, strikes, quotes);
        assertTrue(opt.getOrder(orderId).pending);

        _post(4500, _q(220, 200, 300, 260));
        assertFalse(opt.getOrder(orderId).pending);
        assertEq(10_000_000e6 - usdt.balanceOf(alice), 2_200_000); // 1 MWh at $2.20
        _checkBooks();
    }

    function testABuyBeyondItsLimitOrAnUnquotedStrikeCancels() public {
        uint256 before = usdt.balanceOf(alice);
        uint256 tooDear = _buy(alice, 4500, true, MWH, 200);
        uint256 unquoted = _buy(alice, 5000, false, MWH, 900);
        _post(4500, _q(210, 190, 300, 260));

        assertFalse(opt.getOrder(tooDear).pending);
        assertFalse(opt.getOrder(unquoted).pending);
        assertEq(usdt.balanceOf(alice), before);
        assertEq(opt.totalReserved(), 0);
        assertEq(_held(alice, 4500, true), 0);
        _checkBooks();
    }

    function testRequestsAreChecked() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidStrike.selector, 4550));
        opt.requestBuy(DAY, 4550, true, MWH, 100);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidStrike.selector, CAP));
        opt.requestBuy(DAY, CAP, true, MWH, 100);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.SizeTooSmall.selector, 99));
        opt.requestBuy(DAY, 4500, true, 99, 100);
        // a premium above the largest payout ($300 - $45) makes no sense
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidLimit.selector, 25_501));
        opt.requestBuy(DAY, 4500, true, MWH, 25_501);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.UnknownExpiry.selector, 1));
        opt.requestBuy(1, 4500, true, MWH, 100);
        vm.stopPrank();

        vm.warp(CLOSE);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.TradingClosed.selector, DAY));
        _buy(alice, 4500, true, MWH, 100);
    }

    function testThePoolMustCoverTheLargestPayout() public {
        TexasPowerOptions small = new TexasPowerOptions(
            owner,
            quoter,
            guardian,
            IERC20(address(usdt)),
            IGridOracle(address(oracle)),
            METRIC,
            FLOOR,
            CAP,
            500
        );
        vm.prank(quoter);
        small.openExpiry(DAY, CLOSE);
        vm.startPrank(alice);
        usdt.approve(address(small), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.PoolCannotCover.selector, 255_000_000, 0)
        );
        small.requestBuy(DAY, 4500, true, MWH, 100);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ settlement

    function testACallInTheMoneyPaysTheDifference() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        _settle(5200);

        uint256 before = usdt.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = opt.claim(DAY, 4500, true);
        assertEq(paid, 70_000_000); // 10 MWh x ($52 - $45)
        assertEq(usdt.balanceOf(alice) - before, paid);
        assertEq(opt.poolCash(), POOL + 21_000_000 - 70_000_000);
        assertEq(opt.totalReserved(), 0);
        assertEq(opt.settledOwed(), 0);
        _checkBooks();
    }

    function testAPutPaysAndTheBandCapsIt() public {
        _buy(bob, 4000, false, 10 * MWH, 500);
        _post(4000, _q(400, 380, 300, 280));
        _settle(-20_000); // -$200, clamped to the -$50 floor

        vm.prank(bob);
        assertEq(opt.claim(DAY, 4000, false), 900_000_000); // 10 MWh x ($40 + $50)
        _checkBooks();
    }

    function testACallStopsAtTheCap() public {
        _buy(alice, 4500, true, MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        _settle(90_000);
        vm.prank(alice);
        assertEq(opt.claim(DAY, 4500, true), 255_000_000); // 1 MWh x ($300 - $45)
        _checkBooks();
    }

    function testOutOfTheMoneyPaysNothingAndFreesTheReserve() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        _settle(4000);
        opt.settleSeries(DAY, 4500, true); // anyone can settle
        assertEq(opt.totalReserved(), 0);
        assertEq(opt.poolCash(), POOL + 21_000_000);
        vm.prank(alice);
        assertEq(opt.claim(DAY, 4500, true), 0);
        _checkBooks();
    }

    function testSettlementNeedsAFinalReading() public {
        _buy(alice, 4500, true, MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        vm.warp(DAY_END + 10 minutes);
        vm.prank(reporter);
        oracle.submitReading(METRIC, DAY, CLOSE, DAY_END, 5200, keccak256("rows"));
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.NotFinal.selector, DAY));
        opt.settleSeries(DAY, 4500, true);
    }

    // ------------------------------------------------------------ selling back

    function testHoldersSellBackAtTheBid() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        uint256 before = usdt.balanceOf(alice);

        vm.prank(alice);
        uint256 orderId = opt.requestSell(DAY, 4500, true, 4 * MWH, 150);
        assertEq(_held(alice, 4500, true), 6 * MWH); // held by the order meanwhile
        _post(4500, _q(200, 180, 300, 260));

        assertFalse(opt.getOrder(orderId).pending);
        assertEq(usdt.balanceOf(alice) - before, 7_200_000); // 4 MWh at $1.80
        assertEq(opt.totalReserved(), 1_530_000_000); // 6 MWh x $255 still locked
        _checkBooks();
    }

    function testASellBelowItsLimitReturnsTheOptions() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        vm.prank(alice);
        opt.requestSell(DAY, 4500, true, 4 * MWH, 200);
        _post(4500, _q(200, 180, 300, 260));
        assertEq(_held(alice, 4500, true), 10 * MWH);
        _checkBooks();
    }

    function testSellingNeedsTheOptions() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.NotEnoughOptions.selector, 0, MWH));
        opt.requestSell(DAY, 4500, true, MWH, 1);
    }

    // ------------------------------------------------------------ cancelling

    function testCancelOnlyWhenPausedClosedOrQuotesStopped() public {
        uint256 orderId = _buy(alice, 4500, true, MWH, 300);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.OrderCannotBeCancelledYet.selector, orderId)
        );
        opt.cancelOrder(orderId);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.NotYourOrder.selector, orderId));
        opt.cancelOrder(orderId);

        vm.warp(block.timestamp + 15 minutes); // the quoter went quiet
        vm.prank(alice);
        opt.cancelOrder(orderId);

        uint256 second = _buy(alice, 4500, true, MWH, 300);
        vm.prank(guardian);
        opt.pause();
        vm.prank(alice);
        opt.cancelOrder(second);

        vm.prank(owner);
        opt.unpause();
        uint256 third = _buy(alice, 4500, true, MWH, 300);
        vm.warp(CLOSE); // it can never fill now
        vm.prank(alice);
        opt.cancelOrder(third);

        assertEq(usdt.balanceOf(alice), 10_000_000e6);
        assertEq(opt.totalReserved(), 0);
        _checkBooks();
    }

    // ------------------------------------------------------------ quoter, pool and keys

    function testOnlyTheQuoterPostsAndQuotesAreChecked() public {
        int64[] memory strikes = new int64[](1);
        TexasPowerOptions.Quote[] memory quotes = new TexasPowerOptions.Quote[](1);
        strikes[0] = 4500;

        quotes[0] = _q(210, 190, 300, 260);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.UnauthorizedQuoter.selector, alice)
        );
        opt.postQuotes(DAY, strikes, quotes);

        vm.startPrank(quoter);
        quotes[0] = _q(190, 210, 300, 260); // bid above ask
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidQuote.selector, 4500));
        opt.postQuotes(DAY, strikes, quotes);

        quotes[0] = _q(25_501, 0, 300, 260); // ask above the largest payout
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidQuote.selector, 4500));
        opt.postQuotes(DAY, strikes, quotes);

        strikes[0] = 4550;
        quotes[0] = _q(210, 190, 300, 260);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.InvalidStrike.selector, 4550));
        opt.postQuotes(DAY, strikes, quotes);

        vm.expectRevert(TexasPowerOptions.LengthMismatch.selector);
        opt.postQuotes(DAY, new int64[](2), quotes);

        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.ExpiryExists.selector, DAY));
        opt.openExpiry(DAY, CLOSE);
        vm.stopPrank();

        vm.warp(CLOSE);
        strikes[0] = 4500;
        vm.prank(quoter);
        vm.expectRevert(abi.encodeWithSelector(TexasPowerOptions.TradingClosed.selector, DAY));
        opt.postQuotes(DAY, strikes, quotes);
    }

    function testPauseStopsQuotesAndBuys() public {
        vm.prank(guardian);
        opt.pause();
        vm.expectRevert(TexasPowerOptions.MarketPaused.selector);
        _buy(alice, 4500, true, MWH, 300);
        vm.expectRevert(TexasPowerOptions.MarketPaused.selector);
        _post(4500, _q(210, 190, 300, 260));
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        opt.unpause();
    }

    function testTheOwnerTakesOutOnlyFreeCash() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        uint256 free = opt.poolCash() - opt.totalReserved();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.FreeCashTooLow.selector, free + 1, free)
        );
        opt.defundPool(free + 1);
        vm.prank(owner);
        opt.defundPool(free);
        assertEq(opt.poolCash(), opt.totalReserved());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        opt.fundPool(1);
        _checkBooks();
    }

    function testPendingOrdersPerExpiryAreBounded() public {
        for (uint256 i; i < opt.MAX_PENDING(); ++i) {
            _buy(alice, 4500, true, 100, 300);
        }
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.TooManyPendingOrders.selector, DAY)
        );
        _buy(alice, 4500, true, 100, 300);

        _post(4500, _q(210, 190, 300, 260)); // the quoter fills all 100 in one go
        assertEq(opt.pendingOrders(DAY).length, 0);
        assertEq(_held(alice, 4500, true), 100 * 100);
        _checkBooks();
    }

    function testKeys() public {
        vm.startPrank(owner);
        vm.expectRevert(TexasPowerOptions.QuoterIsOwner.selector);
        opt.setQuoter(owner);
        vm.expectRevert(TexasPowerOptions.QuoterIsOwner.selector);
        opt.transferOwnership(quoter);
        vm.expectRevert(TexasPowerOptions.OwnershipCannotBeRenounced.selector);
        opt.renounceOwnership();
        vm.expectRevert(TexasPowerOptions.InvalidSetting.selector);
        opt.setOrderTimeout(30);
        opt.setQuoter(bob);
        vm.stopPrank();
        assertEq(opt.quoter(), bob);
    }

    // ------------------------------------------------------------ void when the oracle never finalizes

    function testAVoidedSeriesRefundsWhatEachHolderPaid() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260)); // alice pays $21.00
        _buy(bob, 4500, true, 5 * MWH, 300);
        _post(4500, _q(220, 200, 300, 260)); // bob pays $11.00
        uint256 aliceBefore = usdt.balanceOf(alice);
        uint256 bobBefore = usdt.balanceOf(bob);

        vm.warp(CLOSE + 14 days); // no final reading ever came
        vm.prank(alice);
        assertEq(opt.claim(DAY, 4500, true), 21_000_000);
        vm.prank(bob);
        assertEq(opt.claim(DAY, 4500, true), 11_000_000);

        assertEq(usdt.balanceOf(alice) - aliceBefore, 21_000_000);
        assertEq(usdt.balanceOf(bob) - bobBefore, 11_000_000);
        assertEq(opt.poolCash(), POOL);
        assertEq(opt.totalReserved(), 0);
        assertEq(opt.settledOwed(), 0);
        _checkBooks();
    }

    function testVoidWaitsForTheGraceAndNeverOverridesAFinalPrice() public {
        _buy(alice, 4500, true, MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        vm.warp(CLOSE + 14 days - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                TexasPowerOptions.GraceNotOver.selector, uint256(CLOSE) + 14 days
            )
        );
        opt.voidSeries(DAY, 4500, true);

        _settle(5200); // a final reading, even very late, settles normally
        vm.expectRevert(
            abi.encodeWithSelector(TexasPowerOptions.SettlementStillPossible.selector, DAY)
        );
        opt.voidSeries(DAY, 4500, true);
        vm.prank(alice);
        assertEq(opt.claim(DAY, 4500, true), 7_000_000); // 1 MWh x ($52 - $45)
        _checkBooks();
    }

    function testSellingBackTakesItsShareOfThePremiumPaid() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260)); // $21.00 for 10 MWh
        vm.prank(alice);
        opt.requestSell(DAY, 4500, true, 4 * MWH, 150);
        bytes32 id = opt.seriesId(DAY, 4500, true);
        assertEq(opt.premiumPaid(id, alice), 12_600_000); // 6 of 10 MWh keep $12.60
        _post(4500, _q(200, 180, 300, 260));

        vm.warp(CLOSE + 14 days);
        vm.prank(alice);
        assertEq(opt.claim(DAY, 4500, true), 12_600_000);
        assertEq(opt.totalReserved(), 0);
        _checkBooks();
    }

    function testACancelledSellGivesTheBasisBack() public {
        _buy(alice, 4500, true, 10 * MWH, 300);
        _post(4500, _q(210, 190, 300, 260));
        vm.prank(alice);
        opt.requestSell(DAY, 4500, true, 4 * MWH, 250); // above any bid
        _post(4500, _q(200, 180, 300, 260)); // cancelled: bid below the limit
        assertEq(opt.premiumPaid(opt.seriesId(DAY, 4500, true), alice), 21_000_000);
        _checkBooks();
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the strike, side, size, premium and settlement: the payout never exceeds
    /// what was locked, every reserve is freed and the books balance.
    function testFuzzEveryOptionIsCovered(
        uint256 strikeStep,
        bool isCall,
        uint256 size,
        uint64 premium,
        int256 settlement
    ) public {
        int64 strike = int64(int256(bound(strikeStep, 1, 69))) * 500 + FLOOR;
        size = bound(size, 100, 100 * MWH);
        uint64 maxPayout = uint64(isCall ? CAP - strike : strike - FLOOR);
        premium = uint64(bound(premium, 1, maxPayout));
        settlement = bound(settlement, -100_000, 1_000_000);

        TexasPowerOptions.Quote memory q =
            isCall ? _q(premium, premium, 0, 0) : _q(0, 0, premium, premium);
        _buy(alice, strike, isCall, size, premium);
        _post(strike, q);
        assertEq(_held(alice, strike, isCall), size);

        _settle(settlement);
        vm.prank(alice);
        uint256 paid = opt.claim(DAY, strike, isCall);

        assertLe(paid, size * maxPayout * 10);
        assertEq(opt.totalReserved(), 0);
        assertEq(opt.settledOwed(), 0);
        assertEq(opt.poolCash(), usdt.balanceOf(address(opt)));
        _checkBooks();
    }
}
