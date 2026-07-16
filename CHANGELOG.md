# Changelog

All notable changes to `pyde-ts-sdk` ship here. Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once we hit 1.0; pre-1.0 we ship `0.x.y-beta.N` and break liberally between minors. Each entry calls out wire-format / behavior-altering changes explicitly.

## 0.2.0 — 2026-07-16

### Breaking — MEV protection is now commit-reveal, not threshold encryption

- **Removed the threshold-encryption surface.** `Wallet.sendEncrypted` / `transferEncrypted`, `Provider.sendRawEncryptedTransaction` / `getThresholdPublicKey`, the `EncryptedTxParams` / `ThresholdPublicKey` types, and the `buildRawEncryptedTx*` / `thresholdEncrypt` / `thresholdKeygen` / `generateDecryptionShare` / `combineShares` / `plaintextHashFromEncryptedParams` crypto helpers are gone. The engine physically removed the threshold lane; that RPC method no longer exists.
- **Added commit-reveal ("private tx"), the permanent front-running protection.** `Wallet.sendPrivate(inner)` runs the whole commit → reveal → execute flow in one call and returns a `PrivateSendHandle` whose `waitForReceipt()` resolves on the inner tx's receipt. `Wallet.transferPrivate(to, amount)` for value-only sends; low-level `Wallet.buildCommit` / `buildReveal` for relays. New wire primitives in `./private-tx`: `requiredBond`, `commitmentHash` (`Blake3("pyde-commit-reveal-v1" || innerTxBytes || nonce)`), `encodeCommitPayload`, `encodeRevealPayload`, plus the `MIN_COMMIT_BOND` / `COMMIT_BOND_BPS` / `COMMIT_REVEAL_WINDOW_WAVES` constants.
- **New tx types.** `TxType.Commit = 0x11`, `TxType.Reveal = 0x12` (with matching PascalCase RPC tag parsing). Wire-parity verified byte-for-byte against `otigen_commit_reveal_vectors_v1.json`.
- Blake3 for the commitment comes from `@noble/hashes` (already a dependency); no new deps. The vendored `pyde-crypto-wasm`'s threshold/encrypted exports are now unused and can be dropped on its next rebuild.
- **Guarantee framing:** commit-reveal prevents content-targeted front-running; it is not a total ordering lock against unrelated txs arriving in the reveal→execute window.
- **Docs + metadata.** The handbook is rewritten for commit-reveal; the former "Encrypted mempool" chapter is now [`docs/09-private-transactions.md`](./docs/09-private-transactions.md), and stale threshold/Kyber references across the docs, `README`, and `SECURITY.md` are gone. `package.json` keywords drop `kyber-768` / `ml-kem` and add `commit-reveal`.

## 0.1.0 — 2026-06-24

First stable release. Targets `pyde-engine` ≥ v0.2 and the vendored `pyde-crypto-wasm` shipped under `src/vendor/crypto-wasm/`.

### Highlights

- **Contract codec is borsh-canonical.** `Contract.encodeCall` produces the borsh-encoded `pyde_engine_types::CallPayload {function: String, calldata: Vec<u8>}` struct the chain's `pyde_call` and `tx.data` expect. The chain dispatches by function name, not by selector hash. Wire types: `u8/u16/u32/u64/u128/u256` are LE bytes at their natural width (1/2/4/8/16/32), `bool` is 1 byte, `String` / `Bytes` / `Vec<T>` are 4-byte LE length + payload, struct fields concatenate with no header, enums (unit variants only) are a 1-byte discriminant. Live-verified against `otigen/examples/borsh-coverage`.
- **Tx wire format matches `borsh::from_slice::<Tx>(...)` on the chain.** Signature framing is u32-LE Vec, `FeePayer::Sender` is a single discriminant byte (no extra length prefix), `Vec<AccessEntry>` is a flat count + entries (no outer byte wrapper). `hash_access_list` empty-case hashes `Poseidon2([0,0,0,0])` to match the engine.
- **`u64` wire fields are `bigint` end-to-end.** `Wave`, `Account.nonce`, `TxFields.nonce`, `Provider.getNonce`, `getWave`, `latestWaveId`, `Contract.queryFilter` bounds. No silent truncation above 2^53.
- **Type-safe contracts** via `Contract<TAbi>` + `pyde-tsgen`-emitted `<Name>Abi` shape. Narrows method names, arg shapes, return types, and event arg types.
- **HTTPS / WSS enforced at construction.** `Provider("http://…")` and `WebSocketProvider("ws://…")` throw without `allowInsecureTransport: true`. Devnet test setup opts in explicitly.
- **`BrowserWalletAdapter` re-verifies returned signed tx** matches the requested sender (partial wallet-substitution defense).
- **Handle-based wallets.** `Wallet.generate()` keeps the FALCON SK in the WASM heap; never enters the JS heap. `Wallet.fromKeystoreFile` + Argon2id + ChaCha20-Poly1305 keystore I/O for the encrypt-to-disk path.
- **Auto gas estimation via simulate.** `Wallet.sendCall` signs a probe tx, calls `pyde_simulateTransaction`, and uses real chain-reported `gas_used × gasMultiplier` (default `1.2`) plus the inferred access list on the real submit. `Wallet.transfer` uses a fixed 100k (plain transfers don't execute code). Override either via `opts.gasLimit` (pin) or `opts.gasMultiplier` (tune).
- **Structured `revertReason` on receipts.** `Receipt.revertReason: { category, message } | null` where `category ∈ { "EngineValidation", "Contract", "Vm" }`. `CallExceptionError` exposes `isEngineValidation` / `isContractRevert` / `isVmTrap` accessors so callers can branch on reject layer instead of pattern-matching on the message.
- **`Provider.getBaseFee` / `Provider.getFeeData`** wired to `pyde_getBaseFee` / `pyde_getFeeData` per the EIP-1559-per-wave engine change.
- **WS terminal-failure surface.** `ws.on("terminalError", fn)` + `ws.lastError` so dapps don't silently lose subscriptions after `reconnectMaxAttempts`.
- **`Provider.getAccount` distinguishes missing from zeroed.**
- **`scrubError` redacts long hex runs** (with or without `0x` prefix) so 897-byte FALCON pubkeys + 1,281-byte SKs never leak into error messages.
- **`keypairFromSeed`** exposes the engine's deterministic FALCON keygen so integration tests can derive devnet prefunded accounts locally — `Blake3("pyde-devnet-v1/" || i.to_le_bytes())`.
- **`WaveHeader` wire shape tolerance.** Engine ships `anchor_hash` as a byte array, `state_root` as `{blake3, poseidon2}` dual-hash, no `timestamp`. SDK adapter accepts all three forms.
- **`Receipt.status` tolerance.** Engine emits `status: "success" | "reverted" | "out_of_gas"` strings; SDK accepts both the string and the older boolean `success`. Optional fields (`effective_gas`, `fee_burned`, `fee_validator`, `logs`) fall back to `"0x0"` / `[]` when absent.
- **Production audit clean.** `npm run audit:prod` reports 0 vulnerabilities; CI gates at `--audit-level=high`. `npm overrides` pin `esbuild ^0.28.1` + `uuid ^11.1.1` to clear the dev-chain advisories.

### Public surface

See [`docs/README.md`](./docs/README.md) for the full reference. Subpath exports: `pyde-ts-sdk` (core), `pyde-ts-sdk/codegen` (programmatic codegen).

CLI: `pyde-tsgen <input.abi.json> <output.d.ts> [--name <Name>]`.

### Breaking from 0.0.x (unreleased)

- Contract codec switched to borsh. Pre-encoded calldata blobs are now invalid; regenerate via `Contract.encodeCall`. See [`docs/13-migration.md`](./docs/13-migration.md).
- `Wave`, all `u64` wire fields are `bigint`. Replace numeric literals with bigint literals (`0` → `0n`).
- `http://` / `ws://` URLs throw without `allowInsecureTransport: true`.
- `Wallet.destroy()` flips a `{ destroyed: true }` marker; subsequent signing throws `WalletDestroyedError`.

### Engine-side state

Every SDK surface listed under "Highlights" is live-verified against the current `otigen 0.1.0` engine. Remaining engine-side gaps are documented in `docs/13-migration.md` and are non-blocking for v1 dapp work:

- `WebSocketProvider.subscribeNewHeads` / `subscribeAccountChanges` — engine wires only the `logs` topic in catalog v0.1; both throw `RpcError("logs only in v1")` until the engine ships the additional topics. The `logs` path is live and covered by `tests/integration/ws.live.test.ts`.
- Multi-validator finality — `HardFinalityCert` is always `null` on single-validator devnet because `finality_quorum = QUORUM(85)`. The SDK surface is correct; live verification requires a multi-validator network.

### Verification

- Unit + property tests: 227/227 pass.
- Live integration tests: 89/89 pass against a freshly-spawned `otigen devnet` (zero skipped, zero failed). Coverage includes plain + encrypted-mempool submission, contract deploy + read + write, `RegisterPubkey` round-trip, structured `revertReason` on contract reverts, and WebSocket `subscribeLogs` lifecycle.
- Live contract round-trip: `Contract.read` for struct (`Order {id, maker: FixedBytes:32, items: Vec<String>, paid: Bool}`), enum (`Status` 3-variant), `Vec<u64>` deployed against `borsh-coverage`; state mutation + event emission + explicit revert path verified against `state-and-emit`.
