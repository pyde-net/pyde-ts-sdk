# 06 — React hooks

Optional React integration. Same RPC + signing surface as the rest of the SDK, exposed through hooks. SSR-safe — no `window` access during render.

[← TOC](./README.md)

## Install

The React surface is a subpath export:

```ts
import { PydeProvider, useBalance } from "pyde-ts-sdk/react";
```

`react` is a peer dependency (`>=18.0.0`). The main SDK doesn't pull it in.

## `<PydeProvider>` — context root

Wrap your app:

```tsx
import { PydeProvider } from "pyde-ts-sdk/react";

function App() {
  return (
    <PydeProvider
      rpcUrl="https://rpc.pyde.network"
      wsUrl="wss://rpc.pyde.network"
    >
      <Dapp />
    </PydeProvider>
  );
}
```

Props:

| Prop | Type | Notes |
|---|---|---|
| `rpcUrl` | `string` | HTTPS RPC endpoint. `Provider` is constructed under the hood. |
| `wsUrl` | `string?` | Optional WSS URL. If omitted, `useLiveWave` / `useEvents` poll over HTTP instead. |
| `signer` | `Wallet?` | Optional bound wallet — surfaced via `usePydeSigner()`. |
| `children` | `ReactNode` | Your app. |

## Escape hatches

When you need the raw provider / WS / signer (e.g., for `Contract` construction):

```ts
import {
  usePydeProvider,    // Provider — always defined inside <PydeProvider>
  usePydeWebSocket,   // WebSocketProvider | null
  usePydeSigner,      // Wallet | null
} from "pyde-ts-sdk/react";
```

Each throws if used outside `<PydeProvider>`.

## Read hooks

All read hooks return:

```ts
interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => Promise<T | null>;
}
```

### `useBalance`

```ts
const { data: balance, loading, error, refetch } = useBalance(address);
```
Returns `AsyncState<bigint>`. Re-runs when `address` or the bound provider changes. Use `formatPyde(balance)` to render.

### `useNonce`

```ts
const { data: nonce } = useNonce(address);
```
Returns `AsyncState<bigint>`.

### `useAccount`

```ts
const { data: account } = useAccount(address);
```
Returns `AsyncState<Account | null>` — full account record, or `null` if not on chain.

### `useWave`

```ts
const { data: header } = useWave(waveId);
```
Returns `AsyncState<WaveHeader | null>`. Omit `waveId` for "latest" (subject to engine-side `pyde_getWaveNumber` availability — see [README → Status](./README.md#status)).

## Live subscriptions

### `useLiveWave`

```ts
const wave = useLiveWave();
```
Pushed wave headers — re-renders on every new commit. Returns `WaveHeader | null`.

Backing transport:
- If `<PydeProvider>` has a `wsUrl`, subscribes via `WebSocketProvider.subscribeNewHeads`.
- Otherwise polls `provider.getWave()` every ~2 s.

### `useEvents`

```ts
const logs = useEvents({
  fromWave?: Wave,
  toWave?: Wave,
  topics: [[topicHex0], null, null, null],
  contract?: string,
});
```
Returns `Log[]` — accumulates as new matching events arrive. Same subscription transport rules as `useLiveWave`. See [WebSocketProvider](./08-websocket.md) for filter semantics.

## Contract hooks

### `useContract`

```ts
const { contract, ready, error } = useContract({
  abiJson: "<artifact json>",
  address: "0xcontract...",
});
```
Loads ABI on mount + binds the current provider. `contract` is `null` until `ready === true`.

If `usePydeSigner()` resolves a wallet, the hook auto-binds it so `contract.write(...)` works without an extra `connect()`.

## SSR safety

- `PydeProvider` never touches `window` during render.
- `WebSocketProvider` instantiation is deferred to a `useEffect` so server-side renders don't crash on missing `WebSocket`.
- HTTP polling fallbacks also defer to `useEffect`.

## Cleanup

`<PydeProvider>` tears down the `WebSocketProvider` on unmount / `wsUrl` change. Hooks abort in-flight HTTP requests when their dep arrays change.

## Errors

Each hook surfaces caught errors via `state.error`. Render-time `throw` is reserved for usage outside `<PydeProvider>` — that's a programmer error, not a runtime condition.

## Recipe — dapp skeleton

```tsx
import {
  PydeProvider, useBalance, useLiveWave, usePydeSigner,
} from "pyde-ts-sdk/react";
import { Wallet, formatPyde } from "pyde-ts-sdk";

const wallet = Wallet.generate();
wallet.connect(/* see App below */);

function App() {
  return (
    <PydeProvider
      rpcUrl="https://rpc.pyde.network"
      wsUrl="wss://rpc.pyde.network"
      signer={wallet}
    >
      <Wallet />
      <LiveWave />
    </PydeProvider>
  );
}

function Wallet() {
  const signer = usePydeSigner();
  const { data: balance, loading } = useBalance(signer?.address);
  if (loading || !balance) return <p>loading…</p>;
  return <p>{formatPyde(balance)} PYDE</p>;
}

function LiveWave() {
  const wave = useLiveWave();
  return <p>wave: {wave?.waveId.toString() ?? "—"}</p>;
}
```

## Gotchas

- **`useLiveWave` polls every 2 s if `wsUrl` is omitted.** Pass `wsUrl` for push semantics in dapps that need real-time freshness.
- **`useContract` re-runs on every `abiJson` change.** Memoize the ABI string outside the component or stash it in a top-level constant.
- **`useEvents` accumulates indefinitely.** Pages with long sessions should reset state (e.g., clear after a wave threshold) to avoid unbounded `Log[]` growth.
- **No automatic retries** on error — call `refetch()` from your error UI.
- **`signer` prop is optional.** If your app derives the wallet asynchronously (e.g., after `fromKeystoreFile`), pass `signer` from state after it's loaded.
