/**
 * The test-funds faucet's rules, shared by the API route that sends funds
 * (app/api/v1/faucet) and the ticket button that asks for them
 * (components/get-test-funds.tsx).
 *
 * A first-time trader on X Layer testnet has neither test OKB to pay gas nor
 * mUSDT to trade with, and minting mUSDT itself costs gas. One request tops
 * up both from GRIDFLEX's own faucet wallet: a little OKB, and 1,000 mUSDT
 * minted straight to the trader (MockUSDT.mint is open to any caller, and the
 * faucet pays its gas). Funds are only sent to a wallet that is low, so the
 * same wallet can't keep collecting.
 *
 * Kept free of imports for the node tests.
 */

/** Test OKB sent per top-up: dozens of approve and buy transactions on X Layer testnet. */
export const FAUCET_GAS_WEI = 5_000_000_000_000_000n; // 0.005 OKB
/** A wallet with less test OKB than this gets gas. */
export const FAUCET_GAS_BELOW_WEI = 2_000_000_000_000_000n; // 0.002 OKB
/** mUSDT minted per top-up, 6 decimals. */
export const FAUCET_MUSDT_UNITS = 1_000_000_000n; // 1,000 mUSDT
/** A wallet with less mUSDT than this gets more. */
export const FAUCET_MUSDT_BELOW_UNITS = 100_000_000n; // 100 mUSDT

export type FaucetPlan = { gas: boolean; musdt: boolean };

/** What a wallet with these balances gets: gas, mUSDT, both, or nothing. */
export function faucetPlan(balances: { gasWei: bigint; musdtUnits: bigint }): FaucetPlan {
  return {
    gas: balances.gasWei < FAUCET_GAS_BELOW_WEI,
    musdt: balances.musdtUnits < FAUCET_MUSDT_BELOW_UNITS,
  };
}

/** GET /api/v1/faucet: whether the faucet is switched on, and its bot check. */
export type FaucetStatus = { enabled: boolean; turnstileSiteKey: string | null };

/** POST /api/v1/faucet's answer. `sent` holds the transaction hashes. */
export type FaucetResult =
  | { ok: true; sent: { gas?: string; musdt?: string } }
  | { ok: false; error: string };

/** The one line the ticket shows after a successful top-up. */
export function faucetMessage(sent: { gas?: string; musdt?: string }): string {
  if (sent.gas && sent.musdt) return 'Sent: 1,000 test mUSDT and test OKB for gas.';
  if (sent.musdt) return 'Sent: 1,000 test mUSDT.';
  if (sent.gas) return 'Sent: test OKB for gas.';
  return 'This wallet already has test funds.';
}
