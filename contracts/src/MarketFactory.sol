// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { BinaryMarket } from "./BinaryMarket.sol";

/// @title Factory and registry for GRIDFLEX binary markets
contract MarketFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address[] private _markets;

    error ZeroInitialLiquidity();

    event MarketCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed metricId,
        uint32 dayKey,
        int256 threshold,
        uint64 resolveAfter,
        uint64 disputeWindow,
        address collateral,
        uint256 initialLiquidity
    );

    function createMarket(
        address oracle,
        bytes32 metricId,
        uint32 dayKey,
        int256 threshold,
        address collateral,
        uint64 resolveAfter,
        uint64 disputeWindow,
        uint256 initialLiquidity
    ) external nonReentrant returns (address marketAddress) {
        if (initialLiquidity == 0) revert ZeroInitialLiquidity();

        BinaryMarket market = new BinaryMarket(
            oracle, metricId, dayKey, threshold, collateral, resolveAfter, disputeWindow
        );
        marketAddress = address(market);
        _markets.push(marketAddress);

        IERC20 collateralToken = IERC20(collateral);
        collateralToken.safeTransferFrom(msg.sender, address(this), initialLiquidity);
        collateralToken.forceApprove(marketAddress, initialLiquidity);
        market.seedPool(msg.sender, initialLiquidity);

        emit MarketCreated(
            marketAddress,
            msg.sender,
            metricId,
            dayKey,
            threshold,
            resolveAfter,
            disputeWindow,
            collateral,
            initialLiquidity
        );
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return _markets[index];
    }

    function getMarkets() external view returns (address[] memory) {
        return _markets;
    }
}
