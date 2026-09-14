// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IGridOracle {
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

    function getReading(bytes32 metricId, uint32 dayKey) external view returns (Reading memory);

    function isFinal(bytes32 metricId, uint32 dayKey) external view returns (bool);
}
