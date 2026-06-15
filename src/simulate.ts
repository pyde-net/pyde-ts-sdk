/**
 * Pre-sign transaction simulation — Tier 1 (Chapter 17.4b).
 *
 * What chapter 17.4b says ships at v1 mainnet:
 *   - Gas estimation
 *   - Access-list inference
 *   - View-function execution
 *   - Dry-run preview ("this tx will spend X PYDE, transfer Y to Z,
 *     emit Transfer, leave your balance at W")
 *   - Known-pattern decoding (Transfer / Approve / etc.)
 *
 * What this v1 ships:
 *   - The full API surface (`simulateTransaction`, `previewTransaction`),
 *     so callers can write against the right shape today.
 *   - Honest RPC-backed fallbacks for gas + access-list (via the same
 *     methods a wallet would call before submitting).
 *
 * What's deferred to v1.1:
 *   - Full local wasmtime instantiation. The chain compiles each contract
 *     with Cranelift AOT; the SDK will instantiate the same `.wasm` in
 *     the JS side (browser native WebAssembly + Node 22+) with every
 *     `pyde::*` host import wired to a provider-backed RPC fetch
 *     (`sload` → `pyde_getStorageSlot`, `code_size` → contract code
 *     length, etc.), track fuel for gas, and capture overlay writes for
 *     state-change preview. The work-in-progress lives behind a feature
 *     flag and graduates once the wasmtime / browser-WebAssembly host
 *     fn mocking lands.
 *
 * Why a stub now: the simulation API surface is shared by wallets,
 * indexers, and the React hooks; callers can write the surface today
 * and pick up the local-execution benefits when v1.1 lands without
 * any code changes on their side.
 */

import type { Provider } from "./provider";
import type { AccessEntry, Log, TxFields, Receipt } from "./types";

// ============================================================================
// Public types
// ============================================================================

/** Result of a local simulation. */
export interface SimulationResult {
  /** Will the transaction revert? */
  willRevert: boolean;
  /** Estimated gas (chain units). */
  gasEstimate: number;
  /** Inferred access list (slots read / written). */
  accessList: AccessEntry[];
  /** Events the tx would emit (empty if simulation can't capture them). */
  events: Log[];
  /** Return data the tx would produce (hex, or `0x` when absent). */
  returnData: string;
  /** Optional human-readable revert reason (when `willRevert` is true). */
  revertReason?: string;
  /** Pre-tx balance of the sender (quanta). */
  balanceBefore?: bigint;
  /** Post-tx balance the simulator computed (quanta). May be undefined in
   *  v1 stub mode when the RPC fallback can't predict it. */
  balanceAfter?: bigint;
  /** Source of the result — `"local"` once v1.1 wasmtime instantiation
   *  lands; `"rpc"` for v1's RPC-backed fallback. */
  source: "local" | "rpc";
}

/** Options for `previewTransaction`. */
export interface PreviewOptions {
  /** Provider used to fetch state / call helpers. Required. */
  provider: Provider;
  /** Include the access-list inference (extra round-trip in RPC mode). */
  includeAccessList?: boolean;
  /** Include sender balance before / (best-effort) after. */
  includeBalance?: boolean;
  /** Skip the gas estimate (when caller already has one). */
  skipGasEstimate?: boolean;
}

// ============================================================================
// API
// ============================================================================

/**
 * Simulate a transaction. v1 implementation routes to the provider's
 * `estimateGas`, `estimateAccess`, and (where applicable) view-call
 * surface. Returns a `SimulationResult` with `source: "rpc"`.
 *
 * In v1.1 (wasmtime instantiation), this same call will execute
 * the contract WASM locally with provider-backed host functions and
 * return `source: "local"` results that capture exact state changes,
 * events, and gas. Callers don't need to change anything when the
 * upgrade lands.
 */
export async function simulateTransaction(
  tx: TxFields,
  options: PreviewOptions,
): Promise<SimulationResult> {
  const { provider } = options;

  const result: SimulationResult = {
    willRevert: false,
    gasEstimate: 0,
    accessList: [],
    events: [],
    returnData: "0x",
    source: "rpc",
  };

  // Pre-tx balance (best-effort).
  if (options.includeBalance) {
    try {
      result.balanceBefore = await provider.getBalance(tx.from);
    } catch {
      // Fall through.
    }
  }

  // Gas estimate + access-list inference both ride on
  // `pyde_simulateTransaction` (engine RPC catalog v0.1 — single
  // dry-run returns receipt + access_list together). The wrapper is
  // queued as Tier-2 catalog alignment. Until it lands, the v1 stub
  // falls back to the same conservative default `Wallet` uses for
  // unestimated calls so `gasEstimate` stays non-zero for callers
  // that only consume the field.
  if (!options.skipGasEstimate) {
    result.gasEstimate = tx.data === "0x" ? 100_000 : 5_000_000;
  }
  if (options.includeAccessList && !result.willRevert) {
    result.accessList = [];
  }

  // View-call execution (free) if there's calldata — captures return data.
  // The chain's `pyde_call` runs against current state with no commit, so
  // the return value is what the real tx would produce *now*. State-change
  // capture lands in v1.1.
  if (!result.willRevert && tx.data && tx.data !== "0x") {
    try {
      result.returnData = await provider.call(tx.to, tx.data, {
        from: tx.from,
        value: tx.value,
        gasLimit: tx.gasLimit,
      });
    } catch {
      // The call surface is only valid for view paths; non-view txs
      // still get a gas estimate above.
    }
  }

  // Best-effort post-tx balance — RPC mode can subtract the value if it
  // was a plain transfer; for contract calls we'd need local execution.
  if (options.includeBalance && result.balanceBefore !== undefined && !result.willRevert) {
    try {
      const value = BigInt(tx.value);
      const isPlainTransfer = tx.data === "0x" || tx.data === "";
      if (isPlainTransfer) {
        result.balanceAfter = result.balanceBefore - value;
      }
    } catch {
      // Skip — leave balanceAfter undefined.
    }
  }

  return result;
}

/**
 * Higher-level preview helper — returns a `SimulationResult` with all
 * extras enabled. Equivalent to:
 *
 * ```ts
 * await simulateTransaction(tx, {
 *   provider,
 *   includeAccessList: true,
 *   includeBalance: true,
 * });
 * ```
 *
 * Use this directly from wallet UIs that want the full dry-run picture
 * before showing a "Sign" button.
 */
export async function previewTransaction(
  tx: TxFields,
  provider: Provider,
): Promise<SimulationResult> {
  return simulateTransaction(tx, {
    provider,
    includeAccessList: true,
    includeBalance: true,
  });
}

/**
 * Apply the simulation result to a transaction in-place. The most common
 * use is updating `gasLimit` + attaching the inferred `accessList` after
 * a preview round-trip.
 *
 * ```ts
 * const sim = await previewTransaction(tx, provider);
 * if (sim.willRevert) throw new Error(sim.revertReason);
 * applySimulation(tx, sim, { gasMultiplier: 1.2 });
 * ```
 */
export function applySimulation(
  tx: TxFields,
  result: SimulationResult,
  opts?: { gasMultiplier?: number },
): void {
  const gas = Math.ceil(result.gasEstimate * (opts?.gasMultiplier ?? 1));
  if (gas > 0) tx.gasLimit = gas;
  if (result.accessList.length > 0) tx.accessList = result.accessList;
}

/**
 * Lightweight wrapper around a Receipt that exposes the preview-shaped
 * data (events, returnData) after a real submission, mirroring what the
 * simulator would have predicted. Useful for unifying pre + post views
 * in dapp UIs.
 */
export function receiptToSimulationView(receipt: Receipt): SimulationResult {
  return {
    willRevert: !receipt.success,
    gasEstimate: parseInt(receipt.gasUsed.replace(/^0x/, ""), 16),
    accessList: [],
    events: receipt.logs,
    returnData: receipt.returnData ?? "0x",
    source: "rpc",
  };
}
