# 08 — WebSocketProvider

Live subscriptions over WSS. Three flavors: new waves, account changes, log events. Auto-reconnects on transient disconnect with cursor-based resume.

[← TOC](./README.md)

---

## Table of contents

- [Engine-side gap (read before using)](#engine-side-gap-read-before-using)
- [Construction](#construction)
- [`WebSocketProviderOptions` — every field explained](#websocketprovideroptions--every-field-explained)
- Subscriptions
  - [`subscribeNewHeads(listener)`](#subscribenewheadslistener)
  - [`subscribeAccountChanges(address, listener)`](#subscribeaccountchangesaddress-listener)
  - [`subscribeLogs(filter, listener)`](#subscribelogsfilter-listener)
- [Delivery semantics — at-least-once + cursor resume](#delivery-semantics--at-least-once--cursor-resume)
- Reconnect handling
  - [Backoff curve](#backoff-curve)
  - [`on("terminalError", listener)`](#onterminalerror-listener)
  - [`get lastError()`](#get-lasterror)
- Lifecycle
  - [`destroy()`](#destroy)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## Engine-side gap (read before using)

The devnet doesn't yet expose `pyde_subscribe` / `pyde_unsubscribe`. The SDK surface is complete; the live test sequence is in `tests/integration/ws.live.test.ts` and stays skipped until the engine ships these methods.

**This means:** every `subscribe*` call below returns `RpcError("method not found")` against the current devnet. Once the engine ships, no SDK change is needed — the same surface starts delivering live events.

---

## Construction

```ts
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("wss://rpc.pyde.network", {
  reconnectMaxAttempts: 5,
  rpcTimeoutMs: 30_000,
});
```

**Signature:**

```ts
new WebSocketProvider(wsUrl: string, options?: WebSocketProviderOptions)
```

**Args:**

| Name      | Type                       | Required | Description                                                              |
| --------- | -------------------------- | -------- | ------------------------------------------------------------------------ |
| `wsUrl`   | `string`                   | yes      | `wss://` endpoint. `ws://` throws unless `allowInsecureTransport: true`. |
| `options` | `WebSocketProviderOptions` | no       | See below.                                                               |

**Throws:** `InvalidArgumentError` for `ws://` URL without `allowInsecureTransport`.

---

## `WebSocketProviderOptions` — every field explained

```ts
interface WebSocketProviderOptions {
  webSocketConstructor?: WebSocketCtor;
  httpRpcUrl?: string;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  rpcTimeoutMs?: number;
  allowInsecureTransport?: boolean;
}
```

| Field                     | Type            | Default                              | What it does                                                                                                     |
| ------------------------- | --------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `webSocketConstructor`    | `WebSocketCtor` | `globalThis.WebSocket`               | Custom WS class. Use `ws` (the npm package) on Node < 22 without `--experimental-websocket`.                     |
| `httpRpcUrl`              | `string`        | wsUrl with `ws[s]://` → `http[s]://` | HTTP RPC URL used for non-subscription queries piggybacking on this provider. Path / query / fragment preserved. |
| `reconnectInitialDelayMs` | `number`        | `1_000`                              | Exponential backoff base.                                                                                        |
| `reconnectMaxDelayMs`     | `number`        | `30_000`                             | Cap on the delay between reconnect attempts.                                                                     |
| `reconnectMaxAttempts`    | `number`        | `0` (infinite)                       | After this many failures, fires `terminalError`.                                                                 |
| `rpcTimeoutMs`            | `number`        | `30_000`                             | Per-call timeout for `subscribe` / `unsubscribe` RPCs.                                                           |
| `allowInsecureTransport`  | `boolean`       | `false`                              | Required for `ws://`.                                                                                            |

**Example — production with bounded retries:**

```ts
const ws = new WebSocketProvider("wss://rpc.pyde.network", {
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 30_000,
  reconnectMaxAttempts: 10,
});

ws.on("terminalError", (err) => {
  // Show "disconnected" UI; the WS can't recover from here.
  console.error("ws dead:", err.message);
});
```

**Example — Node without native WebSocket:**

```ts
import WebSocket from "ws";

const ws = new WebSocketProvider("wss://rpc.pyde.network", {
  webSocketConstructor: WebSocket,
});
```

---

## `subscribeNewHeads(listener)`

Pushed every wave commit.

**Signature:**

```ts
ws.subscribeNewHeads(
  listener: (header: WaveHeader) => void,
): Promise<Unsubscribe>
```

**Returns:** `Promise<() => Promise<void>>` — call to tear down the subscription.

**Listener receives:** fully-decoded `WaveHeader`.

**Example:**

```ts
const unsub = await ws.subscribeNewHeads((header) => {
  console.log("wave:", header.waveId, "anchor:", header.anchor);
});

// 30 s later
await unsub();
```

**Expected output:**

```
wave: 100n anchor: 0x17a219ad...
wave: 101n anchor: 0xab12cd34...
wave: 102n anchor: 0x9f8e7d6c...
```

---

## `subscribeAccountChanges(address, listener)`

Pushed any time an account's record changes (balance, nonce, code).

**Signature:**

```ts
ws.subscribeAccountChanges(
  address: string,
  listener: (account: Account) => void,
): Promise<Unsubscribe>
```

**Args:**

| Name       | Type     | Description                               |
| ---------- | -------- | ----------------------------------------- |
| `address`  | `string` | 32-byte hex address to watch.             |
| `listener` | function | Called with the updated `Account` record. |

**Returns:** `Promise<Unsubscribe>`.

**Example:**

```ts
const unsub = await ws.subscribeAccountChanges("0xaddress...", (account) => {
  console.log("balance now:", account.balance);
});
```

---

## `subscribeLogs(filter, listener)`

Pushed when the chain commits a log matching the filter.

**Signature:**

```ts
ws.subscribeLogs(
  filter: LogSubscriptionFilter,
  listener: (log: Log) => void,
): Promise<Unsubscribe>
```

**`LogSubscriptionFilter`:**

```ts
interface LogSubscriptionFilter {
  topics?: (string[] | null)[]; // 4 positional slots, null = any
  contract?: string;
  from?: EventCursor; // resume from last delivered cursor
}
```

| Field      | Type                   | Description                                                                                                                                                          |
| ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topics`   | `(string[] \| null)[]` | Up to 4 positional topic slots. `null` at position i = wildcard at position i.                                                                                       |
| `contract` | `string`               | Optional address restriction.                                                                                                                                        |
| `from`     | `EventCursor`          | Resume from this `{waveId, txIndex, eventIndex}` cursor for at-least-once delivery after a reconnect. Omit to receive only events committed after subscription time. |

**Returns:** `Promise<Unsubscribe>`.

**Example — single-topic Transfer subscription:**

```ts
import { Contract } from "pyde-ts-sdk";
const token = await Contract.fromArtifact(abi, addr, provider);
const transferTopic = token.getEventTopic("Transfer");

const unsub = await ws.subscribeLogs(
  {
    topics: [[transferTopic]],
    contract: token.address,
  },
  (log) => {
    const ev = token.parseLog(log);
    if (ev) {
      console.log("Transfer:", ev.args.from, "→", ev.args.to);
    }
  },
);
```

**Example — multi-topic filter:**

```ts
// Match any event with topic[1] = aliceTopic OR bobTopic
await ws.subscribeLogs(
  {
    topics: [
      [transferTopic], // topic[0] = exact match
      [aliceTopic, bobTopic], // topic[1] = either
      null, // topic[2] = any
      null, // topic[3] = any
    ],
  },
  (log) => {
    /* … */
  },
);
```

---

## Delivery semantics — at-least-once + cursor resume

- **At-least-once.** The provider tracks each subscription's last delivered cursor and re-subscribes on reconnect with `from: lastCursor`.
- **Listeners may see duplicates around a reconnect.** Dedupe by `(waveId, txIndex, eventIndex)` if you need exactly-once.
- Spec: `HOST_FN_ABI §15.5 LogSubscription`.

**Recipe — exactly-once via dedupe:**

```ts
const seen = new Set<string>();
await ws.subscribeLogs({ topics: [[transferTopic]] }, (log) => {
  const key = `${log.waveId}-${log.txIndex}-${log.eventIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  process(log);
});
```

---

## Reconnect handling

### Backoff curve

```
delay = min(initialDelay * 2^attempt, maxDelay)
```

With defaults (`initialDelay = 1000`, `maxDelay = 30000`):

| Attempt | Delay         |
| ------- | ------------- |
| 1       | 1 s           |
| 2       | 2 s           |
| 3       | 4 s           |
| 4       | 8 s           |
| 5       | 16 s          |
| 6+      | 30 s (capped) |

On a successful re-subscribe of **every** active subscription, the attempt counter resets to 0.

---

### `on("terminalError", listener)`

Fires when `reconnectMaxAttempts` is exhausted.

**Signature:**

```ts
ws.on(event: "terminalError", listener: (error: Error) => void): void
```

**Listener receives:** `ConnectionError("WebSocket reconnect gave up after N attempts")`.

**Example:**

```ts
ws.on("terminalError", (err) => {
  console.error("WS dead:", err.message);
  // Re-create provider, show "disconnected" UI, log to telemetry…
});
```

After `terminalError`:

1. The provider stops reconnecting.
2. `ws.lastError` is populated.
3. Subsequent `subscribe*` calls reject with `ConnectionError`.

---

### `get lastError()`

The last terminal error (if any).

**Type:** `ConnectionError | null` (getter).

**Example:**

```ts
if (ws.lastError) {
  console.warn("ws unhealthy:", ws.lastError.message);
}
```

---

## `destroy()`

Idempotent teardown.

**Signature:**

```ts
ws.destroy(): void
```

**What it does:**

- Closes the socket.
- Removes all active subscriptions.
- Clears reconnect timers.
- Drops all event listeners (including `terminalError`).

**Example:**

```ts
const unsub = await ws.subscribeNewHeads(/* … */);
// later
await unsub();
ws.destroy();
```

In React, `<PydeProvider>` calls `destroy()` on unmount automatically.

---

## Errors

| Class                  | When                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `InvalidArgumentError` | `ws://` URL without `allowInsecureTransport: true`.                                            |
| `ConnectionError`      | Socket dropped + retries exhausted (fires `terminalError` + sets `lastError`).                 |
| `TimeoutError`         | RPC call exceeded `rpcTimeoutMs`.                                                              |
| `RpcError`             | Chain returned a JSON-RPC error during subscribe (e.g., `method not found` — engine-side gap). |

---

## Gotchas

- **`wsToHttp` preserves host/port/path/query/fragment** via the URL constructor. If your WS endpoint diverges from the HTTP endpoint, pass `options.httpRpcUrl` explicitly.
- **Subscriptions are not durable across `destroy()`.** Resubscribe on rebuild.
- **`reconnectMaxAttempts: 0` (default) means infinite.** Set a finite cap in dapps that should surface failure to the user.
- **The cursor is per-subscription.** Two parallel `subscribeLogs` against the same filter have independent cursors.
- **Listeners run on the socket's microtask scheduler.** Don't `await` long work inside — fire-and-forget or hand to a queue.
- **Engine-side gap:** the devnet doesn't yet expose `pyde_subscribe` / `pyde_unsubscribe`. Live exercise goes green once the engine ships the methods. See [README → Status](./README.md#status).
