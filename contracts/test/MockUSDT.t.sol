// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { MockUSDT } from "../src/MockUSDT.sol";

contract MockUSDTTest is Test {
    MockUSDT internal token;
    address internal alice;
    address internal bob;

    function setUp() public {
        token = new MockUSDT();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
    }

    function testMetadataMatchesTestCollateral() public view {
        assertEq(token.name(), "GRIDFLEX Mock USDT");
        assertEq(token.symbol(), "mUSDT");
        assertEq(token.decimals(), 6);
    }

    function testAnyoneCanMintForDemo() public {
        vm.prank(alice);
        token.mint(bob, 250e6);

        assertEq(token.balanceOf(bob), 250e6);
        assertEq(token.totalSupply(), 250e6);
    }

    function testTransferAndTransferFromFollowERC20Rules() public {
        token.mint(alice, 100e6);

        vm.prank(alice);
        token.approve(bob, 40e6);

        vm.prank(bob);
        token.transferFrom(alice, bob, 40e6);

        assertEq(token.balanceOf(alice), 60e6);
        assertEq(token.balanceOf(bob), 40e6);
        assertEq(token.allowance(alice, bob), 0);
    }
}
