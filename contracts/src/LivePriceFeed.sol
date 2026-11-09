// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title GRIDFLEX live price feed
/// @notice Five-minute ERCOT real-time prices, published by a bot, for the perpetual futures
///         and the options quotes (GRIDFLEX Trading Platform Plan, "The live Texas price").
///         Each round is one five-minute interval: its price in cents per MWh, the interval's
///         end, and a hash of the source data. The GRIDFLEX Texas Live Index for a round is
///         the average of that round and the two before it, and exists only when the three
///         intervals are back to back: a missed interval means no index until three
///         consecutive rounds exist again, so markets go close-only instead of using a gap.
///         Keys, as in GridOracleV2:
///         - the owner, a key that never goes online, replaces the reporter and the guardian
///           and is the only one who can unpause;
///         - the reporter (the price bot) publishes and can be replaced if its key leaks;
///         - the guardian, or the owner, can pause the feed; while paused nothing is
///           published and no index is served.
///         Prices outside [minPriceCents, maxPriceCents] are refused; the bounds are fixed at
///         deploy to the market's own limits (ERCOT: -$251 floor, $5,000 cap).
contract LivePriceFeed is Ownable2Step {
    struct Round {
        int64 priceCents;
        uint64 intervalEnd;
        uint64 publishedAt;
        bytes32 sourceHash;
    }

    /// @notice Length of one interval in seconds; every intervalEnd is a multiple of it.
    uint64 public immutable interval;
    int64 public immutable minPriceCents;
    int64 public immutable maxPriceCents;
    /// @notice Rounds averaged into one index value.
    uint64 public constant INDEX_ROUNDS = 3;

    address public reporter;
    address public guardian;
    bool public paused;

    mapping(bytes32 feedId => uint64) public latestRoundId;
    mapping(bytes32 feedId => mapping(uint64 roundId => Round)) private _rounds;

    error UnauthorizedReporter(address caller);
    error UnauthorizedGuardian(address caller);
    error ZeroReporter();
    error ZeroGuardian();
    error ReporterIsOwner();
    error ReporterIsGuardian();
    error OwnershipCannotBeRenounced();
    error FeedPaused();
    error InvalidFeedId();
    error InvalidSourceHash();
    error InvalidInterval();
    error InvalidPriceBounds(int64 minPriceCents, int64 maxPriceCents);
    error PriceOutOfBounds(int64 priceCents);
    error IntervalNotAligned(uint64 intervalEnd);
    error IntervalNotOver(uint64 intervalEnd);
    error IntervalNotAfterLatest(uint64 intervalEnd, uint64 latestIntervalEnd);
    error RoundNotFound(bytes32 feedId, uint64 roundId);
    error IndexGap(bytes32 feedId, uint64 roundId);
    error StalePrice(uint64 intervalEnd, uint256 maxAge);

    event PriceSubmitted(
        bytes32 indexed feedId,
        uint64 indexed roundId,
        uint64 intervalEnd,
        int64 priceCents,
        bytes32 sourceHash
    );
    event ReporterChanged(address indexed previousReporter, address indexed newReporter);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyReporter() {
        if (msg.sender != reporter) revert UnauthorizedReporter(msg.sender);
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert FeedPaused();
        _;
    }

    constructor(
        address owner_,
        address reporter_,
        address guardian_,
        uint64 interval_,
        int64 minPriceCents_,
        int64 maxPriceCents_
    ) Ownable(owner_) {
        _checkRoles(owner_, reporter_, guardian_);
        if (interval_ == 0) revert InvalidInterval();
        if (minPriceCents_ >= maxPriceCents_) {
            revert InvalidPriceBounds(minPriceCents_, maxPriceCents_);
        }
        reporter = reporter_;
        guardian = guardian_;
        interval = interval_;
        minPriceCents = minPriceCents_;
        maxPriceCents = maxPriceCents_;
        emit ReporterChanged(address(0), reporter_);
        emit GuardianChanged(address(0), guardian_);
    }

    // ------------------------------------------------------------------ publishing

    /// @notice Publishes the price of one finished interval as the feed's next round.
    /// @dev Intervals only move forward: a correction to a published round is impossible,
    ///      and a skipped interval stays a gap (see indexAt). Returns the new round's id.
    function submitPrice(bytes32 feedId, uint64 intervalEnd, int64 priceCents, bytes32 sourceHash)
        external
        onlyReporter
        whenNotPaused
        returns (uint64 roundId)
    {
        if (feedId == bytes32(0)) revert InvalidFeedId();
        if (sourceHash == bytes32(0)) revert InvalidSourceHash();
        if (intervalEnd == 0 || intervalEnd % interval != 0) {
            revert IntervalNotAligned(intervalEnd);
        }
        if (intervalEnd > block.timestamp) revert IntervalNotOver(intervalEnd);
        if (priceCents < minPriceCents || priceCents > maxPriceCents) {
            revert PriceOutOfBounds(priceCents);
        }

        uint64 previous = latestRoundId[feedId];
        if (previous != 0) {
            uint64 latestEnd = _rounds[feedId][previous].intervalEnd;
            if (intervalEnd <= latestEnd) revert IntervalNotAfterLatest(intervalEnd, latestEnd);
        }

        roundId = previous + 1;
        _rounds[feedId][roundId] = Round({
            priceCents: priceCents,
            intervalEnd: intervalEnd,
            publishedAt: uint64(block.timestamp),
            sourceHash: sourceHash
        });
        latestRoundId[feedId] = roundId;

        emit PriceSubmitted(feedId, roundId, intervalEnd, priceCents, sourceHash);
    }

    // ------------------------------------------------------------------ reading

    /// @notice One published round; reverts if it does not exist.
    function getRound(bytes32 feedId, uint64 roundId) public view returns (Round memory round) {
        round = _rounds[feedId][roundId];
        if (round.publishedAt == 0) revert RoundNotFound(feedId, roundId);
    }

    /// @notice The index at a round: the average of that round's price and the two before
    ///         it, rounded toward zero, in cents per MWh.
    /// @dev Reverts with IndexGap unless the three intervals are consecutive. Ignores pause,
    ///      so settled history stays readable; live consumers use latestIndex.
    function indexAt(bytes32 feedId, uint64 roundId) public view returns (int64 indexCents) {
        if (roundId < INDEX_ROUNDS) {
            getRound(feedId, roundId);
            revert IndexGap(feedId, roundId);
        }
        Round memory last = getRound(feedId, roundId);
        int256 sum = last.priceCents;
        uint64 expectedEnd = last.intervalEnd;
        for (uint64 i = 1; i < INDEX_ROUNDS; ++i) {
            Round memory earlier = _rounds[feedId][roundId - i];
            expectedEnd -= interval;
            if (earlier.intervalEnd != expectedEnd) revert IndexGap(feedId, roundId);
            sum += earlier.priceCents;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        indexCents = int64(sum / int256(uint256(INDEX_ROUNDS)));
    }

    /// @notice The index at the latest round, for live trading: reverts while paused, when
    ///         the latest interval ended more than maxAge seconds ago, or across a gap.
    function latestIndex(bytes32 feedId, uint256 maxAge)
        external
        view
        whenNotPaused
        returns (int64 indexCents, uint64 roundId, uint64 intervalEnd)
    {
        roundId = latestRoundId[feedId];
        if (roundId == 0) revert RoundNotFound(feedId, 0);
        intervalEnd = _rounds[feedId][roundId].intervalEnd;
        if (block.timestamp - intervalEnd > maxAge) revert StalePrice(intervalEnd, maxAge);
        indexCents = indexAt(feedId, roundId);
    }

    // ------------------------------------------------------------------ keys

    function setReporter(address newReporter) external onlyOwner {
        _checkRoles(owner(), newReporter, guardian);
        emit ReporterChanged(reporter, newReporter);
        reporter = newReporter;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        _checkRoles(owner(), reporter, newGuardian);
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

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

    /// @dev The reporter is the online key, so it can never become the owner: checked when
    ///      ownership is offered and again when it is accepted (as in GridOracleV2).
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == reporter) revert ReporterIsOwner();
        super.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == reporter) revert ReporterIsOwner();
        super._transferOwnership(newOwner);
    }

    /// @dev Without an owner a leaked reporter could never be replaced again.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function _checkRoles(address owner_, address reporter_, address guardian_) private pure {
        if (reporter_ == address(0)) revert ZeroReporter();
        if (guardian_ == address(0)) revert ZeroGuardian();
        if (reporter_ == owner_) revert ReporterIsOwner();
        if (reporter_ == guardian_) revert ReporterIsGuardian();
    }
}
