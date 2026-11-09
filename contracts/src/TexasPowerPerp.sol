// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { LivePriceFeed } from "./LivePriceFeed.sol";

/// @title TXPOWER-PERP: a fully backed perpetual future on the live Texas power price
/// @notice GRIDFLEX Trading Platform Plan, "Market 1: perpetual futures".
///         - Traders go long or short in MWh on the GRIDFLEX Texas Live Index
///           (LivePriceFeed.indexAt), clamped to a fixed band [floorCents, capCents].
///         - No leverage and no liquidation: a long posts size x (entry - floor), a short
///           posts size x (cap - entry), which is the most either can lose inside the band.
///         - The pool is the other side. It sets aside each position's largest possible
///           gain (the reserve), so every payout is covered before the position opens.
///         - Orders fill at the first price round published after the order, never at a
///           price the trader could already see; once that round exists nobody can cancel.
///         - The side with more open MWh pays funding to the pool every second, at a rate
///           that grows with the imbalance (up to maxFundingCentsPerMwhHour).
///         - Fees: feeBps of the position's value at open and at close, to the pool.
///         - Liquidity providers deposit collateral for pool shares (this ERC-20) and can
///           withdraw whatever is not reserved.
///         Sizes are in thousandths of a MWh (1,000 = 1 MWh); prices are cents per MWh;
///         the collateral has 6 decimals, so 1 cent on 1 MWh is 10 units per size unit.
contract TexasPowerPerp is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address account;
        uint64 createdAt;
        bool pending;
        bool isOpen;
        bool isLong;
        int64 acceptablePriceCents;
        uint256 size;
        uint256 positionId;
        uint256 escrow;
        uint256 reserveHeld;
    }

    struct Position {
        address account;
        bool open;
        bool isLong;
        int64 entryPriceCents;
        uint256 size;
        uint256 collateral;
        uint256 reserve;
        uint256 fundingEntry;
        uint256 closeOrderId;
    }

    /// @notice Size units per MWh: a size of 1,000 is 1 MWh.
    uint256 public constant SIZE_PER_MWH = 1000;
    /// @notice Smallest order: 0.1 MWh.
    uint256 public constant MIN_SIZE = 100;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_FUNDING_CENTS_PER_MWH_HOUR = 100;
    uint256 public constant FUNDING_SCALE = 1e18;
    /// @dev Collateral units for 1 cent on one size unit: 1e4 units per cent per MWh / 1,000.
    uint256 internal constant UNITS_PER_CENT_SIZE = 10;
    /// @dev Virtual shares and assets against share-price manipulation of an empty pool.
    uint256 internal constant VIRTUAL_SHARES = 1e3;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    IERC20 public immutable collateral;
    LivePriceFeed public immutable feed;
    bytes32 public immutable feedId;
    int64 public immutable floorCents;
    int64 public immutable capCents;

    address public guardian;
    /// @notice While true no new positions open; closing and the pool keep working.
    bool public paused;
    uint256 public feeBps;
    uint256 public maxFundingCentsPerMwhHour;
    uint256 public orderTimeout;
    uint256 public maxPriceAge;
    uint256 public maxAccountSize;

    /// @notice Collateral that belongs to the pool, reserved or not.
    uint256 public poolCash;
    /// @notice Pool collateral set aside for open positions and pending opens.
    uint256 public totalReserved;
    /// @notice Collateral posted by traders for open positions.
    uint256 public traderCollateral;
    /// @notice Collateral held for pending open orders.
    uint256 public orderEscrow;

    uint256 public longSize;
    uint256 public shortSize;
    int256 public longEntrySum;
    int256 public shortEntrySum;
    uint256 public cumulativeFundingLong;
    uint256 public cumulativeFundingShort;
    uint256 public lastFundingAt;

    mapping(address account => uint256) public accountSize;
    mapping(uint256 orderId => Order) internal orders;
    mapping(uint256 positionId => Position) internal positions;
    uint256 public nextOrderId = 1;
    uint256 public nextPositionId = 1;

    error ZeroAddress();
    error InvalidBand(int64 floorCents, int64 capCents);
    error InvalidCollateralDecimals(uint8 decimals);
    error InvalidSetting();
    error OwnershipCannotBeRenounced();
    error UnauthorizedGuardian(address caller);
    error MarketPaused();
    error SizeTooSmall(uint256 size);
    error AcceptablePriceOutsideBand(int64 acceptablePriceCents);
    error AccountLimit(uint256 wouldHold, uint256 limit);
    error PoolCannotCoverPosition(uint256 needed, uint256 free);
    error NotYourOrder(uint256 orderId);
    error NotYourPosition(uint256 positionId);
    error OrderNotPending(uint256 orderId);
    error PositionNotOpen(uint256 positionId);
    error CloseAlreadyPending(uint256 positionId);
    error FeedIsPaused();
    error NotTheFillRound(uint256 orderId, uint64 roundId);
    error OrderCannotBeCancelledYet(uint256 orderId);
    error ZeroAmount();
    error FreeLiquidityTooLow(uint256 requested, uint256 free);

    event OrderRequested(
        uint256 indexed orderId,
        address indexed account,
        bool isOpen,
        bool isLong,
        uint256 size,
        int64 acceptablePriceCents,
        uint256 positionId
    );
    event OrderCancelled(uint256 indexed orderId, string reason);
    event PositionOpened(
        uint256 indexed positionId,
        uint256 indexed orderId,
        address indexed account,
        bool isLong,
        uint256 size,
        int64 entryPriceCents,
        uint256 collateral,
        uint256 reserve,
        uint256 fee,
        uint64 roundId
    );
    event PositionClosed(
        uint256 indexed positionId,
        uint256 indexed orderId,
        address indexed account,
        int64 exitPriceCents,
        int256 pnl,
        uint256 funding,
        uint256 fee,
        uint256 payout,
        uint64 roundId
    );
    event Deposited(address indexed provider, uint256 assets, uint256 shares);
    event Withdrawn(address indexed provider, uint256 assets, uint256 shares);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event SettingsChanged(
        uint256 feeBps,
        uint256 maxFundingCentsPerMwhHour,
        uint256 orderTimeout,
        uint256 maxPriceAge,
        uint256 maxAccountSize
    );
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    constructor(
        address owner_,
        address guardian_,
        IERC20 collateral_,
        LivePriceFeed feed_,
        bytes32 feedId_,
        int64 floorCents_,
        int64 capCents_
    ) ERC20("GRIDFLEX TXPOWER-PERP pool share", "gfPERP-LP") Ownable(owner_) {
        if (
            guardian_ == address(0) || address(collateral_) == address(0)
                || address(feed_) == address(0) || feedId_ == bytes32(0)
        ) revert ZeroAddress();
        if (floorCents_ >= capCents_) revert InvalidBand(floorCents_, capCents_);
        uint8 collateralDecimals = IERC20Metadata(address(collateral_)).decimals();
        if (collateralDecimals != 6) revert InvalidCollateralDecimals(collateralDecimals);

        collateral = collateral_;
        feed = feed_;
        feedId = feedId_;
        floorCents = floorCents_;
        capCents = capCents_;
        guardian = guardian_;
        feeBps = 10; // 0.10%
        maxFundingCentsPerMwhHour = 1;
        orderTimeout = 15 minutes;
        maxPriceAge = 15 minutes;
        maxAccountSize = 1000 * SIZE_PER_MWH;
        lastFundingAt = block.timestamp;
        emit GuardianChanged(address(0), guardian_);
    }

    /// @notice Pool shares carry 9 decimals: 6 from the collateral and 3 from VIRTUAL_SHARES.
    function decimals() public pure override returns (uint8) {
        return 9;
    }

    // ------------------------------------------------------------------ orders

    /// @notice Asks to open a position. The fill price is the index at the first price round
    ///         published after this call; the order cancels if that price is beyond
    ///         acceptablePriceCents (the most a long pays, the least a short sells at).
    /// @dev Escrows the largest collateral and fee the fill can need and reserves the pool's
    ///      largest possible share, so nothing the trader does later can stop a fill.
    function requestOpen(bool isLong, uint256 size, int64 acceptablePriceCents)
        external
        nonReentrant
        returns (uint256 orderId)
    {
        if (paused) revert MarketPaused();
        if (size < MIN_SIZE) revert SizeTooSmall(size);
        if (acceptablePriceCents <= floorCents || acceptablePriceCents >= capCents) {
            revert AcceptablePriceOutsideBand(acceptablePriceCents);
        }
        uint256 wouldHold = accountSize[msg.sender] + size;
        if (wouldHold > maxAccountSize) revert AccountLimit(wouldHold, maxAccountSize);

        uint256 reserveHeld = _value(size, capCents - floorCents);
        uint256 free = poolCash - totalReserved;
        if (reserveHeld > free) revert PoolCannotCoverPosition(reserveHeld, free);

        int64 worstMove =
            isLong ? acceptablePriceCents - floorCents : capCents - acceptablePriceCents;
        uint256 escrow = _value(size, worstMove) + _maxFee(size);

        orderId = nextOrderId++;
        orders[orderId] = Order({
            account: msg.sender,
            createdAt: uint64(block.timestamp),
            pending: true,
            isOpen: true,
            isLong: isLong,
            acceptablePriceCents: acceptablePriceCents,
            size: size,
            positionId: 0,
            escrow: escrow,
            reserveHeld: reserveHeld
        });
        // the account limit counts pending opens too
        accountSize[msg.sender] = wouldHold;
        totalReserved += reserveHeld;
        orderEscrow += escrow;

        collateral.safeTransferFrom(msg.sender, address(this), escrow);
        emit OrderRequested(orderId, msg.sender, true, isLong, size, acceptablePriceCents, 0);
    }

    /// @notice Asks to close a whole position at the first price round published after now.
    function requestClose(uint256 positionId) external nonReentrant returns (uint256 orderId) {
        Position storage position = positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        if (position.account != msg.sender) revert NotYourPosition(positionId);
        if (position.closeOrderId != 0) revert CloseAlreadyPending(positionId);

        orderId = nextOrderId++;
        orders[orderId] = Order({
            account: msg.sender,
            createdAt: uint64(block.timestamp),
            pending: true,
            isOpen: false,
            isLong: position.isLong,
            acceptablePriceCents: 0,
            size: position.size,
            positionId: positionId,
            escrow: 0,
            reserveHeld: 0
        });
        position.closeOrderId = orderId;
        emit OrderRequested(
            orderId, msg.sender, false, position.isLong, position.size, 0, positionId
        );
    }

    /// @notice Fills an order at its fill round: the first round of the feed published
    ///         after the order. Anyone may call it (a keeper bot, or the trader).
    /// @dev An open order that cannot fill at that round (no index across a gap, a price
    ///      beyond the trader's limit or on a band edge, or the market paused since) is
    ///      cancelled and refunded. A close that cannot fill is dropped; ask again.
    function executeOrder(uint256 orderId, uint64 roundId) external nonReentrant {
        Order storage order = orders[orderId];
        if (!order.pending) revert OrderNotPending(orderId);
        if (feed.paused()) revert FeedIsPaused();
        _checkFillRound(orderId, order.createdAt, roundId);

        int64 priceCents;
        try feed.indexAt(feedId, roundId) returns (int64 indexCents) {
            priceCents = _clamp(indexCents);
        } catch {
            _cancel(orderId, order, "no index at the fill round");
            return;
        }

        if (order.isOpen) {
            _fillOpen(orderId, order, priceCents, roundId);
        } else {
            _fillClose(orderId, order, priceCents, roundId);
        }
    }

    /// @notice Lets a trader take back a pending order while the feed is paused, or when no
    ///         price round has been published within orderTimeout of the order.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (!order.pending) revert OrderNotPending(orderId);
        if (order.account != msg.sender) revert NotYourOrder(orderId);
        if (!feed.paused()) {
            bool timedOut = block.timestamp >= uint256(order.createdAt) + orderTimeout;
            if (!timedOut || _roundPublishedAfter(order.createdAt)) {
                revert OrderCannotBeCancelledYet(orderId);
            }
        }
        _cancel(orderId, order, "cancelled by trader");
    }

    // ------------------------------------------------------------------ pool

    /// @notice Adds collateral to the pool for shares priced at the pool's current value.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = assets * (totalSupply() + VIRTUAL_SHARES) / (poolValue() + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        poolCash += assets;
        _mint(msg.sender, shares);
        collateral.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Burns shares for collateral at the pool's current value, from the part of
    ///         the pool that no position or pending order has reserved.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        assets = shares * (poolValue() + VIRTUAL_ASSETS) / (totalSupply() + VIRTUAL_SHARES);
        uint256 free = poolCash - totalReserved;
        if (assets > free) revert FreeLiquidityTooLow(assets, free);
        _burn(msg.sender, shares);
        poolCash -= assets;
        collateral.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice The pool's cash minus what traders are up on open positions at the latest
    ///         index. Needs a fresh index while positions are open.
    /// @dev Traders' gains are capped by their reserves, which are part of poolCash, so the
    ///      value never goes below zero. Funding owed to the pool is left out (conservative).
    function poolValue() public view returns (uint256) {
        if (longSize == 0 && shortSize == 0) return poolCash;
        (int64 indexCents,,) = feed.latestIndex(feedId, maxPriceAge);
        int256 price = int256(_clamp(indexCents));
        int256 traderPnlUnits =
            (int256(longSize) * price - longEntrySum) + (shortEntrySum - int256(shortSize) * price);
        int256 value = int256(poolCash) - traderPnlUnits * int256(UNITS_PER_CENT_SIZE);
        // forge-lint: disable-next-line(unsafe-typecast)
        return value > 0 ? uint256(value) : 0;
    }

    // ------------------------------------------------------------------ views

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    /// @notice Funding a position owes so far, in collateral units, before any new accrual.
    function fundingOwed(uint256 positionId) public view returns (uint256) {
        Position storage position = positions[positionId];
        (uint256 cumLong, uint256 cumShort) = _projectedFunding();
        uint256 cumulative = position.isLong ? cumLong : cumShort;
        return
            position.size * (cumulative - position.fundingEntry) * UNITS_PER_CENT_SIZE
                / FUNDING_SCALE;
    }

    /// @notice The current funding rate: positive when longs pay, negative when shorts pay,
    ///         in cents per MWh per hour, scaled by FUNDING_SCALE.
    function fundingRate() external view returns (int256) {
        uint256 total = longSize + shortSize;
        if (total == 0 || longSize == shortSize) return 0;
        uint256 skew = longSize > shortSize ? longSize - shortSize : shortSize - longSize;
        int256 rate = int256(maxFundingCentsPerMwhHour * FUNDING_SCALE * skew / total);
        return longSize > shortSize ? rate : -rate;
    }

    // ------------------------------------------------------------------ settings and keys

    function setSettings(
        uint256 feeBps_,
        uint256 maxFundingCentsPerMwhHour_,
        uint256 orderTimeout_,
        uint256 maxPriceAge_,
        uint256 maxAccountSize_
    ) external onlyOwner {
        if (
            feeBps_ > MAX_FEE_BPS || maxFundingCentsPerMwhHour_ > MAX_FUNDING_CENTS_PER_MWH_HOUR
                || orderTimeout_ < 1 minutes || orderTimeout_ > 1 days || maxPriceAge_ < 1 minutes
                || maxPriceAge_ > 1 hours || maxAccountSize_ < MIN_SIZE
        ) revert InvalidSetting();
        _accrueFunding();
        feeBps = feeBps_;
        maxFundingCentsPerMwhHour = maxFundingCentsPerMwhHour_;
        orderTimeout = orderTimeout_;
        maxPriceAge = maxPriceAge_;
        maxAccountSize = maxAccountSize_;
        emit SettingsChanged(
            feeBps_, maxFundingCentsPerMwhHour_, orderTimeout_, maxPriceAge_, maxAccountSize_
        );
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Stops new positions; closes, fills of closes and the pool keep working.
    function pause() external onlyGuardianOrOwner {
        if (!paused) {
            paused = true;
            emit Paused(msg.sender);
        }
    }

    function unpause() external onlyOwner {
        if (paused) {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ------------------------------------------------------------------ internals

    function _fillOpen(uint256 orderId, Order storage order, int64 priceCents, uint64 roundId)
        private
    {
        if (paused) {
            _cancel(orderId, order, "market paused");
            return;
        }
        if (priceCents <= floorCents || priceCents >= capCents) {
            _cancel(orderId, order, "price on a band edge");
            return;
        }
        if (order.isLong
                ? priceCents > order.acceptablePriceCents
                : priceCents < order.acceptablePriceCents) {
            _cancel(orderId, order, "price beyond the limit");
            return;
        }

        _accrueFunding();
        uint256 positionId = nextPositionId++;
        Position storage position = positions[positionId];
        position.account = order.account;
        position.open = true;
        position.isLong = order.isLong;
        position.entryPriceCents = priceCents;
        position.size = order.size;
        position.collateral =
            _value(order.size, order.isLong ? priceCents - floorCents : capCents - priceCents);
        position.reserve =
            _value(order.size, order.isLong ? capCents - priceCents : priceCents - floorCents);
        position.fundingEntry = order.isLong ? cumulativeFundingLong : cumulativeFundingShort;

        uint256 fee = _fee(order.size, priceCents);
        // the escrow and reserve were sized for the worst fill, so these always hold
        assert(position.collateral + fee <= order.escrow && position.reserve <= order.reserveHeld);

        if (order.isLong) {
            longSize += order.size;
            longEntrySum += int256(order.size) * priceCents;
        } else {
            shortSize += order.size;
            shortEntrySum += int256(order.size) * priceCents;
        }
        order.pending = false;
        order.positionId = positionId;
        orderEscrow -= order.escrow;
        totalReserved = totalReserved - order.reserveHeld + position.reserve;
        traderCollateral += position.collateral;
        poolCash += fee;

        uint256 refund = order.escrow - position.collateral - fee;
        if (refund > 0) collateral.safeTransfer(order.account, refund);
        _emitOpened(positionId, orderId, fee, roundId);
    }

    function _emitOpened(uint256 positionId, uint256 orderId, uint256 fee, uint64 roundId) private {
        Position storage position = positions[positionId];
        emit PositionOpened(
            positionId,
            orderId,
            position.account,
            position.isLong,
            position.size,
            position.entryPriceCents,
            position.collateral,
            position.reserve,
            fee,
            roundId
        );
    }

    function _fillClose(uint256 orderId, Order storage order, int64 priceCents, uint64 roundId)
        private
    {
        uint256 positionId = order.positionId;
        Position storage position = positions[positionId];
        _accrueFunding();
        (int256 pnl, uint256 funding, uint256 fee, uint256 payout) =
            _closeAmounts(position, priceCents);

        if (position.isLong) {
            longSize -= position.size;
            longEntrySum -= int256(position.size) * position.entryPriceCents;
        } else {
            shortSize -= position.size;
            shortEntrySum -= int256(position.size) * position.entryPriceCents;
        }
        accountSize[position.account] -= position.size;
        traderCollateral -= position.collateral;
        totalReserved -= position.reserve;
        poolCash = poolCash + position.collateral - payout;
        position.open = false;
        position.closeOrderId = 0;
        order.pending = false;

        if (payout > 0) collateral.safeTransfer(position.account, payout);
        emit PositionClosed(
            positionId, orderId, position.account, priceCents, pnl, funding, fee, payout, roundId
        );
    }

    /// @dev What closing a position at priceCents pays: its gain or loss, the funding it
    ///      owes, the close fee, and the payout, which never goes below zero.
    function _closeAmounts(Position storage position, int64 priceCents)
        private
        view
        returns (int256 pnl, uint256 funding, uint256 fee, uint256 payout)
    {
        int256 move = position.isLong
            ? int256(priceCents) - position.entryPriceCents
            : int256(position.entryPriceCents) - priceCents;
        pnl = int256(position.size) * move * int256(UNITS_PER_CENT_SIZE);
        uint256 cumulative = position.isLong ? cumulativeFundingLong : cumulativeFundingShort;
        funding = position.size * (cumulative - position.fundingEntry) * UNITS_PER_CENT_SIZE
            / FUNDING_SCALE;
        fee = _fee(position.size, priceCents);
        int256 equity = int256(position.collateral) + pnl - int256(funding) - int256(fee);
        // forge-lint: disable-next-line(unsafe-typecast)
        payout = equity > 0 ? uint256(equity) : 0;
        // the band caps pnl at the reserve, so the pot always covers the payout
        assert(payout <= position.collateral + position.reserve);
    }

    function _cancel(uint256 orderId, Order storage order, string memory reason) private {
        order.pending = false;
        if (order.isOpen) {
            accountSize[order.account] -= order.size;
            totalReserved -= order.reserveHeld;
            orderEscrow -= order.escrow;
            collateral.safeTransfer(order.account, order.escrow);
        } else {
            positions[order.positionId].closeOrderId = 0;
        }
        emit OrderCancelled(orderId, reason);
    }

    /// @dev The fill round is the first round published strictly after the order: a round
    ///      in the order's own block (which the trader could have seen coming) never counts.
    function _checkFillRound(uint256 orderId, uint64 createdAt, uint64 roundId) private view {
        LivePriceFeed.Round memory round = feed.getRound(feedId, roundId);
        if (round.publishedAt <= createdAt) revert NotTheFillRound(orderId, roundId);
        if (roundId > 1 && feed.getRound(feedId, roundId - 1).publishedAt > createdAt) {
            revert NotTheFillRound(orderId, roundId);
        }
    }

    function _roundPublishedAfter(uint64 createdAt) private view returns (bool) {
        uint64 latest = feed.latestRoundId(feedId);
        return latest != 0 && feed.getRound(feedId, latest).publishedAt > createdAt;
    }

    function _accrueFunding() private {
        (cumulativeFundingLong, cumulativeFundingShort) = _projectedFunding();
        lastFundingAt = block.timestamp;
    }

    function _projectedFunding() private view returns (uint256 cumLong, uint256 cumShort) {
        cumLong = cumulativeFundingLong;
        cumShort = cumulativeFundingShort;
        uint256 total = longSize + shortSize;
        uint256 elapsed = block.timestamp - lastFundingAt;
        if (elapsed == 0 || total == 0 || longSize == shortSize) return (cumLong, cumShort);
        uint256 skew = longSize > shortSize ? longSize - shortSize : shortSize - longSize;
        uint256 delta =
            maxFundingCentsPerMwhHour * FUNDING_SCALE * skew * elapsed / (total * 1 hours);
        if (longSize > shortSize) cumLong += delta;
        else cumShort += delta;
    }

    function _clamp(int64 priceCents) private view returns (int64) {
        if (priceCents < floorCents) return floorCents;
        if (priceCents > capCents) return capCents;
        return priceCents;
    }

    /// @dev Collateral units for `size` thousandths of a MWh moving `cents` per MWh (>= 0).
    function _value(uint256 size, int64 cents) private pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return size * uint256(uint64(cents)) * UNITS_PER_CENT_SIZE;
    }

    function _fee(uint256 size, int64 priceCents) private view returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 absPrice = uint256(uint64(priceCents < 0 ? -priceCents : priceCents));
        return size * absPrice * UNITS_PER_CENT_SIZE * feeBps / BPS;
    }

    function _maxFee(uint256 size) private view returns (uint256) {
        int64 widest = capCents > -floorCents ? capCents : -floorCents;
        return _fee(size, widest);
    }
}
