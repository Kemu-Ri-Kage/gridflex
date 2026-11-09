// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IGridOracle } from "./interfaces/IGridOracle.sol";

/// @title Texas power options: European calls and puts on a day's average price
/// @notice GRIDFLEX Trading Platform Plan, "Market 2: options".
///         - An expiry is one Texas market day (dayKey). It trades until tradingCloseUtc and
///           settles on the oracle's final reading of `metricId` for that day, clamped to the
///           band [floorCents, capCents].
///         - A call pays max(settlement - strike, 0) per MWh, a put max(strike - settlement,
///           0). Strikes are multiples of strikeStepCents strictly inside the band.
///         - The pool writes every option. Buying locks the option's largest payout in the
///           pool (cap - strike for a call, strike - floor for a put), so every option is
///           fully backed. Holders can sell back to the pool at its bid before the close.
///         - A quote bot (the quoter) posts ask and bid premiums per strike as numbered
///           versions, and every pending order of that expiry fills or cancels inside the
///           same transaction. So an order fills at the first version posted after it,
///           never at a quote the trader could see, and nobody chooses when it executes.
///         - If the oracle has no final reading SETTLEMENT_GRACE after the close, anyone
///           can void the series and every holder gets back the premium they paid.
///         - In this first version only the owner funds the pool; public pool shares need
///           a mark-to-model value of open options and come later.
///         Sizes are thousandths of a MWh (1,000 = 1 MWh); prices are cents per MWh; the
///         collateral has 6 decimals, so 1 cent on 1 MWh is 10 units per size unit.
contract TexasPowerOptions is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Expiry {
        bool exists;
        uint64 tradingCloseUtc;
        uint64 quoteVersion;
    }

    /// @notice Premiums in cents per MWh; an ask of zero means "not offered".
    struct Quote {
        uint64 callAsk;
        uint64 callBid;
        uint64 putAsk;
        uint64 putBid;
    }

    struct Order {
        address account;
        uint64 createdAt;
        uint32 dayKey;
        bool pending;
        bool isBuy;
        bool isCall;
        int64 strikeCents;
        uint64 limitCents;
        uint256 size;
        /// @dev A buy's escrowed premium; for a sell, the premium basis the order carries.
        uint256 escrow;
    }

    struct Series {
        bool settled;
        bool voided;
        uint64 payoffCents;
        uint256 openSize;
        /// @notice Premium paid for the series' open options: what a void refunds.
        uint256 premiumOpen;
    }

    uint256 public constant SIZE_PER_MWH = 1000;
    uint256 public constant MIN_SIZE = 100;
    uint256 internal constant UNITS_PER_CENT_SIZE = 10;
    /// @notice Pending orders one expiry can hold, which bounds the quoter's gas.
    uint256 public constant MAX_PENDING = 100;
    /// @notice How long after the close a missing final reading lets anyone void a series.
    uint256 public constant SETTLEMENT_GRACE = 14 days;

    IERC20 public immutable collateral;
    IGridOracle public immutable oracle;
    bytes32 public immutable metricId;
    int64 public immutable floorCents;
    int64 public immutable capCents;
    int64 public immutable strikeStepCents;

    address public quoter;
    address public guardian;
    bool public paused;
    uint256 public orderTimeout;

    /// @notice Collateral that belongs to the pool, reserved or not.
    uint256 public poolCash;
    /// @notice Pool collateral locked as the largest payout of open options and pending buys.
    uint256 public totalReserved;
    /// @notice Premiums held for pending buys.
    uint256 public orderEscrow;
    /// @notice Settled payouts not claimed yet.
    uint256 public settledOwed;

    mapping(uint32 dayKey => Expiry) public expiries;
    mapping(uint32 dayKey => mapping(uint64 version => uint64)) public quoteTime;
    mapping(uint32 dayKey => mapping(uint64 version => mapping(int64 strike => Quote))) internal
        _quotes;
    mapping(bytes32 seriesId => Series) public series;
    mapping(bytes32 seriesId => mapping(address account => uint256)) public balanceOf;
    /// @notice Premium each holder paid for the options they still hold.
    mapping(bytes32 seriesId => mapping(address account => uint256)) public premiumPaid;
    mapping(uint256 orderId => Order) internal _orders;
    mapping(uint32 dayKey => uint256[]) internal _pending;
    uint256 public nextOrderId = 1;

    error ZeroAddress();
    error InvalidBand(int64 floorCents, int64 capCents);
    error InvalidStrikeStep(int64 strikeStepCents);
    error InvalidCollateralDecimals(uint8 decimals);
    error QuoterIsOwner();
    error OwnershipCannotBeRenounced();
    error InvalidSetting();
    error UnauthorizedQuoter(address caller);
    error UnauthorizedGuardian(address caller);
    error MarketPaused();
    error ExpiryExists(uint32 dayKey);
    error UnknownExpiry(uint32 dayKey);
    error TradingClosed(uint32 dayKey);
    error InvalidTradingClose(uint64 tradingCloseUtc);
    error InvalidStrike(int64 strikeCents);
    error InvalidQuote(int64 strikeCents);
    error LengthMismatch();
    error SizeTooSmall(uint256 size);
    error InvalidLimit(uint64 limitCents);
    error PoolCannotCover(uint256 needed, uint256 free);
    error NotEnoughOptions(uint256 held, uint256 wanted);
    error OrderNotPending(uint256 orderId);
    error NotYourOrder(uint256 orderId);
    error TooManyPendingOrders(uint32 dayKey);
    error OrderCannotBeCancelledYet(uint256 orderId);
    error NotFinal(uint32 dayKey);
    error SettlementStillPossible(uint32 dayKey);
    error GraceNotOver(uint256 voidableAt);
    error FreeCashTooLow(uint256 requested, uint256 free);

    event ExpiryOpened(uint32 indexed dayKey, uint64 tradingCloseUtc);
    event QuotesPosted(uint32 indexed dayKey, uint64 indexed version, uint256 strikes);
    event OrderRequested(
        uint256 indexed orderId,
        address indexed account,
        uint32 indexed dayKey,
        bool isBuy,
        bool isCall,
        int64 strikeCents,
        uint256 size,
        uint64 limitCents
    );
    event OrderFilled(uint256 indexed orderId, uint64 version, uint64 premiumCents, uint256 amount);
    event OrderCancelled(uint256 indexed orderId, string reason);
    event SeriesSettled(
        bytes32 indexed seriesId, uint32 indexed dayKey, uint64 payoffCents, uint256 owed
    );
    event SeriesVoided(bytes32 indexed seriesId, uint32 indexed dayKey, uint256 refunded);
    event Claimed(bytes32 indexed seriesId, address indexed account, uint256 amount);
    event PoolFunded(uint256 amount);
    event PoolDefunded(uint256 amount);
    event QuoterChanged(address indexed previousQuoter, address indexed newQuoter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyQuoter() {
        if (msg.sender != quoter) revert UnauthorizedQuoter(msg.sender);
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    constructor(
        address owner_,
        address quoter_,
        address guardian_,
        IERC20 collateral_,
        IGridOracle oracle_,
        bytes32 metricId_,
        int64 floorCents_,
        int64 capCents_,
        int64 strikeStepCents_
    ) Ownable(owner_) {
        if (
            quoter_ == address(0) || guardian_ == address(0) || address(collateral_) == address(0)
                || address(oracle_) == address(0) || metricId_ == bytes32(0)
        ) revert ZeroAddress();
        if (quoter_ == owner_) revert QuoterIsOwner();
        if (floorCents_ >= capCents_) revert InvalidBand(floorCents_, capCents_);
        if (strikeStepCents_ <= 0) revert InvalidStrikeStep(strikeStepCents_);
        uint8 collateralDecimals = IERC20Metadata(address(collateral_)).decimals();
        if (collateralDecimals != 6) revert InvalidCollateralDecimals(collateralDecimals);

        collateral = collateral_;
        oracle = oracle_;
        metricId = metricId_;
        floorCents = floorCents_;
        capCents = capCents_;
        strikeStepCents = strikeStepCents_;
        quoter = quoter_;
        guardian = guardian_;
        orderTimeout = 15 minutes;
        emit QuoterChanged(address(0), quoter_);
        emit GuardianChanged(address(0), guardian_);
    }

    // ------------------------------------------------------------------ quoter

    /// @notice Lists a market day for trading until tradingCloseUtc (midnight Texas time
    ///         when the day starts, per the plan).
    function openExpiry(uint32 dayKey, uint64 tradingCloseUtc) external onlyQuoter {
        if (expiries[dayKey].exists) revert ExpiryExists(dayKey);
        if (dayKey == 0 || tradingCloseUtc <= block.timestamp) {
            revert InvalidTradingClose(tradingCloseUtc);
        }
        expiries[dayKey] =
            Expiry({ exists: true, tradingCloseUtc: tradingCloseUtc, quoteVersion: 0 });
        emit ExpiryOpened(dayKey, tradingCloseUtc);
    }

    /// @notice Posts a new numbered version of the quotes for one expiry. Strikes left out
    ///         of a version are not offered in it.
    function postQuotes(uint32 dayKey, int64[] calldata strikes, Quote[] calldata quotes)
        external
        onlyQuoter
        returns (uint64 version)
    {
        if (paused) revert MarketPaused();
        Expiry storage expiry = _openExpiry(dayKey);
        if (strikes.length != quotes.length) revert LengthMismatch();

        version = ++expiry.quoteVersion;
        quoteTime[dayKey][version] = uint64(block.timestamp);
        for (uint256 i; i < strikes.length; ++i) {
            int64 strike = strikes[i];
            _checkStrike(strike);
            Quote calldata q = quotes[i];
            if (
                q.callBid > q.callAsk || q.putBid > q.putAsk
                    || q.callAsk > _maxPayoutCents(strike, true)
                    || q.putAsk > _maxPayoutCents(strike, false)
            ) revert InvalidQuote(strike);
            _quotes[dayKey][version][strike] = q;
        }
        emit QuotesPosted(dayKey, version, strikes.length);
        _fillPending(dayKey, version);
    }

    // ------------------------------------------------------------------ orders

    /// @notice Asks to buy options, paying at most maxPremiumCents per MWh. Escrows that
    ///         premium and locks the options' largest payout in the pool.
    function requestBuy(
        uint32 dayKey,
        int64 strikeCents,
        bool isCall,
        uint256 size,
        uint64 maxPremiumCents
    ) external nonReentrant returns (uint256 orderId) {
        if (paused) revert MarketPaused();
        _openExpiry(dayKey);
        _checkStrike(strikeCents);
        if (size < MIN_SIZE) revert SizeTooSmall(size);
        if (maxPremiumCents == 0 || maxPremiumCents > _maxPayoutCents(strikeCents, isCall)) {
            revert InvalidLimit(maxPremiumCents);
        }

        uint256 reserve = _value(size, _maxPayoutCents(strikeCents, isCall));
        uint256 free = poolCash - totalReserved;
        if (reserve > free) revert PoolCannotCover(reserve, free);
        uint256 escrow = _value(size, maxPremiumCents);

        orderId = _newOrder(dayKey, true, isCall, strikeCents, maxPremiumCents, size, escrow);
        totalReserved += reserve;
        orderEscrow += escrow;
        collateral.safeTransferFrom(msg.sender, address(this), escrow);
    }

    /// @notice Asks to sell options back to the pool for at least minPremiumCents per MWh.
    ///         The options are held by the order until it fills or is cancelled.
    function requestSell(
        uint32 dayKey,
        int64 strikeCents,
        bool isCall,
        uint256 size,
        uint64 minPremiumCents
    ) external nonReentrant returns (uint256 orderId) {
        _openExpiry(dayKey);
        if (size < MIN_SIZE) revert SizeTooSmall(size);
        bytes32 id = seriesId(dayKey, strikeCents, isCall);
        uint256 held = balanceOf[id][msg.sender];
        if (held < size) revert NotEnoughOptions(held, size);
        balanceOf[id][msg.sender] = held - size;
        // the sold options take their share of what was paid for them
        uint256 basis = premiumPaid[id][msg.sender] * size / held;
        premiumPaid[id][msg.sender] -= basis;
        orderId = _newOrder(dayKey, false, isCall, strikeCents, minPremiumCents, size, basis);
    }

    /// @notice Lets a trader take back a pending order while the market is paused, after
    ///         its expiry stopped trading (it can no longer fill), or when the quoter has
    ///         posted nothing for orderTimeout.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (!order.pending) revert OrderNotPending(orderId);
        if (order.account != msg.sender) revert NotYourOrder(orderId);
        bool closed = block.timestamp >= expiries[order.dayKey].tradingCloseUtc;
        bool timedOut = block.timestamp >= uint256(order.createdAt) + orderTimeout;
        if (!paused && !closed && !timedOut) revert OrderCannotBeCancelledYet(orderId);
        _cancel(orderId, order, "cancelled by trader");
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Fixes a series' payout from the oracle's final reading for its day and
    ///         frees the rest of its reserve. Anyone may call it; claim calls it too.
    function settleSeries(uint32 dayKey, int64 strikeCents, bool isCall) public {
        bytes32 id = seriesId(dayKey, strikeCents, isCall);
        Series storage s = series[id];
        if (s.settled || s.voided) return;
        if (!expiries[dayKey].exists) revert UnknownExpiry(dayKey);
        if (!oracle.isFinal(metricId, dayKey)) revert NotFinal(dayKey);

        int256 value = oracle.getReading(metricId, dayKey).value;
        int64 settlement = value < floorCents
            ? floorCents
            // forge-lint: disable-next-line(unsafe-typecast)
            : (value > capCents ? capCents : int64(value));
        int64 payoff = isCall ? settlement - strikeCents : strikeCents - settlement;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 payoffCents = payoff > 0 ? uint64(payoff) : 0;

        uint256 owed = _value(s.openSize, payoffCents);
        totalReserved -= _value(s.openSize, _maxPayoutCents(strikeCents, isCall));
        poolCash -= owed;
        settledOwed += owed;
        s.settled = true;
        s.payoffCents = payoffCents;
        emit SeriesSettled(id, dayKey, payoffCents, owed);
    }

    /// @notice Voids a series whose day has no final reading SETTLEMENT_GRACE after its
    ///         close: its reserve is freed and its holders get back the premium they paid.
    ///         Anyone may call it; claim calls it too. A final reading always settles
    ///         instead, even after the grace period.
    function voidSeries(uint32 dayKey, int64 strikeCents, bool isCall) public {
        bytes32 id = seriesId(dayKey, strikeCents, isCall);
        Series storage s = series[id];
        if (s.settled || s.voided) return;
        Expiry storage expiry = expiries[dayKey];
        if (!expiry.exists) revert UnknownExpiry(dayKey);
        if (oracle.isFinal(metricId, dayKey)) revert SettlementStillPossible(dayKey);
        uint256 voidableAt = uint256(expiry.tradingCloseUtc) + SETTLEMENT_GRACE;
        if (block.timestamp < voidableAt) revert GraceNotOver(voidableAt);

        // premiums never exceed the largest payout, so the freed reserve covers the refunds
        totalReserved -= _value(s.openSize, _maxPayoutCents(strikeCents, isCall));
        poolCash -= s.premiumOpen;
        settledOwed += s.premiumOpen;
        s.voided = true;
        emit SeriesVoided(id, dayKey, s.premiumOpen);
    }

    /// @notice Pays the caller's options: the payout of a settled series, or the premium
    ///         paid in a voided one. Settles or voids the series first if needed.
    function claim(uint32 dayKey, int64 strikeCents, bool isCall)
        external
        nonReentrant
        returns (uint256 amount)
    {
        bytes32 id = seriesId(dayKey, strikeCents, isCall);
        Series storage s = series[id];
        if (!s.settled && !s.voided) {
            if (oracle.isFinal(metricId, dayKey)) settleSeries(dayKey, strikeCents, isCall);
            else voidSeries(dayKey, strikeCents, isCall);
        }
        uint256 held = balanceOf[id][msg.sender];
        uint256 basis = premiumPaid[id][msg.sender];
        balanceOf[id][msg.sender] = 0;
        premiumPaid[id][msg.sender] = 0;
        amount = s.voided ? basis : _value(held, s.payoffCents);
        settledOwed -= amount;
        if (amount > 0) collateral.safeTransfer(msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------ pool (owner)

    function fundPool(uint256 amount) external onlyOwner nonReentrant {
        poolCash += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(amount);
    }

    function defundPool(uint256 amount) external onlyOwner nonReentrant {
        uint256 free = poolCash - totalReserved;
        if (amount > free) revert FreeCashTooLow(amount, free);
        poolCash -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit PoolDefunded(amount);
    }

    // ------------------------------------------------------------------ views

    function seriesId(uint32 dayKey, int64 strikeCents, bool isCall) public pure returns (bytes32) {
        return keccak256(abi.encode(dayKey, strikeCents, isCall));
    }

    function getQuote(uint32 dayKey, uint64 version, int64 strikeCents)
        external
        view
        returns (Quote memory)
    {
        return _quotes[dayKey][version][strikeCents];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function pendingOrders(uint32 dayKey) external view returns (uint256[] memory) {
        return _pending[dayKey];
    }

    // ------------------------------------------------------------------ keys

    function setQuoter(address newQuoter) external onlyOwner {
        if (newQuoter == address(0)) revert ZeroAddress();
        if (newQuoter == owner()) revert QuoterIsOwner();
        emit QuoterChanged(quoter, newQuoter);
        quoter = newQuoter;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    function setOrderTimeout(uint256 orderTimeout_) external onlyOwner {
        if (orderTimeout_ < 1 minutes || orderTimeout_ > 1 days) revert InvalidSetting();
        orderTimeout = orderTimeout_;
    }

    /// @notice Stops new quotes (so nothing fills) and new buys; traders can cancel pending
    ///         orders, and settlement and claims keep working.
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

    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == quoter) revert QuoterIsOwner();
        super.transferOwnership(newOwner);
    }

    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ------------------------------------------------------------------ internals

    function _newOrder(
        uint32 dayKey,
        bool isBuy,
        bool isCall,
        int64 strikeCents,
        uint64 limitCents,
        uint256 size,
        uint256 escrow
    ) private returns (uint256 orderId) {
        uint256[] storage queue = _pending[dayKey];
        if (queue.length >= MAX_PENDING) revert TooManyPendingOrders(dayKey);
        orderId = nextOrderId++;
        queue.push(orderId);
        _orders[orderId] = Order({
            account: msg.sender,
            createdAt: uint64(block.timestamp),
            dayKey: dayKey,
            pending: true,
            isBuy: isBuy,
            isCall: isCall,
            strikeCents: strikeCents,
            limitCents: limitCents,
            size: size,
            escrow: escrow
        });
        emit OrderRequested(
            orderId, msg.sender, dayKey, isBuy, isCall, strikeCents, size, limitCents
        );
    }

    /// @dev Fills or cancels every pending order of the expiry at this version, except
    ///      orders from this very block (the trader may have seen these quotes coming):
    ///      those wait for the next version. Orders cancelled meanwhile drop out.
    function _fillPending(uint32 dayKey, uint64 version) private {
        uint256[] memory queue = _pending[dayKey];
        delete _pending[dayKey];
        for (uint256 i; i < queue.length; ++i) {
            Order storage order = _orders[queue[i]];
            if (!order.pending) continue;
            if (order.createdAt >= block.timestamp) {
                _pending[dayKey].push(queue[i]);
                continue;
            }
            _tryFill(queue[i], order, version);
        }
    }

    function _tryFill(uint256 orderId, Order storage order, uint64 version) private {
        Quote storage q = _quotes[order.dayKey][version][order.strikeCents];
        uint64 premium = order.isBuy
            ? (order.isCall ? q.callAsk : q.putAsk)
            : (order.isCall ? q.callBid : q.putBid);
        if (premium == 0) {
            _cancel(orderId, order, "strike not quoted");
        } else if (order.isBuy ? premium > order.limitCents : premium < order.limitCents) {
            _cancel(orderId, order, "premium beyond the limit");
        } else if (order.isBuy) {
            _fillBuy(orderId, order, version, premium);
        } else {
            _fillSell(orderId, order, version, premium);
        }
    }

    function _fillBuy(uint256 orderId, Order storage order, uint64 version, uint64 premium)
        private
    {
        uint256 cost = _value(order.size, premium);
        uint256 refund = order.escrow - cost;
        order.pending = false;
        orderEscrow -= order.escrow;
        poolCash += cost;
        bytes32 id = seriesId(order.dayKey, order.strikeCents, order.isCall);
        balanceOf[id][order.account] += order.size;
        series[id].openSize += order.size;
        premiumPaid[id][order.account] += cost;
        series[id].premiumOpen += cost;
        // the reserve locked at request stays locked for the open options
        if (refund > 0) collateral.safeTransfer(order.account, refund);
        emit OrderFilled(orderId, version, premium, cost);
    }

    function _fillSell(uint256 orderId, Order storage order, uint64 version, uint64 premium)
        private
    {
        uint256 proceeds = _value(order.size, premium);
        order.pending = false;
        bytes32 id = seriesId(order.dayKey, order.strikeCents, order.isCall);
        series[id].openSize -= order.size;
        series[id].premiumOpen -= order.escrow;
        // a bid never exceeds the largest payout, so the freed reserve covers the proceeds
        totalReserved -= _value(order.size, _maxPayoutCents(order.strikeCents, order.isCall));
        poolCash -= proceeds;
        collateral.safeTransfer(order.account, proceeds);
        emit OrderFilled(orderId, version, premium, proceeds);
    }

    function _cancel(uint256 orderId, Order storage order, string memory reason) private {
        order.pending = false;
        if (order.isBuy) {
            totalReserved -= _value(order.size, _maxPayoutCents(order.strikeCents, order.isCall));
            orderEscrow -= order.escrow;
            collateral.safeTransfer(order.account, order.escrow);
        } else {
            bytes32 id = seriesId(order.dayKey, order.strikeCents, order.isCall);
            balanceOf[id][order.account] += order.size;
            premiumPaid[id][order.account] += order.escrow;
        }
        emit OrderCancelled(orderId, reason);
    }

    function _openExpiry(uint32 dayKey) private view returns (Expiry storage expiry) {
        expiry = expiries[dayKey];
        if (!expiry.exists) revert UnknownExpiry(dayKey);
        if (block.timestamp >= expiry.tradingCloseUtc) revert TradingClosed(dayKey);
    }

    function _checkStrike(int64 strikeCents) private view {
        if (
            strikeCents <= floorCents || strikeCents >= capCents
                || strikeCents % strikeStepCents != 0
        ) revert InvalidStrike(strikeCents);
    }

    function _maxPayoutCents(int64 strikeCents, bool isCall) private view returns (uint64) {
        // strikes sit strictly inside the band, so both differences are positive
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(isCall ? capCents - strikeCents : strikeCents - floorCents);
    }

    function _value(uint256 size, uint64 cents) private pure returns (uint256) {
        return size * cents * UNITS_PER_CENT_SIZE;
    }
}
