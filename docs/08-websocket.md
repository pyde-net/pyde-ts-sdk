# 08 — WebSocketProvider

Live subscriptions over WSS. Three flavors: new waves, account changes, log events. Auto-reconnects on transient disconnect with cursor-based resume.

[← TOC](./README.md)

> **Engine-side gap:** the devnet doesn't yet expose `pyde_subscribe` / `pyde_unsubscribe`. The SDK surface is complete and the live test sequence is in `tests/integration/ws.live.test.ts` (skipped until the engine ships these methods).

## Constructor

```ts
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("wss://rpc.pyde.network", {
  reconnectMaxAttempts: 5,
  rpcTimeoutMs: 30_000,
});
```

`WebSocketProviderOptions`:

| Field | Default | Notes |
|---|---|---|
| `webSocketConstructor` | `globalThis.WebSocket` | Pass `ws` for Node < 22 without `--experimental-websocket`. |
| `httpRpcUrl` | `wsUrl` with `ws[s]://` → `http[s]://` | Used for non-subscription RPCs piggybacking on the same Provider. Preserves path / query / fragment. |
| `reconnectInitialDelayMs` | `1_000` | Exponential backoff base. |
| `reconnectMaxDelayMs` | `30_000` | Cap. |
| `reconnectMaxAttempts` | `0` (infinite) | After cap, fires `terminalError`. |
| `rpcTimeoutMs` | `30_000` | Per-call timeout. |
| `allowInsecureTransport` | `false` | Required for `ws://`. |

## Subscriptions

Every subscription returns an `Unsubscribe` — call it to tear down server-side state + remove the local listener.

### `subscribeNewHeads`

```ts
const unsub = await ws.subscribeNewHeads((header) => {
  console.log("wave", header.waveId, "anchor", header.anchor);
});

// later
await unsub();
```
Pushed every wave commit. Listener receives a fully-decoded `WaveHeader`.

### `subscribeAccountChanges`

```ts
const unsub = await ws.subscribeAccountChanges(
  "0xaddress...",
  (account) => {
    console.log("balance now", account.balance);
  },
);
```
Pushed any time the account's record changes (balance, nonce, code). Same shape as `provider.getAccount`.

### `subscribeLogs`

```ts
const unsub = await ws.subscribeLogs(
  {
    topics: [[transferTopic]], // positional topic-0 filter
    contract: "0xtoken...",     // restrict to one contract
    // from: { waveId, txIndex, eventIndex }, // optional resume cursor
  },
  (log) => {
    console.log("transfer:", log.waveId, log.topics, log.data);
  },
);
```

Filter shape (`LogSubscriptionFilter`):

| Field | Notes |
|---|---|
| `topics` | Up to 4 positional slots; `null` at position i = any. |
| `contract` | Optional address restriction. |
| `from` | Resume cursor `{ waveId, txIndex, eventIndex }` for at-least-once delivery after a reconnect. Omit to receive only events committed after subscription time. |

## Delivery semantics

- **At-least-once**, cursor-based. The provider tracks each subscription's last delivered cursor and re-subscribes on reconnect with `from: lastCursor`.
- **Listeners may see duplicates around a reconnect.** Dedupe by `(waveId, txIndex, eventIndex)` if you need exactly-once.
- Spec: `HOST_FN_ABI §15.5 LogSubscription`.

## Reconnect handling

WebSocketProvider reconnects automatically with exponential backoff:

```
delay = min(initialDelay * 2^attempt, maxDelay)
```

On a successful re-subscribe of every active sub, the attempt counter resets to 0. If `reconnectMaxAttempts` is set and exhausted, the provider:

1. Stops reconnecting.
2. Sets `lastError` to a `ConnectionError("WebSocket reconnect gave up after N attempts")`.
3. Fires the `terminalError` event.

### Terminal failure handling

```ts
ws.on("terminalError", (err) => {
  // E.g., re-create provider, show UI, log to telemetry.
  console.error("WS dead:", err.message);
});

ws.lastError; // ConnectionError | null
```

`on` / `off` accept the same listener signature. Calling `destroy()` removes all listeners.

## Lifecycle

```ts
ws.destroy(): void
```
Idempotent. Tears down the socket, removes all subscriptions, clears reconnect timers, removes event listeners.

In React, the `<PydeProvider>` handles `destroy()` on unmount automatically — see [Chapter 06](./06-react.md).

## Errors

| Class | When |
|---|---|
| `InvalidArgumentError` | `ws://` URL without `allowInsecureTransport: true`. |
| `ConnectionError` | Socket dropped + retries exhausted (`terminalError` event + `lastError`). |
| `TimeoutError` | RPC call exceeded `rpcTimeoutMs`. |
| `RpcError` | Chain returned a JSON-RPC error during subscribe. |

## Gotchas

- **`wsToHttp` preserves host/port/path/query/fragment** via the URL constructor. If your WS endpoint diverges from the HTTP endpoint (different path or query), pass `options.httpRpcUrl` explicitly.
- **Subscriptions are not durable across `destroy()`.** Resubscribe on rebuild.
- **`reconnectMaxAttempts: 0` (default) means infinite.** Set a finite cap in dapps that should surface failure to the user.
- **The cursor is per-subscription.** Two parallel `subscribeLogs` against the same filter have independent cursors.
- **Listeners run on the socket's microtask scheduler.** Don't `await` long work inside them — fire-and-forget or hand to a queue.
- **Engine-side gap:** as of this writing, the devnet doesn't expose `pyde_subscribe`. The SDK code is exercised in unit tests; live exercise will go green once the engine ships the method.
