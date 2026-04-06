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

/** Transaction executed but reverted. Contains gas used and return data for reason decoding. */
export class CallExceptionError extends PydeError {
  readonly gasUsed: string;
  readonly data: string;
  readonly reason: string | null;

  constructor(gasUsed: string, data: string) {
    const reason = decodeRevertReason(data);
    const msg = reason
      ? `Transaction reverted: ${reason} (gas=${gasUsed})`
      : `Transaction reverted (gas=${gasUsed})`;
    super(msg, "CALL_EXCEPTION");
    this.name = "CallExceptionError";
    this.gasUsed = gasUsed;
    this.data = data;
    this.reason = reason;
  }
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
