// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title GRIDFLEX oracle for daily ERCOT metrics
/// @notice Stores reporter-submitted readings that become immutable after a dispute window.
contract GridOracle {
    struct Reading {
        bytes32 metricId;
        uint32 dayKey;
        uint64 marketDayStartUtc;
        uint64 marketDayEndUtc;
        int256 value;
        bytes32 sourceHash;
        uint64 publishedAt;
        bool finalized;
    }

    address public immutable reporter;
    uint64 public immutable disputeWindow;
    mapping(bytes32 metricId => mapping(uint32 dayKey => Reading)) private _readings;

    error UnauthorizedReporter(address caller);
    error ZeroReporter();
    error InvalidMetricId();
    error InvalidDayKey();
    error InvalidSourceHash();
    error InvalidMarketDay(uint64 marketDayStartUtc, uint64 marketDayEndUtc);
    error ReadingNotFound(bytes32 metricId, uint32 dayKey);
    error ReadingAlreadyFinalized(bytes32 metricId, uint32 dayKey);
    error DisputeWindowOpen(uint256 finalizableAt);

    event ReadingSubmitted(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, bytes32 sourceHash
    );
    event ReadingFinalized(bytes32 indexed metricId, uint32 indexed dayKey);

    modifier onlyReporter() {
        if (msg.sender != reporter) revert UnauthorizedReporter(msg.sender);
        _;
    }

    constructor(address reporter_, uint64 disputeWindow_) {
        if (reporter_ == address(0)) revert ZeroReporter();
        reporter = reporter_;
        disputeWindow = disputeWindow_;
    }

    /// @notice Creates a reading or replaces an unfinalized reading with a corrected value.
    /// @dev Updating a reading restarts its dispute window.
    function submitReading(
        bytes32 metricId,
        uint32 dayKey,
        uint64 marketDayStartUtc,
        uint64 marketDayEndUtc,
        int256 value,
        bytes32 sourceHash
    ) external onlyReporter {
        if (metricId == bytes32(0)) revert InvalidMetricId();
        if (dayKey == 0) revert InvalidDayKey();
        if (sourceHash == bytes32(0)) revert InvalidSourceHash();
        if (marketDayEndUtc <= marketDayStartUtc) {
            revert InvalidMarketDay(marketDayStartUtc, marketDayEndUtc);
        }

        Reading storage current = _readings[metricId][dayKey];
        if (current.finalized) revert ReadingAlreadyFinalized(metricId, dayKey);

        _readings[metricId][dayKey] = Reading({
            metricId: metricId,
            dayKey: dayKey,
            marketDayStartUtc: marketDayStartUtc,
            marketDayEndUtc: marketDayEndUtc,
            value: value,
            sourceHash: sourceHash,
            publishedAt: uint64(block.timestamp),
            finalized: false
        });

        emit ReadingSubmitted(metricId, dayKey, value, sourceHash);
    }

    /// @notice Makes a reading immutable after its dispute window has elapsed.
    /// @dev Anyone may finalize an eligible reading.
    function finalize(bytes32 metricId, uint32 dayKey) external {
        Reading storage reading = _readings[metricId][dayKey];
        if (reading.publishedAt == 0) revert ReadingNotFound(metricId, dayKey);
        if (reading.finalized) revert ReadingAlreadyFinalized(metricId, dayKey);

        uint256 finalizableAt = uint256(reading.publishedAt) + disputeWindow;
        if (block.timestamp < finalizableAt) revert DisputeWindowOpen(finalizableAt);

        reading.finalized = true;
        emit ReadingFinalized(metricId, dayKey);
    }

    function getReading(bytes32 metricId, uint32 dayKey) external view returns (Reading memory) {
        return _readings[metricId][dayKey];
    }

    function isFinal(bytes32 metricId, uint32 dayKey) external view returns (bool) {
        return _readings[metricId][dayKey].finalized;
    }
}
