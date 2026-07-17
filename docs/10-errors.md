# 10 — Errors

One hierarchy, eight concrete classes, two type guards. Every SDK throw is an instance of `PydeError`; every instance has a stable `code` for switch-style handling.

[← TOC](./README.md)

---

## Table of contents

- [Hierarchy](#hierarchy)
- [`PydeError` — base class](#pydeerror--base-class)
- Concrete error classes
  - [`CallExceptionError`](#callexceptionerror)
  - [`ConnectionError`](#connectionerror)
  - [`TimeoutError`](#timeouterror)
  - [`InvalidArgumentError`](#invalidargumenterror)
  - [`InsufficientFundsError`](#insufficientfundserror)
  - [`RpcError`](#rpcerror)
  - [`SigningError`](#signingerror)
  - [`WalletDestroyedError`](#walletdestroyederror)
- Type guards
  - [`isError(e, code)`](#iserrore-code)
  - [`isCallException(e)`](#iscallexceptione)
- [`ErrorCode` enum](#errorcode-enum)
- [Retry semantics](#retry-semantics)
- [`scrubError` — hex redaction](#scruberror--hex-redaction)
- [Recipes](#recipes)
- [Gotchas](#gotchas)

---

## Hierarchy

```
Error
└── PydeError                          (.code: ErrorCode)
    ├── CallExceptionError             ("CALL_EXCEPTION")     — tx reverted
    ├── ConnectionError                ("CONNECTION_ERROR")   — transport failure
    ├── TimeoutError                   ("TIMEOUT")            — request / receipt poll exceeded
    ├── InvalidArgumentError           ("INVALID_ARGUMENT")   — bad arg shape
    ├── InsufficientFundsError         ("INSUFFICIENT_FUNDS") — can't cover value + fee
    ├── RpcError                       ("RPC_ERROR")          — node returned `{error: …}`
    └── SigningError                   ("SIGNING_ERROR")      — WASM / keystore failure
        └── WalletDestroyedError                              — signing after destroy()
```

---

## `PydeError` — base class

```ts
class PydeError extends Error {
  readonly code: ErrorCode;
}
```

Every concrete class extends `PydeError`. The `code` field is the **stable contract** — match on it in switches.

**Example — catch-all:**

```ts
import { PydeError } from "pyde-ts-sdk";

try {
  await provider.getBalance(addr);
} catch (e) {
  if (e instanceof PydeError) {
    console.log("SDK error:", e.code, e.message);
  } else {
    throw e; // unknown error → re-throw
  }
}
```

---

## `CallExceptionError`

Transaction reverted (on chain).

```ts
class CallExceptionError extends PydeError {
  readonly gasUsed: string; // 0x-prefixed quanta
  readonly data: string; // raw return data hex
  readonly reason: string | null; // decoded if contract used `pyde::revert("msg")`
}
```

**Thrown by:**

- `Provider.call` on a reverted view call.
- `Provider.sendAndWait` when the receipt's `success === false`.
- Any path that polls a receipt and finds a revert.

**Example:**

```ts
import { CallExceptionError } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, parseQuanta("1000"));
} catch (e) {
  if (e instanceof CallExceptionError) {
    console.log("reverted:", e.reason ?? "(no reason)");
    console.log("gas used:", parseInt(e.gasUsed, 16));
  }
}
```

**Expected output:**

```
reverted: insufficient balance
gas used: 21000
```

**Notes:**

- `reason` is `null` when the contract reverts without a message.
- `data` is the raw return-data hex — useful for custom decoding.

---

## `ConnectionError`

Transport failed before the chain could answer.

```ts
class ConnectionError extends PydeError {}
```

**Causes:**

- `fetch` threw (network unreachable, DNS failure).
- WebSocket socket dropped past `reconnectMaxAttempts`.
- `ECONNRESET`, `ECONNREFUSED`.

**Distinct from `RpcError`** — `RpcError` means the chain answered with an explicit error code.

**Example:**

```ts
import { ConnectionError } from "pyde-ts-sdk";

try {
  await provider.getBalance(addr);
} catch (e) {
  if (e instanceof ConnectionError) {
    console.log("transport down — retry with backoff");
  }
}
```

---

## `TimeoutError`

A request exceeded its time budget.

```ts
class TimeoutError extends PydeError {}
```

**Causes:**

- `ProviderOptions.timeout` elapsed during fetch.
- `waitForReceipt(hash, timeoutMs)` timeout passed without the tx being mined.
- WebSocket `rpcTimeoutMs` exceeded.

**The tx may still commit later** — re-poll if it makes sense.

**Example:**

```ts
import { TimeoutError } from "pyde-ts-sdk";

try {
  const receipt = await provider.waitForReceipt(hash, 5_000);
} catch (e) {
  if (e instanceof TimeoutError) {
    console.log("timed out — re-checking");
    const later = await provider.getTransactionReceipt(hash);
    if (later) console.log("committed late:", later.success);
  }
}
```

---

## `InvalidArgumentError`

Constructor / option / arg validation failure.

```ts
class InvalidArgumentError extends PydeError {
  readonly argument: string;
  readonly value: unknown;
}
```

**Common triggers:**

- `Provider("http://…")` without `allowInsecureTransport: true`.
- `getBalance("not-an-address")`.
- `transfer("0x…", -5n)`.

**Example:**

```ts
import { InvalidArgumentError } from "pyde-ts-sdk";

try {
  new Provider("http://localhost:9933"); // missing allowInsecureTransport
} catch (e) {
  if (e instanceof InvalidArgumentError) {
    console.log("bad arg:", e.argument, "=", e.value);
  }
}
```

**Expected output:**

```
bad arg: rpcUrl = http://localhost:9933
```

---

## `InsufficientFundsError`

Sender can't cover `value + gas * gasPrice`.

```ts
class InsufficientFundsError extends PydeError {}
```

**Surfaces:**

- Pre-flight (when the SDK can detect it from `getBalance`).
- Post-RPC (when the chain rejects).

**Example:**

```ts
import { isError } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, parseQuanta("100000"));
} catch (e) {
  if (isError(e, "INSUFFICIENT_FUNDS")) {
    toast("Not enough PYDE to cover the transfer + gas.");
    return;
  }
  throw e;
}
```

---

## `RpcError`

Chain returned a JSON-RPC error envelope.

```ts
class RpcError extends PydeError {
  readonly rpcError: unknown; // raw {code, message, data?}
}
```

**`rpcError` carries the chain-side `code`** for callers who need it (e.g., `-32602` is wave_id type mismatch).

**Example:**

```ts
import { RpcError } from "pyde-ts-sdk";

try {
  await provider.getWave("not a wave" as any);
} catch (e) {
  if (e instanceof RpcError) {
    console.log("chain error:", e.message);
    const inner = e.rpcError as { code: number; message: string };
    console.log("chain code:", inner.code);
  }
}
```

**Expected output:**

```
chain error: RPC error: {"code":-32602,"message":"wave_id must be a u64 number"}
chain code: -32602
```

---

## `SigningError`

WASM signer / keystore failure.

```ts
class SigningError extends PydeError {}
```

**Triggers:**

- Invalid SK hex.
- Malformed `TxFields`.
- Keystore tamper detected (AEAD decrypt failed).
- `toKeystore` called on a handle-backed wallet.

**Example:**

```ts
import { SigningError } from "pyde-ts-sdk";

try {
  const wallet = await Wallet.fromEncrypted(keystore, "wrong-password");
} catch (e) {
  if (e instanceof SigningError) {
    console.log("decrypt failed:", e.message);
  }
}
```

**Expected output:**

```
decrypt failed: keystore decryption failed (wrong password or tampered data)
```

---

## `WalletDestroyedError`

Signing method called after `wallet.destroy()`. Extends `SigningError`.

```ts
class WalletDestroyedError extends SigningError {}
```

The message includes a clear "generate a new Wallet to sign" hint.

**Catch via:**

- `instanceof WalletDestroyedError`
- `e.code === "SIGNING_ERROR"` (matches all SigningErrors)

**Example:**

```ts
import { WalletDestroyedError } from "pyde-ts-sdk";

const wallet = Wallet.generate();
wallet.destroy();

try {
  wallet.sign("0xdeadbeef");
} catch (e) {
  if (e instanceof WalletDestroyedError) {
    console.log("wallet is gone:", e.message);
  }
}
```

**Expected output:**

```
wallet is gone: wallet has been destroyed — generate a new Wallet to sign
```

---

## `isError(e, code)`

Catch-all type guard.

**Signature:**

```ts
function isError(e: unknown, code: ErrorCode): boolean;
```

**Args:**

| Name   | Type        | Description                    |
| ------ | ----------- | ------------------------------ |
| `e`    | `unknown`   | Caught value.                  |
| `code` | `ErrorCode` | One of the eight string codes. |

**Returns:** `boolean` — `true` iff `e instanceof PydeError && e.code === code`.

**Example:**

```ts
import { isError } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, amount);
} catch (e) {
  if (isError(e, "INSUFFICIENT_FUNDS")) {
    // …
  } else if (isError(e, "CONNECTION_ERROR")) {
    // retry with backoff
  } else if (isError(e, "TIMEOUT")) {
    // re-poll receipt
  } else {
    throw e;
  }
}
```

---

## `isCallException(e)`

Narrowed guard for `CallExceptionError`. TS narrows the type inside the block.

**Signature:**

```ts
function isCallException(e: unknown): e is CallExceptionError;
```

**Example:**

```ts
import { isCallException } from "pyde-ts-sdk";

try {
  await wallet.transfer(to, amount);
} catch (e) {
  if (isCallException(e)) {
    console.warn("reverted:", e.reason); // .reason narrows because of `e is CallExceptionError`
  }
}
```

---

## `ErrorCode` enum

```ts
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

| Code                   | Class                                  |
| ---------------------- | -------------------------------------- |
| `"CALL_EXCEPTION"`     | `CallExceptionError`                   |
| `"CONNECTION_ERROR"`   | `ConnectionError`                      |
| `"TIMEOUT"`            | `TimeoutError`                         |
| `"INVALID_ARGUMENT"`   | `InvalidArgumentError`                 |
| `"INSUFFICIENT_FUNDS"` | `InsufficientFundsError`               |
| `"RPC_ERROR"`          | `RpcError`                             |
| `"SIGNING_ERROR"`      | `SigningError`, `WalletDestroyedError` |
| `"UNKNOWN_ERROR"`      | Reserved; not currently emitted.       |

---

## Retry semantics

| Layer                                  | Retries?                        | When                                                                    | Backoff                                      |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `Provider.options.retries`             | configurable                    | Transport errors (5xx, ECONNRESET, abort).                              | exponential, capped                          |
| `Provider.callWithFallback` (internal) | per fallback list               | `method not found` → try next method name.                              | none                                         |
| `WebSocketProvider` reconnect          | per `reconnectMaxAttempts`      | Socket dropped.                                                         | exponential, capped at `reconnectMaxDelayMs` |
| `Wallet.sendCall` simulate fallback    | once                            | `simulateTransaction` fails → fall back to 5M default + no access list. | none                                         |
| `waitForReceipt` polling               | every ~500 ms until `timeoutMs` | Receipt not yet available.                                              | linear                                       |

**The SDK never retries on `RpcError` or `CallExceptionError`** — the chain answered, the answer is "no", the caller decides what to do.

---

## `scrubError` — hex redaction

The internal `scrubError` helper cleans up exception messages so long hex runs don't leak into logs. It replaces:

- Any 200+ char run of hex (with or without `0x` prefix) → `[REDACTED]`.
- Any `0x`-prefixed 64+ char run → `0x[REDACTED]`.

**Protects:**

- 897-byte FALCON public keys (1,794 hex chars).
- 1,281-byte FALCON SK (2,562 hex chars).
- Tx wire bytes and calldata that may embed sensitive values.

You don't usually call `scrubError` directly — it's applied automatically to error messages traversing the `Provider` layer.

---

## Recipes

### Detect "user rejected in wallet"

`BrowserWalletAdapter` surfaces wallet UI rejections as `SigningError`. Match by `e.code === "SIGNING_ERROR"` AND inspect the message for the wallet-provided reason.

```ts
try {
  await adapter.signTransaction(tx);
} catch (e) {
  if (isError(e, "SIGNING_ERROR") && (e as Error).message.includes("user rejected")) {
    toast("Cancelled.");
    return;
  }
  throw e;
}
```

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

### Unified error handler for a dapp

```ts
function handleSdkError(e: unknown): string {
  if (isError(e, "INSUFFICIENT_FUNDS")) return "Insufficient PYDE balance.";
  if (isError(e, "CONNECTION_ERROR")) return "Network unreachable. Check your connection.";
  if (isError(e, "TIMEOUT")) return "Request timed out. Try again.";
  if (isError(e, "INVALID_ARGUMENT")) return `Invalid input: ${(e as Error).message}`;
  if (isCallException(e)) return `Reverted: ${e.reason ?? "(unknown)"}`;
  if (isError(e, "RPC_ERROR")) return `Chain error: ${(e as Error).message}`;
  if (isError(e, "SIGNING_ERROR")) return `Signing failed: ${(e as Error).message}`;
  return "Unexpected error.";
}
```

---

## Gotchas

- **`Error` subclassing across realms.** `instanceof PydeError` works inside a single module/realm; if you `postMessage` an error across a worker boundary, the structure is preserved but the prototype chain isn't. Use `isError(e, code)` — `e.code` is a plain string and survives serialization.
- **`reason` is `null` when the contract reverts without a message.** Always check for `null`.
- **`RpcError.code` is the SDK's `ErrorCode` (`"RPC_ERROR"`), not the JSON-RPC numeric code.** The numeric code lives in `RpcError.rpcError`.
- **`TimeoutError` isn't a failure.** It just means the SDK gave up waiting; the tx may still be in flight. Poll the receipt explicitly if you need to know.
