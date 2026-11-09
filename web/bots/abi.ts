/** The few contract functions the bots call (contracts/src/LivePriceFeed.sol, TexasPowerOptions.sol). */

export const livePriceFeedAbi = [
  {
    type: 'function',
    name: 'latestRoundId',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes32' }],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getRound',
    stateMutability: 'view',
    inputs: [
      { name: 'feedId', type: 'bytes32' },
      { name: 'roundId', type: 'uint64' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'priceCents', type: 'int64' },
          { name: 'intervalEnd', type: 'uint64' },
          { name: 'publishedAt', type: 'uint64' },
          { name: 'sourceHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'submitPrice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'feedId', type: 'bytes32' },
      { name: 'intervalEnd', type: 'uint64' },
      { name: 'priceCents', type: 'int64' },
      { name: 'sourceHash', type: 'bytes32' },
    ],
    outputs: [{ type: 'uint64' }],
  },
] as const;

export const texasPowerOptionsAbi = [
  {
    type: 'function',
    name: 'expiries',
    stateMutability: 'view',
    inputs: [{ name: 'dayKey', type: 'uint32' }],
    outputs: [
      { name: 'exists', type: 'bool' },
      { name: 'tradingCloseUtc', type: 'uint64' },
      { name: 'quoteVersion', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'floorCents',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'int64' }],
  },
  {
    type: 'function',
    name: 'capCents',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'int64' }],
  },
  {
    type: 'function',
    name: 'openExpiry',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dayKey', type: 'uint32' },
      { name: 'tradingCloseUtc', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'postQuotes',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dayKey', type: 'uint32' },
      { name: 'strikes', type: 'int64[]' },
      {
        name: 'quotes',
        type: 'tuple[]',
        components: [
          { name: 'callAsk', type: 'uint64' },
          { name: 'callBid', type: 'uint64' },
          { name: 'putAsk', type: 'uint64' },
          { name: 'putBid', type: 'uint64' },
        ],
      },
    ],
    outputs: [{ type: 'uint64' }],
  },
] as const;

const perpOrder = [
  { name: 'account', type: 'address' },
  { name: 'createdAt', type: 'uint64' },
  { name: 'pending', type: 'bool' },
  { name: 'isOpen', type: 'bool' },
  { name: 'isLong', type: 'bool' },
  { name: 'acceptablePriceCents', type: 'int64' },
  { name: 'size', type: 'uint256' },
  { name: 'positionId', type: 'uint256' },
  { name: 'escrow', type: 'uint256' },
  { name: 'reserveHeld', type: 'uint256' },
] as const;

const poolRequest = [
  { name: 'account', type: 'address' },
  { name: 'createdAt', type: 'uint64' },
  { name: 'pending', type: 'bool' },
  { name: 'isDeposit', type: 'bool' },
  { name: 'amount', type: 'uint256' },
] as const;

/** contracts/src/TexasPowerPerp.sol, the functions the keeper calls. */
export const texasPowerPerpAbi = [
  {
    type: 'function',
    name: 'nextOrderId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nextPoolRequestId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getOrder',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: perpOrder }],
  },
  {
    type: 'function',
    name: 'getPoolRequest',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: poolRequest }],
  },
  {
    type: 'function',
    name: 'executeOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'uint256' },
      { name: 'roundId', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executePoolRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'uint256' },
      { name: 'roundId', type: 'uint64' },
    ],
    outputs: [],
  },
] as const;
