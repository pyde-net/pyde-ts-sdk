# 10 — Errors

One hierarchy, eight concrete classes, two type guards. Every SDK throw is an instance of `PydeError`; every instance has a stable `code` for switch-style handling.

[← TOC](./README.md)

## Hierarchy

```
PydeError
├── CallExceptionError       (CALL_EXCEPTION)     — tx reverted, gas used + decoded reason
├── ConnectionError          (CONNECTION_ERROR)   — transport failure (fetch / WS dropped)
├── TimeoutError             (TIMEOUT)            — request / receipt poll exceeded budget
├── InvalidArgumentError     (INVALID_ARGUMENT)   — bad arg shape, validation failure
├── InsufficientFundsError   (INSUFFICIENT_FUNDS) — sender can't cover value + fee
├── RpcError                 (RPC_ERROR)          — node returned `{error: {code, message}}`
├── SigningError             (SIGNING_ERROR)      — WASM signer / keystore failure
│   └── WalletDestroyedError                      — signing after destroy()
└── (Error)                                       — never thrown directly; subclass instead
```

## `PydeError`

```ts
class PydeError extends Error {
  readonly code: ErrorCode;
}

type ErrorCode =
  | "CALL_EXCEPTION"
  | "CONNECTION_ERROR"
  | "TIMEOUT"
  | "INVALID_ARGUMENT"
  | "INSUFFICIENT_FUNDS"
  | "RPC_ERROR"
  | "SIGNING_ERROR"
  | "UNKNOWN_ERROR";
```

## Concrete classes

### `CallExceptionError`

```ts
class CallExceptionError extends PydeError {
  readonly gasUsed: string;    // hex, quanta
  readonly data: string;       // raw return data hex
  readonly reason: string | null; // decoded if the contract used pyde::revert("msg")
}
```
Thrown by `Provider.call`, `sendAndWait`, and any path that polls a receipt and finds `success === false`. `reason` is decoded via the chain's standard revert format (`pyde::revert("msg")` from contract source maps to a hex string the SDK parses).

### `ConnectionError`

```ts
class ConnectionError extends PydeError {}
```
Transport failed before the chain could answer — `fetch` threw, WS socket dropped past the retry cap, `ECONNRESET`. Distinct from `RpcError` (the chain answered with an error).

### `TimeoutError`

```ts
class TimeoutError extends PydeError {}
```
`ProviderOptions.timeout` elapsed, or `waitForReceipt` timeout passed without the tx being mined. The tx may still commit later — re-poll if it makes sense.

### `InvalidArgumentError`

```ts
class InvalidArgumentError extends PydeError {
  readonly argument: string;
  readonly value: unknown;
}
```
Constructor / option validation failure. Common triggers:
- `Provider` with `http://` and no `allowInsecureTransport: true`.
- `getBalance("not-an-address")`.
- `transfer("0x...", -5n)`.

### `InsufficientFundsError`

```ts
class InsufficientFundsError extends PydeError {}
```
Sender's account can't cover `value + gas * gasPrice`. Surfaces both pre-flight (when the SDK can detect it) and post-RPC (when the chain rejects).

### `RpcError`

```ts
class RpcError extends PydeError {
  readonly rpcError: unknown; // raw JSON-RPC error object
}
```
Chain returned a JSON-RPC `error` envelope. `rpcError` carries the raw `{code, message, data?}` for callers that need the chain-side code (e.g., `-32602` is wave_id type mismatch).

### `SigningError`

```ts
class SigningError extends PydeError {}
```
WASM signer failed: invalid SK hex, malformed tx fields, keystore tamper detected.

### `WalletDestroyedError`

```ts
class WalletDestroyedError extends SigningError {}
```
Signing method called after `wallet.destroy()`. Message includes a clear "generate a new Wallet to sign" hint. Catches via either `instanceof WalletDestroyedError` or `e.code === "SIGNING_ERROR"`.

## Type guards

```ts
import { isError, isCallException } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, amount);
} catch (e) {
  if (isError(e, "INSUFFICIENT_FUNDS")) {
    // Show "top up your wallet" UI.
  } else if (isCallException(e)) {
    console.warn("reverted:", e.reason);
  } else if (isError(e, "CONNECTION_ERROR")) {
    // Retry with backoff.
  } else {
    throw e; // surface unknowns
  }
}
```

`isError(e, code)` is the catch-all guard. `isCallException(e)` is a narrowed alias that's nice for type-narrowing in TS.

## Retry semantics

| Layer | Retries | When |
|---|---|---|
| `Provider.options.retries` | configurable | Transport errors (5xx, ECONNRESET, abort). Exponential backoff. |
| `Provider` internal `callWithFallback` | per fallback list | `method not found` → try next method name. |
| `WebSocketProvider` reconnect | per `reconnectMaxAttempts` | Socket dropped. Exponential backoff capped by `reconnectMaxDelayMs`. |
| `Wallet.transfer` gas estimation | once | `estimateGas` fails → fall back to 100k / 5M hard defaults. |
| `waitForReceipt` polling | every ~500 ms until `timeoutMs` | Receipt not yet available. |

The SDK never retries on `RpcError` or `CallExceptionError` — the chain answered, the answer is "no", the caller decides what to do.

## Hex-redacting errors (`scrubError`)

The internal `scrubError` helper, used to clean up exception messages that bubble out to logs, replaces long hex runs with `[REDACTED]`:

- Any 200+ char run of hex (with or without `0x` prefix) → `[REDACTED]`.
- Any `0x`-prefixed 64+ char run → `0x[REDACTED]`.

This protects:
- 897-byte FALCON public keys (1,792 hex chars).
- 1,281-byte FALCON SK (2,562 hex chars).
- Tx wire bytes that may contain encrypted payloads.

You don't usually call `scrubError` directly — it's applied automatically to the messages of errors that traverse the `Provider` layer.

## Recipes

### Detect "user rejected in wallet"

`BrowserWalletAdapter` surfaces wallet UI rejections as `SigningError`. Match by `e.code === "SIGNING_ERROR"` AND inspect the message for the wallet-provided reason.

### Distinguish "tx not yet committed" from "tx failed"

```ts
const receipt = await provider.getTransactionReceipt(txHash);
if (receipt === null) {
  // not yet committed — poll again later, or call waitForReceipt
} else if (receipt.success === false) {
  // committed AND reverted — use CallExceptionError if you want the decoded reason:
  throw new CallExceptionError(receipt.gasUsed, receipt.returnData ?? "0x");
}
```

### Surface a friendly insufficient-funds message

```ts
import { isError } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, amount);
} catch (e) {
  if (isError(e, "INSUFFICIENT_FUNDS")) {
    toast("Not enough PYDE to cover the transfer + gas.");
    return;
  }
  throw e;
}
```

## Gotchas

- **`Error` subclassing across realms.** `instanceof PydeError` works inside a single module/realm; if you `postMessage` an error across a worker boundary, the structure is preserved but the prototype chain isn't. Use `isError(e, code)` — `e.code` is a plain string and survives serialization.
- **`reason` is `null` when the contract reverts without a message.** Always check for `null`.
- **`RpcError.code` is the SDK's `ErrorCode` (`"RPC_ERROR"`), not the JSON-RPC numeric code.** The numeric code lives in `RpcError.rpcError`.
- **`TimeoutError` isn't a failure.** It just means the SDK gave up waiting; the tx may still be in flight. Poll the receipt explicitly if you need to know.
