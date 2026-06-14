# Changelog

All notable changes to `pyde-ts-sdk` ship here. Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once we hit 1.0; pre-1.0 we ship `0.x.y-beta.N` and break liberally between minors. Each entry calls out wire-format / behavior-altering changes explicitly.

## 0.1.0-beta.1 — Unreleased

First publishable release. Targets `pyde-engine` ≥ v0.2 and `pyde-crypto-wasm` matching.

### Highlights

- **Contract codec is borsh-canonical.** `Contract.encodeCall` produces the borsh-encoded `pyde_engine_types::CallPayload {function: String, calldata: Vec<u8>}` struct the chain's `pyde_call` and `tx.data` expect. The chain dispatches by function name, not by selector hash. Wire types: `u8/u16/u32/u64/u128/u256` are LE bytes at their natural width (1/2/4/8/16/32), `bool` is 1 byte, `String` / `Bytes` / `Vec<T>` are 4-byte LE length + payload, struct fields concatenate with no header, enums (unit variants only) are a 1-byte discriminant. Live-verified against `otigen/examples/borsh-coverage`.
- **Tx wire format matches `borsh::from_slice::<Tx>(...)` on the chain.** Signature framing is u32-LE Vec, `FeePayer::Sender` is a single discriminant byte (no extra length prefix), `Vec<AccessEntry>` is a flat count + entries (no outer byte wrapper). `hash_access_list` empty-case hashes `Poseidon2([0,0,0,0])` to match the engine.
- **`u64` wire fields are `bigint` end-to-end.** `Wave`, `Account.nonce`, `TxFields.nonce`, `EncryptedTxParams.nonce`, `Provider.getNonce`, `getWave`, `latestWaveId`, `Contract.queryFilter` bounds, React `useNonce` / `useWave`. No silent truncation above 2^53.
- **Type-safe contracts** via `Contract<TAbi>` + `pyde-tsgen`-emitted `<Name>Abi` shape. Narrows method names, arg shapes, return types, and event arg types.
- **HTTPS / WSS enforced at construction.** `Provider("http://…")` and `WebSocketProvider("ws://…")` throw without `allowInsecureTransport: true`. Devnet test setup opts in explicitly.
- **`BrowserWalletAdapter` re-verifies returned signed tx** matches the requested sender (partial wallet-substitution defense).
- **Handle-based wallets.** `Wallet.generate()` keeps the FALCON SK in the WASM heap; never enters the JS heap. `Wallet.fromKeystoreFile` + Argon2id + ChaCha20-Poly1305 keystore I/O for the encrypt-to-disk path.
- **Auto gas estimation.** `Wallet.transfer` / `sendCall` call `provider.estimateGas` with a 1.2× safety multiplier by default. Override via `opts.gasLimit` (pin) or `opts.gasMultiplier` (tune).
- **WS terminal-failure surface.** `ws.on("terminalError", fn)` + `ws.lastError` so dapps don't silently lose subscriptions after `reconnectMaxAttempts`.
- **`Provider.getAccount` distinguishes missing from zeroed.**
- **`scrubError` redacts long hex runs** (with or without `0x` prefix) so 897-byte FALCON pubkeys + 1,281-byte SKs never leak into error messages.
- **`keypairFromSeed`** exposes the engine's deterministic FALCON keygen so integration tests can derive devnet prefunded accounts locally — `Blake3("pyde-devnet-v1/" || i.to_le_bytes())`.
- **`WaveHeader` wire shape tolerance.** Engine ships `anchor_hash` as a byte array, `state_root` as `{blake3, poseidon2}` dual-hash, no `timestamp`. SDK adapter accepts all three forms.
- **`Receipt.status` tolerance.** Engine emits `status: "success" | "reverted" | "out_of_gas"` strings; SDK accepts both the string and the older boolean `success`. Optional fields (`effective_gas`, `fee_burned`, `fee_validator`, `logs`) fall back to `"0x0"` / `[]` when absent.
- **Production audit clean.** `npm run audit:prod` reports 0 vulnerabilities; CI gates at `--audit-level=high`. `npm overrides` pin `esbuild ^0.28.1` + `uuid ^11.1.1` to clear the dev-chain advisories.

### Public surface

See [`docs/README.md`](./docs/README.md) for the full reference. Subpath exports: `pyde-ts-sdk` (core), `pyde-ts-sdk/react` (hooks), `pyde-ts-sdk/codegen` (programmatic codegen).

CLI: `pyde-tsgen <input.abi.json> <output.d.ts> [--name <Name>]`.

### Breaking from 0.0.x (unreleased)

- Contract codec switched to borsh. Pre-encoded calldata blobs are now invalid; regenerate via `Contract.encodeCall`. See [`docs/13-migration.md`](./docs/13-migration.md).
- `Wave`, all `u64` wire fields are `bigint`. Replace numeric literals with bigint literals (`0` → `0n`).
- `http://` / `ws://` URLs throw without `allowInsecureTransport: true`.
- `Wallet.destroy()` flips a `{ destroyed: true }` marker; subsequent signing throws `WalletDestroyedError`.

### Engine-side gaps (not SDK)

The following SDK surfaces are implemented and unit-tested but cannot be live-verified until the corresponding engine work lands:

- `WebSocketProvider.subscribe*` — engine doesn't expose `pyde_subscribe` / `pyde_unsubscribe`.
- `Wallet.sendEncrypted` / `Wallet.transferEncrypted` — engine doesn't expose `pyde_sendRawEncryptedTransaction` or `pyde_getThresholdPublicKey`.
- `Provider.estimateGas` — engine has no `pyde_estimateGas`. Auto-estimate falls back to a hardcoded default (100k / 5M).
- `Provider.getBaseFee` / `Provider.getFeeData` — engine has neither `pyde_getBaseFee` nor `pyde_gasPrice`.
- `Provider.getWave()` no-arg latest path — engine has no `pyde_getWaveNumber` / `pyde_blockNumber`.
- `Wallet.registerPubkey` against `otigen devnet` — devnet's tx dispatcher (`engine/crates/node/src/devnet/state.rs:1006-1028`) doesn't include `RegisterPubkey` in `apply_via_native_handler`. The production handler `handle_register_pubkey` is fine; only the devnet route is missing.

### Verification

- Unit + property tests: 114/114 pass.
- Live integration tests: 11/17 pass (the 6 skipped have precise rationales pointing at the engine-side gap each is gated on).
- Live contract round-trip: `Contract.read` for struct (`Order {id, maker: FixedBytes:32, items: Vec<String>, paid: Bool}`), enum (`Status` 3-variant), `Vec<u64>` deployed against `borsh-coverage`.
