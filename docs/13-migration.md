# 13 — Migration notes

Upgrade guidance between SDK versions. The SDK is pre-1.0; APIs may still shift before mainnet.

[← TOC](./README.md)

## Versioning

`package.json` is at `0.0.0` until the first npm publish. Until then, breaking changes are flagged here per major rewrite (audit cluster, codec rewrite, etc.) rather than per semver number.

The first publish will be `0.1.0-beta.1` against `pyde-engine` ≥ v0.2 and `pyde-crypto-wasm` matching.

## Unreleased — Tier-1 engine RPC catalog alignment (current `main`)

**Breaking** at the RPC method-name layer (the public SDK surface follows below).

The engine published its RPC catalog v0.1; the SDK was speaking ~7 method names that don't exist in the engine. This pass renames the wrong ones and trims surfaces with no engine equivalent. The public TS API moves only where the chain forces it.

| Old SDK                                                                         | New SDK                                                  | RPC method                 | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.getNonce` (`pyde_getNonce` → fallback `pyde_getTransactionCount`)     | `provider.getNonce` (canonical only)                     | `pyde_getTransactionCount` | Drops the dead first-attempt.                                                                                                                                                                                                                                                                                                                                                                       |
| `provider.getContractState(addr, slot)`                                         | `provider.getStorageSlot(slot)`                          | `pyde_getStorageSlot`      | Slots are **global** 32-byte keys in v1; caller computes the full key per `HOST_FN_ABI_SPEC §7.1`: `Poseidon2(self_address ‖ field_bytes ‖ key_bytes?)` where `field_bytes` is the author-chosen field-name bytes (e.g. `b"balances"`), not a numeric index. v1 has no per-contract prefix iteration.                                                                                               |
| `provider.latestWaveId()` (internal, `pyde_getWaveNumber` / `pyde_blockNumber`) | `provider.getWaveId()` (public)                          | `pyde_waveId`              | The catalog names this directly. `getWave()` no-arg now resolves through it.                                                                                                                                                                                                                                                                                                                        |
| `provider.getTransaction(hash)` (`pyde_getTransactionByHash`)                   | `provider.getTransaction(hash)`                          | `pyde_getTx`               | Method-name rename. Wire shape stays tolerated (the archival serde-derived form has byte arrays + JSON numbers — the parser accepts both).                                                                                                                                                                                                                                                          |
| `provider.getBaseFee()` + `provider.getFeeData()`                               | **removed**                                              | —                          | No `pyde_getBaseFee` / `pyde_gasPrice` in v1. Re-introduce when the engine adds a fee-market endpoint.                                                                                                                                                                                                                                                                                              |
| `provider.estimateGas(to, data, ...)` + `provider.estimateAccess(params)`       | `provider.simulateTransaction(signedTxHex)`              | `pyde_simulateTransaction` | Engine ships gas + access-list as a single dry-run. `Wallet.sendCall` now signs a probe tx, simulates, and uses real chain-reported `gas_used` × `gasMultiplier` (default `1.2`) plus the inferred access list on the real submit. Falls back to fixed 5M default on sim failure. `Wallet.transfer` keeps fixed 100k for plain transfers (catalog: `receipt: null` for plain-transfer simulations). |
| `provider.getSnapshotManifest(waveId)`                                          | `provider.getSnapshotManifest()`                         | `pyde_getSnapshotManifest` | Engine takes no params — it returns the manifest at the state store's `last_flushed_wave`.                                                                                                                                                                                                                                                                                                          |
| `provider.getHardFinalityCert(waveId)`                                          | `provider.getHardFinalityCert(waveId: number \| bigint)` | `pyde_getHardFinalityCert` | Accepts `bigint` too — engine wants a **bare u64 number** (not hex).                                                                                                                                                                                                                                                                                                                                |

Wire-shape fixes (no API change):

- **`getLogs`**: SDK was sending `contract: "0x..."` (singular); engine catalog expects `contracts: ["0x...", ...]` (plural array, within-array OR). The SDK now wraps the single `LogFilter.contract` field into a 1-element array on the wire.
- **`pyde_subscribe`**: SDK was sending `[{method: "logs", filter}]` (object envelope); engine expects positional `["logs", filter]`. `subscribeNewHeads` / `subscribeAccountChanges` now throw a clear "logs only in v1" `RpcError` locally instead of round-tripping to `INVALID_PARAMS`.

New methods added in the same pass (catalog v0.1 §8/§12/§13/§16–§21/§25):

| Method                                                | RPC                          | Notes                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.simulateTransaction(wireHex)`               | `pyde_simulateTransaction`   | Returns `{receipt, reads, writes}`. Powers `Wallet.sendCall` auto-estimate + access-list inference.                                                                                                                                      |
| `provider.getEvents({fromWave?, toWave?, contract?})` | `pyde_getEvents`             | Permissive event scan — malformed filters silently return `[]` instead of failing. Use `getLogs` when strict validation matters.                                                                                                         |
| `provider.getValidator(addr)`                         | `pyde_getValidator`          | Returns `ValidatorInfo` (operator, FALCON pubkey, stake, status, unbond / jail waves, last-claimed RPS, uptime bps). `null` if no validator at `addr`.                                                                                   |
| `provider.getOperatorValidators(addr)`                | `pyde_getOperatorValidators` | Reverse index — every validator-address an operator controls (cap 3 per staking model).                                                                                                                                                  |
| `provider.getNodeInfo()`                              | `pyde_getNodeInfo`           | Peer id + FALCON pubkey (`null` for full / archive nodes — gate "this node can sign" UX on the non-null variant) + listen multiaddrs + agent / protocol version.                                                                         |
| `provider.getMetrics()`                               | `pyde_getMetrics`            | Instantaneous `MainLoopMetrics` snapshot. For time-series scrape the Prometheus `/metrics` HTTP endpoint instead.                                                                                                                        |
| `provider.getReceiptArchival(hash)`                   | `pyde_getReceipt`            | Archival raw serde-derived shape (byte arrays, JSON numbers, PascalCase status). Different wire shape from `getTransactionReceipt`; SDK passes it through as `unknown` for explorers / indexers that consume canonical borsh-shape data. |
| `provider.getSnapshot()`                              | `pyde_getSnapshot`           | Standard-base64 (RFC 4648 §4 — not URL-safe) encoding the borsh-encoded `SnapshotBundle { manifest, chunks }`. Multi-MB on populated chains; consumers base64-decode → borsh-decode → `SnapshotLoader::apply`.                           |

Encrypted-mempool path is now wired (catalog v0.1 §8/§20):

- `provider.getThresholdPublicKey()` return shape changed from `Promise<string>` to `Promise<ThresholdPublicKey | null>` (`{epoch, scheme, publicKey}`). The catalog's `scheme: "mock"` boot default means encrypted submissions sit unprocessed until real Kyber-768 DKG lands — `Wallet.sendEncrypted` warns on `scheme !== "kyber-768"` so dapps can fall back to plaintext for real MEV protection.
- `Wallet.sendEncrypted` / `transferEncrypted` return `{envelopeHash}` instead of `Receipt`. The engine echoes back the **envelope hash** (Blake3 of `version ‖ ciphertext_len ‖ ciphertext`), distinct from the inner plaintext tx hash receipts key on post-decryption. Auto-polling for encrypted receipts is gated on a future inner-hash exposure on the wasm side — for now treat a successful return as "admitted to encrypted mempool".

What this still doesn't do (genuine engine / wasm gaps):

- Encrypted-tx receipt auto-polling — needs inner Tx plaintext hash exposed from `buildRawEncryptedTx` so the SDK can poll `getTransactionReceipt` against the right key.
- Strongly-typed `getReceiptArchival` parser — the wire shape uses byte arrays + JSON numbers + PascalCase status; SDK currently returns `unknown` and lets archival consumers decode. Add a typed parser when an explorer / indexer needs it.

## Unreleased — borsh codec + `CallPayload`

**Breaking.** Contract calldata wire format changed.

- The contract codec was rewritten from a host-fn-style layout (8-byte aligned ints, 24-byte Vec headers, length-prefixed structs) to **borsh-rs canonical** (1/2/4/8/16/32-byte LE ints, 4-byte LE Vec count, struct fields concatenated with no header).
- `Contract.encodeCall` now emits the borsh-encoded **`CallPayload {function, calldata}`** struct the chain expects — not a 4-byte selector + args. The chain dispatches by function name, not selector.
- `Contract.encodeCallArgs` is a new helper that returns just the borsh-encoded args (no `CallPayload` wrapper). Useful for byte-level comparison against a borsh-rs encoder.

| Type                 | Old encoding             | New (borsh)                    |
| -------------------- | ------------------------ | ------------------------------ |
| `u8`                 | 8 LE bytes               | 1 byte                         |
| `u16` `u32`          | 8 LE bytes               | 2 / 4 LE bytes                 |
| `u64`                | 8 LE bytes               | 8 LE bytes (unchanged)         |
| `bool`               | 8 LE bytes               | 1 byte                         |
| `String`             | 8-byte len + UTF-8 + pad | 4-byte LE len + UTF-8          |
| `Vec<T>`             | 24-byte header + items   | 4-byte LE count + items        |
| `Struct`             | 8-byte byte_len + fields | fields concatenated, no header |
| `Enum`               | 8-byte discriminant      | 1-byte variant index           |
| `Address` `[u8; 32]` | 32 raw bytes             | 32 raw bytes (unchanged)       |

**Action required:**

- If you were sending wire bytes you constructed manually, regenerate via `Contract.encodeCall`.
- If you were storing pre-computed calldata blobs in a DB, invalidate + re-encode.
- If you were comparing wire bytes against a borsh-rs encoder, the SDK now produces identical bytes.

Live-verified against `otigen/examples/borsh-coverage` — struct + enum + Vec live-round-trip in `tests/integration/contract.live.test.ts`.

## Unreleased — `u64` wire fields → bigint (H-1)

**Breaking.** Every `u64` wire field changed from `number` to `bigint`.

- `Wave` (the wave-id type) is now `bigint`.
- `Account.nonce`, `TxFields.nonce`, `TransactionInfo.nonce`, `EncryptedTxParams.nonce` are now `bigint`.
- `Provider.getNonce`, `Provider.getNonceAndChainId`, `Wallet.getNonce` return `bigint` / `[bigint, number]`.
- `Provider.getWave(waveId?)` takes `Wave` (bigint).
- `Provider.latestWaveId()` returns `Wave` (bigint).
- `Contract.queryFilter(name, fromWave?, toWave?)` takes `bigint?` for the wave bounds.
- React hooks: `useNonce` returns `AsyncState<bigint>`, `useWave` takes `Wave?`.

**Why:** JS Numbers lose precision above `2^53`. u64 fields on chain routinely exceed that range over a long-running validator's lifetime; silent truncation would corrupt downstream computation.

**Action required:**

- Replace numeric literals (`0`, `42`) with bigint literals (`0n`, `42n`) at call sites accepting wave / nonce.
- Update local persistence (JSON, DB) — `JSON.stringify` throws on bigint by default; use `replacer` to stringify.
- Wallet-builder code that constructs `TxFields` manually: set `nonce` as `bigint`.

## Unreleased — security cluster (H-2, H-3, M-6, M-7)

- **H-2 — HTTPS / WSS enforced at construction.** `new Provider("http://…")` now throws `InvalidArgumentError` unless `allowInsecureTransport: true` is passed. Same for `WebSocketProvider("ws://…")`. Add the opt-in to your devnet test setup; remove from any production code that had it.
- **H-3 — `BrowserWalletAdapter` re-verifies returned signed tx.** Extracts the first 32 bytes (the `from` field) from the wire bytes and asserts they match the requested sender. Throws `SigningError("returned signed tx sender != requested sender")` on mismatch. No caller-side change needed.
- **M-6 — `scrubError` catches non-`0x`-prefixed hex runs.** Error messages containing 200+ char raw hex (a 1,281-byte FALCON SK serialised) are now redacted. No API change.
- **M-7 — `wallet.destroy()` flips a `{ destroyed: true }` marker.** Subsequent signing methods throw `WalletDestroyedError` with a clear message — previously they threw a generic `Error`. Catch via `instanceof WalletDestroyedError` or `e.code === "SIGNING_ERROR"`.

## Unreleased — robustness + polish (M-1, M-4, M-5, L-1..L-6, D-1, D-3)

- **M-1 — `Contract<TAbi>` generic.** Add a `pyde-tsgen`-emitted `<Name>Abi` shape to narrow `read` / `write` / `queryFilter` / `parseLog`. See [Chapter 04 → Type-safe contracts](./04-contract.md#type-safe-contracts).
- **M-4 — `Provider.getAccount` distinguishes missing from zeroed.** Returns `null` when the wire envelope is empty (no on-chain record), the populated `Account` when zero-valued but registered.
- **M-5 — `WebSocketProvider` surfaces terminal reconnect failure.** New `on("terminalError", fn)` + `lastError` accessor.
- **L-2/L-3 — `Wallet.transfer` / `sendCall` auto-estimate `gasLimit`.** Calls `provider.estimateGas` with a 1.2× safety multiplier. Override via `opts.gasLimit` (pin) or `opts.gasMultiplier` (tune).
- **L-6 — `wsToHttp` preserves host/port/path/query/fragment** via the URL constructor.
- **D-1 — stale `gasLimit: 100_000_000` doc samples removed.** Real callers should omit it and let the auto-estimate handle it.

## Unreleased — dev-dep upgrade (M-2)

`vitest` 2 → 3, `tsup` 8.3 → 8.5. `npm` `overrides` pin `esbuild ^0.28.1` + `uuid ^11.1.1` to clear the dev-chain advisories. Production audit is 0 vulnerabilities and gated in CI at `--audit-level=high`.

**Action required:** `npm install` to pull the new lockfile.

## Future — when `pyde-crypto-wasm` ships `keypairFromSeed`

The wallet end-to-end live test stays skipped until either `pyde-crypto-wasm.keypairFromSeed(seed: Uint8Array)` lands (lets the SDK re-derive devnet prefunded keys locally) or `otigen wallet transfer` ships. No SDK API change is anticipated.

## Future — when the engine exposes `pyde_subscribe`

The WebSocket subscription path is wired but unverified live. No SDK API change expected when the engine catches up.

## Future — local wasmtime simulation (v1.1 Tier 1)

`simulateTransaction` / `previewTransaction` currently route via the provider's `estimateGas` / `estimateAccess` / `call` (RPC-backed). v1.1 will replace with a local wasmtime executor + provider-backed host fns — same callable surface, same return type, just `source: "local"` instead of `source: "rpc"`. **No caller-side change** required at the v1.1 transition.

## Removal log (for greppability)

- `stripHex` (from `contract.ts`) — was unused; remove from imports.
- `asStringOrNumber` (from `provider.ts`) — was unused; remove from imports.
