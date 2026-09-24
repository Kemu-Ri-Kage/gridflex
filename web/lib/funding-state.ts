import { collateralShortfall } from './transaction-outcome.ts';

/**
 * What the order ticket shows about the connected wallet's funds. A new
 * wallet has neither mUSDT to buy with nor OKB to pay gas, and a buy or a
 * mint it tries fails; the ticket says so before anything is sent.
 */
export type FundingInput = {
  account?: string;
  /** The wallet the balances below were read for; undefined before a read. */
  balanceAccount?: string;
  /** mUSDT, 6 decimals. */
  balance: bigint;
  /** Native OKB, which pays gas on X Layer. */
  gasBalance: bigint;
  /** The amount typed, or undefined when it isn't a valid amount. */
  units?: bigint;
  tradingOpen: boolean;
};

export type Funding = {
  /**
   * The mUSDT balance, once read for the connected wallet. Undefined until
   * then, so a wallet that has funds never flashes the zero state.
   */
  balance?: bigint;
  /** No mUSDT: the ticket leads with getting test mUSDT. */
  needsMusdt: boolean;
  /** No OKB for gas: the ticket links the faucet, and minting would fail. */
  needsGas: boolean;
  /** Why the typed amount can't be bought, shown under Amount. */
  shortfall?: string;
  /** Funds cover the typed amount and its gas. */
  fundsReady: boolean;
};

export const NO_GAS_MESSAGE = 'No OKB for gas.';

export function fundingState(input: FundingInput): Funding {
  const known =
    Boolean(input.account) &&
    (input.balanceAccount ?? '').toLowerCase() ===
      (input.account ?? '').toLowerCase();
  if (!known) {
    return { needsMusdt: false, needsGas: false, fundsReady: false };
  }

  const { balance, gasBalance, units, tradingOpen } = input;
  const needsMusdt = tradingOpen && balance === 0n;
  const needsGas = tradingOpen && gasBalance === 0n;
  // With no mUSDT the lead block already says so (each fact once).
  const shortfall =
    !tradingOpen || needsMusdt
      ? undefined
      : needsGas
        ? NO_GAS_MESSAGE
        : units !== undefined
          ? collateralShortfall(units, balance)
          : undefined;
  return {
    balance,
    needsMusdt,
    needsGas,
    shortfall,
    fundsReady:
      tradingOpen &&
      !needsMusdt &&
      !needsGas &&
      units !== undefined &&
      shortfall === undefined,
  };
}
