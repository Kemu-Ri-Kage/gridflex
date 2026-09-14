// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { OutcomeToken } from "../src/OutcomeToken.sol";

contract OutcomeTokenTest is Test {
    address internal market;
    address internal alice;
    OutcomeToken internal token;

    function setUp() public {
        market = makeAddr("market");
        alice = makeAddr("alice");
        token = new OutcomeToken("GRIDFLEX YES", "YES", market, 6);
    }

    function testConstructorRejectsZeroMarket() public {
        vm.expectRevert(OutcomeToken.ZeroMarket.selector);
        new OutcomeToken("GRIDFLEX YES", "YES", address(0), 6);
    }

    function testUsesCollateralDecimals() public view {
        assertEq(token.decimals(), 6);
    }

    function testOnlyMarketCanMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OutcomeToken.UnauthorizedMarket.selector, alice));
        token.mint(alice, 1e18);

        vm.prank(market);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function testOnlyMarketCanBurn() public {
        vm.prank(market);
        token.mint(alice, 1e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OutcomeToken.UnauthorizedMarket.selector, alice));
        token.burn(alice, 1e18);

        vm.prank(market);
        token.burn(alice, 1e18);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }
}
