// ============================================================================
// Error codes
// ============================================================================

export type ErrorCode =
  | "CALL_EXCEPTION"
  | "CONNECTION_ERROR"
  | "TIMEOUT"
  | "INVALID_ARGUMENT"
  | "INSUFFICIENT_FUNDS"
  | "RPC_ERROR"
  | "SIGNING_ERROR"
  | "UNKNOWN_ERROR";

// ============================================================================
// Base error class
// ============================================================================

/** Base error for all SDK errors. Use `isError(e, code)` to check type. */
export class PydeError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = "PydeError";
    this.code = code;
  }
}

// ============================================================================
// Specific error classes
// ============================================================================

/** Transaction executed but reverted. Carries the engine's
 *  structured `RevertReason` (`category` + `message`) when the chain
 *  ships one, and falls back to UTF-8-decoding `return_data` for
 *  pre-#349 builds that left the receipt without a `revert_reason`. */
export class CallExceptionError extends PydeError {
  readonly gasUsed: string;
  readonly data: string;
  /** Human-readable revert reason. Prefers the engine's structured
   *  `RevertReason.message`; falls back to a UTF-8 decode of
   *  `return_data` when the chain didn't ship one. */
  readonly reason: string | null;
  /** Engine-categorised reject layer (`"EngineValidation"` |
   *  `"Contract"` | `"Vm"` | forward-compat string). `null` when the
   *  receipt didn't carry a structured `revert_reason` and the SDK
   *  fell back to decoding `return_data`. */
  readonly category: string | null;

  constructor(gasUsed: string, data: string, revertReason?: RevertReasonLite | null) {
    let category: string | null = null;
    let reason: string | null = null;
    if (revertReason && revertReason.message) {
      category = revertReason.category ?? null;
      reason = revertReason.message;
    } else {
      reason = decodeRevertReason(data);
    }
    const msg = reason
      ? `Transaction reverted: ${reason} (gas=${gasUsed})`
      : `Transaction reverted (gas=${gasUsed})`;
    super(msg, "CALL_EXCEPTION");
    this.name = "CallExceptionError";
    this.gasUsed = gasUsed;
    this.data = data;
    this.reason = reason;
    this.category = category;
  }

  /** Engine-side check rejected the tx (nonce, balance, fee, etc).
   *  Tx never reached the contract; gas is still charged per v1 rules. */
  get isEngineValidation(): boolean {
    return this.category === "EngineValidation";
  }

  /** Contract code explicitly reverted with a message. */
  get isContractRevert(): boolean {
    return this.category === "Contract";
  }

  /** VM-level trap (wasmtime trap, OOB memory, gas exhausted inside
   *  the executor, host-fn rejection). */
  get isVmTrap(): boolean {
    return this.category === "Vm";
  }
}

/** Structural subset of `RevertReason` that the error class needs;
 *  duplicated here to keep `errors.ts` free of a circular import on
 *  `types.ts` (which itself doesn't depend on errors). */
interface RevertReasonLite {
  category?: string | null;
  message?: string | null;
}

/** Cannot connect to the RPC node. */
export class ConnectionError extends PydeError {
  constructor(message: string) {
    super(`Connection error: ${message}`, "CONNECTION_ERROR");
    this.name = "ConnectionError";
  }
}

/** Operation timed out (e.g., waiting for receipt). */
export class TimeoutError extends PydeError {
  constructor(message: string) {
    super(message, "TIMEOUT");
    this.name = "TimeoutError";
  }
}

/** Invalid argument passed to an SDK method. */
export class InvalidArgumentError extends PydeError {
  readonly argument: string;
  readonly value: unknown;

  constructor(message: string, argument: string, value?: unknown) {
    super(message, "INVALID_ARGUMENT");
    this.name = "InvalidArgumentError";
    this.argument = argument;
    this.value = value;
  }
}

/** Insufficient balance for the requested operation. */
export class InsufficientFundsError extends PydeError {
  constructor(message: string) {
    super(message, "INSUFFICIENT_FUNDS");
    this.name = "InsufficientFundsError";
  }
}

/** RPC node returned an error response. */
export class RpcError extends PydeError {
  readonly rpcError: unknown;

  constructor(message: string, rpcError?: unknown) {
    super(`RPC error: ${message}`, "RPC_ERROR");
    this.name = "RpcError";
    this.rpcError = rpcError;
  }
}

/** Signing operation failed. */
export class SigningError extends PydeError {
  constructor(message: string) {
    super(message, "SIGNING_ERROR");
    this.name = "SigningError";
  }
}

/** Operation attempted on a destroyed wallet. The SK material has been
 *  dropped; future signing calls cannot succeed. */
export class WalletDestroyedError extends SigningError {
  constructor() {
    super("wallet has been destroyed — generate a new Wallet to sign");
    this.name = "WalletDestroyedError";
  }
}

// ============================================================================
// Type guards
// ============================================================================

/** Check if an error is a PydeError with a specific code. */
export function isError(e: unknown, code: ErrorCode): boolean {
  return e instanceof PydeError && e.code === code;
}

/** Check if an error is a CallExceptionError (reverted transaction). */
export function isCallException(e: unknown): e is CallExceptionError {
  return e instanceof CallExceptionError;
}

// ============================================================================
// Revert reason decoding
// ============================================================================

/**
 * Attempt to decode a revert reason from return data.
 * Supports: plain UTF-8 strings and length-prefixed strings.
 */
function decodeRevertReason(data: string): string | null {
  if (!data || data === "0x" || data === "") return null;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length === 0) return null;

  const buf = Buffer.from(hex, "hex");

  // Try length-prefixed string: [len:8 LE][utf8 bytes]
  if (buf.length >= 8) {
    const len = Number(buf.readBigUInt64LE(0));
    if (len > 0 && len <= buf.length - 8) {
      const s = buf.subarray(8, 8 + len).toString("utf-8");
      if (isPrintable(s)) return s;
    }
  }

  // Try raw UTF-8
  const raw = buf.toString("utf-8");
  if (isPrintable(raw) && raw.length > 0 && raw.length <= 256) return raw;

  return null;
}

function isPrintable(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0e-\x1f]/.test(s);
}
