// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IGridOracle } from "./interfaces/IGridOracle.sol";
import { OutcomeToken } from "./OutcomeToken.sol";

/// @title Cash-settled GRIDFLEX binary outcome market
/// @notice Resolves YES when an oracle metric is strictly greater than a fixed threshold.
contract BinaryMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ONE = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant SWAP_FEE_BPS = 0;
    bytes32 public constant HBNORTH_DA_AVG = keccak256("ERCOT_HBNORTH_DA_AVG");
    bytes32 public constant WEST_NORTH_DA_BASIS = keccak256("ERCOT_WEST_NORTH_DA_BASIS");

    IGridOracle public immutable oracle;
    bytes32 public immutable metricId;
    uint32 public immutable dayKey;
    int256 public immutable threshold;
    IERC20 public immutable collateral;
    uint64 public immutable resolveAfter;
    uint64 public immutable disputeWindow;
    address public immutable factory;

    OutcomeToken public immutable yesToken;
    OutcomeToken public immutable noToken;

    uint256 public yesReserve;
    uint256 public noReserve;
    address public liquidityProvider;
    bool public resolved;
    bool public cancelled;
    bool public yesWon;
    bool public liquidityRedeemed;

    error ZeroAddress();
    error InvalidMetricId();
    error InvalidSettlementMetric(bytes32 metricId);
    error InvalidDayKey();
    error InvalidResolveTime(uint64 resolveAfter);
    error ZeroAmount();
    error UnauthorizedFactory(address caller);
    error UnauthorizedLiquidityProvider(address caller);
    error TradingClosed();
    error PoolAlreadySeeded();
    error PoolNotSeeded();
    error ZeroMinimumOutput();
    error InsufficientOutput();
    error SlippageExceeded(uint256 amountOut, uint256 minimumAmountOut);
    error SwapDeadlineExpired(uint64 deadline, uint256 currentTime);
    error ResolveTooEarly(uint64 resolveAfter);
    error OracleReadingNotFinalized(bytes32 metricId, uint32 dayKey);
    error OracleReadingAvailable(bytes32 metricId, uint32 dayKey);
    error CancellationTooEarly(uint256 cancellableAt);
    error MarketAlreadySettled();
    error MarketNotSettled();
    error NothingToRedeem();
    error LiquidityAlreadyRedeemed();

    event PoolSeeded(address indexed provider, uint256 amount);
    event SetMinted(address indexed account, uint256 amount);
    event Swapped(
        address indexed account, bool indexed yesForNo, uint256 amountIn, uint256 amountOut
    );
    event Resolved(bool indexed yesWon, int256 oracleValue);
    event Cancelled(uint256 indexed cancellableAt);
    event Redeemed(address indexed account, uint256 yesBurned, uint256 noBurned, uint256 payout);
    event LiquidityClaimed(address indexed provider, uint256 amount);

    constructor(
        address oracle_,
        bytes32 metricId_,
        uint32 dayKey_,
        int256 threshold_,
        address collateral_,
        uint64 resolveAfter_,
        uint64 disputeWindow_
    ) {
        if (oracle_ == address(0) || collateral_ == address(0)) {
            revert ZeroAddress();
        }
        if (metricId_ == bytes32(0)) revert InvalidMetricId();
        if (metricId_ != HBNORTH_DA_AVG && metricId_ != WEST_NORTH_DA_BASIS) {
            revert InvalidSettlementMetric(metricId_);
        }
        if (dayKey_ == 0) revert InvalidDayKey();
        if (resolveAfter_ <= block.timestamp) revert InvalidResolveTime(resolveAfter_);

        oracle = IGridOracle(oracle_);
        metricId = metricId_;
        dayKey = dayKey_;
        threshold = threshold_;
        collateral = IERC20(collateral_);
        resolveAfter = resolveAfter_;
        disputeWindow = disputeWindow_;
        factory = msg.sender;

        uint8 collateralDecimals = IERC20Metadata(collateral_).decimals();
        yesToken = new OutcomeToken("GRIDFLEX YES", "YES", address(this), collateralDecimals);
        noToken = new OutcomeToken("GRIDFLEX NO", "NO", address(this), collateralDecimals);
    }

    /// @notice Seeds the YES/NO AMM once. The factory supplies collateral on the provider's behalf.
    function seedPool(address provider, uint256 amount) external nonReentrant {
        if (msg.sender != factory) revert UnauthorizedFactory(msg.sender);
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= resolveAfter) revert TradingClosed();
        if (liquidityProvider != address(0)) revert PoolAlreadySeeded();

        liquidityProvider = provider;
        yesReserve = amount;
        noReserve = amount;

        collateral.safeTransferFrom(msg.sender, address(this), amount);
        yesToken.mint(address(this), amount);
        noToken.mint(address(this), amount);

        emit PoolSeeded(provider, amount);
    }

    /// @notice Locks collateral and mints an equal amount of YES and NO tokens to the caller.
    function mintSet(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= resolveAfter) revert TradingClosed();

        collateral.safeTransferFrom(msg.sender, address(this), amount);
        yesToken.mint(msg.sender, amount);
        noToken.mint(msg.sender, amount);

        emit SetMinted(msg.sender, amount);
    }

    /// @notice Swaps one outcome token for the other through the constant-product pool.
    /// @param yesForNo True sends YES and receives NO; false sends NO and receives YES.
    /// @param amountIn Exact amount of the input outcome token sent by the caller.
    /// @param minimumAmountOut Lowest output accepted by the caller after price movement.
    /// @param deadline Latest block timestamp at which the transaction may execute.
    function swap(bool yesForNo, uint256 amountIn, uint256 minimumAmountOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (minimumAmountOut == 0) revert ZeroMinimumOutput();
        if (block.timestamp > deadline) revert SwapDeadlineExpired(deadline, block.timestamp);
        if (block.timestamp >= resolveAfter) revert TradingClosed();
        amountOut = quoteSwap(yesForNo, amountIn);
        if (amountOut < minimumAmountOut) {
            revert SlippageExceeded(amountOut, minimumAmountOut);
        }

        uint256 reserveIn = yesForNo ? yesReserve : noReserve;
        uint256 reserveOut = yesForNo ? noReserve : yesReserve;

        if (yesForNo) {
            yesReserve = reserveIn + amountIn;
            noReserve = reserveOut - amountOut;
            IERC20(address(yesToken)).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(address(noToken)).safeTransfer(msg.sender, amountOut);
        } else {
            noReserve = reserveIn + amountIn;
            yesReserve = reserveOut - amountOut;
            IERC20(address(noToken)).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(address(yesToken)).safeTransfer(msg.sender, amountOut);
        }

        emit Swapped(msg.sender, yesForNo, amountIn, amountOut);
    }

    /// @notice Returns the current output quote for an exact-input outcome-token swap.
    function quoteSwap(bool yesForNo, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (liquidityProvider == address(0)) revert PoolNotSeeded();

        uint256 reserveIn = yesForNo ? yesReserve : noReserve;
        uint256 reserveOut = yesForNo ? noReserve : yesReserve;
        uint256 amountInAfterFee = Math.mulDiv(amountIn, BPS - SWAP_FEE_BPS, BPS);
        amountOut = Math.mulDiv(reserveOut, amountInAfterFee, reserveIn + amountInAfterFee);
        if (amountOut == 0 || amountOut >= reserveOut) revert InsufficientOutput();
    }

    /// @notice Returns the estimated YES probability from pool reserves, scaled by 1e18.
    function price() external view returns (uint256 yesPriceE18) {
        if (liquidityProvider == address(0)) revert PoolNotSeeded();
        return Math.mulDiv(noReserve, ONE, yesReserve + noReserve);
    }

    /// @notice Resolves the market from a finalized oracle reading.
    function resolve() external {
        if (resolved || cancelled) revert MarketAlreadySettled();
        if (block.timestamp < resolveAfter) revert ResolveTooEarly(resolveAfter);
        if (!oracle.isFinal(metricId, dayKey)) {
            revert OracleReadingNotFinalized(metricId, dayKey);
        }

        IGridOracle.Reading memory reading = oracle.getReading(metricId, dayKey);
        yesWon = reading.value > threshold;
        resolved = true;

        emit Resolved(yesWon, reading.value);
    }

    /// @notice Cancels an unresolvable market after its grace period.
    /// @dev On cancellation each YES and each NO pays 0.5 collateral, rounded down.
    function cancel() external {
        if (resolved || cancelled) revert MarketAlreadySettled();

        uint256 cancellableAt = uint256(resolveAfter) + disputeWindow;
        if (block.timestamp < cancellableAt) revert CancellationTooEarly(cancellableAt);
        IGridOracle.Reading memory reading = oracle.getReading(metricId, dayKey);
        if (reading.publishedAt != 0) {
            revert OracleReadingAvailable(metricId, dayKey);
        }

        cancelled = true;
        emit Cancelled(cancellableAt);
    }

    /// @notice Burns the caller's payable outcome tokens and transfers the collateral payout.
    function redeem() external nonReentrant {
        if (!resolved && !cancelled) revert MarketNotSettled();

        uint256 yesBalance = yesToken.balanceOf(msg.sender);
        uint256 noBalance = noToken.balanceOf(msg.sender);
        uint256 yesToBurn = 0;
        uint256 noToBurn = 0;
        uint256 payout = 0;

        if (cancelled) {
            if (yesBalance == 0 && noBalance == 0) revert NothingToRedeem();
            yesToBurn = yesBalance;
            noToBurn = noBalance;
            payout = Math.average(yesBalance, noBalance);
        } else if (yesWon) {
            if (yesBalance == 0) revert NothingToRedeem();
            yesToBurn = yesBalance;
            payout = yesBalance;
        } else {
            if (noBalance == 0) revert NothingToRedeem();
            noToBurn = noBalance;
            payout = noBalance;
        }

        if (yesToBurn != 0) yesToken.burn(msg.sender, yesToBurn);
        if (noToBurn != 0) noToken.burn(msg.sender, noToBurn);
        if (payout != 0) collateral.safeTransfer(msg.sender, payout);

        emit Redeemed(msg.sender, yesToBurn, noToBurn, payout);
    }

    /// @notice Returns the pool's terminal payout to its original provider.
    function claimLiquidity() external nonReentrant {
        if (!resolved && !cancelled) revert MarketNotSettled();
        if (msg.sender != liquidityProvider) revert UnauthorizedLiquidityProvider(msg.sender);
        if (liquidityRedeemed) revert LiquidityAlreadyRedeemed();

        liquidityRedeemed = true;
        uint256 payout =
            cancelled ? Math.average(yesReserve, noReserve) : yesWon ? yesReserve : noReserve;
        uint256 yesToBurn = yesReserve;
        uint256 noToBurn = noReserve;
        yesReserve = 0;
        noReserve = 0;

        yesToken.burn(address(this), yesToBurn);
        noToken.burn(address(this), noToBurn);

        if (payout != 0) collateral.safeTransfer(msg.sender, payout);
        emit LiquidityClaimed(msg.sender, payout);
    }
}
