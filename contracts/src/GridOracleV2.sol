// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title GRIDFLEX oracle for daily ERCOT metrics, version 2
/// @notice The same readings, functions, events and views as GridOracle
///         (shared/oracle-interface.md), so BinaryMarket and every script use it unchanged.
///         What v2 adds is a way back from a leaked key (shared/oracle-v2.md):
///         - the owner, a key that never goes online (a hardware wallet or a Safe), can
///           replace the reporter and the guardian;
///         - the guardian, or the owner, can pause the oracle and void a reading that is not
///           final yet; only the owner unpauses;
///         - a reading is refused until its market day has ended.
contract GridOracleV2 is Ownable2Step {
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

    uint64 public immutable disputeWindow;
    address public reporter;
    address public guardian;
    bool public paused;
    mapping(bytes32 metricId => mapping(uint32 dayKey => Reading)) private _readings;

    error UnauthorizedReporter(address caller);
    error UnauthorizedGuardian(address caller);
    error ZeroReporter();
    error ZeroGuardian();
    error ReporterIsOwner();
    error ReporterIsGuardian();
    error OwnershipCannotBeRenounced();
    error OraclePaused();
    error InvalidMetricId();
    error InvalidDayKey();
    error InvalidSourceHash();
    error InvalidMarketDay(uint64 marketDayStartUtc, uint64 marketDayEndUtc);
    error MarketDayNotOver(uint64 marketDayEndUtc);
    error ReadingNotFound(bytes32 metricId, uint32 dayKey);
    error ReadingAlreadyFinalized(bytes32 metricId, uint32 dayKey);
    error DisputeWindowOpen(uint256 finalizableAt);

    event ReadingSubmitted(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, bytes32 sourceHash
    );
    event ReadingFinalized(bytes32 indexed metricId, uint32 indexed dayKey);
    event ReadingVoided(
        bytes32 indexed metricId, uint32 indexed dayKey, int256 value, address indexed by
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
        if (paused) revert OraclePaused();
        _;
    }

    constructor(address owner_, address reporter_, address guardian_, uint64 disputeWindow_)
        Ownable(owner_)
    {
        _checkRoles(owner_, reporter_, guardian_);
        reporter = reporter_;
        guardian = guardian_;
        disputeWindow = disputeWindow_;
        emit ReporterChanged(address(0), reporter_);
        emit GuardianChanged(address(0), guardian_);
    }

    /// @notice Creates a reading or replaces an unfinalized reading with a corrected value.
    /// @dev Updating a reading restarts its dispute window. A reading for a market day that
    ///      has not ended yet is refused: no value can be known before then.
    function submitReading(
        bytes32 metricId,
        uint32 dayKey,
        uint64 marketDayStartUtc,
        uint64 marketDayEndUtc,
        int256 value,
        bytes32 sourceHash
    ) external onlyReporter whenNotPaused {
        if (metricId == bytes32(0)) revert InvalidMetricId();
        if (dayKey == 0) revert InvalidDayKey();
        if (sourceHash == bytes32(0)) revert InvalidSourceHash();
        if (marketDayEndUtc <= marketDayStartUtc) {
            revert InvalidMarketDay(marketDayStartUtc, marketDayEndUtc);
        }
        if (block.timestamp < marketDayEndUtc) revert MarketDayNotOver(marketDayEndUtc);

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
    /// @dev Anyone may finalize an eligible reading, except while the oracle is paused.
    function finalize(bytes32 metricId, uint32 dayKey) external whenNotPaused {
        Reading storage reading = _readings[metricId][dayKey];
        if (reading.publishedAt == 0) revert ReadingNotFound(metricId, dayKey);
        if (reading.finalized) revert ReadingAlreadyFinalized(metricId, dayKey);

        uint256 finalizableAt = uint256(reading.publishedAt) + disputeWindow;
        if (block.timestamp < finalizableAt) revert DisputeWindowOpen(finalizableAt);

        reading.finalized = true;
        emit ReadingFinalized(metricId, dayKey);
    }

    /// @notice Deletes a reading that is not final yet, so no market can resolve on it.
    /// @dev Works while paused: pause first, so nobody can finalize the bad value meanwhile.
    ///      Afterwards getReading returns an empty reading, as if none had been published.
    function voidReading(bytes32 metricId, uint32 dayKey) external onlyGuardianOrOwner {
        Reading storage reading = _readings[metricId][dayKey];
        if (reading.publishedAt == 0) revert ReadingNotFound(metricId, dayKey);
        if (reading.finalized) revert ReadingAlreadyFinalized(metricId, dayKey);

        int256 value = reading.value;
        delete _readings[metricId][dayKey];
        emit ReadingVoided(metricId, dayKey, value, msg.sender);
    }

    /// @notice Stops new readings and finalizing until the owner unpauses.
    function pause() external onlyGuardianOrOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Replaces the reporter, for example after its key leaked. Readings the old
    ///         reporter submitted stay until finalized or voided: void any bad one first.
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

    /// @dev The reporter is the online key, so it can never become the owner: checked when
    ///      ownership is offered and again when it is accepted.
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

    function getReading(bytes32 metricId, uint32 dayKey) external view returns (Reading memory) {
        return _readings[metricId][dayKey];
    }

    function isFinal(bytes32 metricId, uint32 dayKey) external view returns (bool) {
        return _readings[metricId][dayKey].finalized;
    }

    function _checkRoles(address owner_, address reporter_, address guardian_) private pure {
        if (reporter_ == address(0)) revert ZeroReporter();
        if (guardian_ == address(0)) revert ZeroGuardian();
        if (reporter_ == owner_) revert ReporterIsOwner();
        if (reporter_ == guardian_) revert ReporterIsGuardian();
    }
}
