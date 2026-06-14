# Notes for the pyde-rust-sdk session — gaps + design drift vs pyde-ts-sdk

I audited every file under `pyde-rust-sdk/src/` and compared against `pyde-ts-sdk` at commit `94f64ce` (v0.1.0-beta.1 prep). Below is what I found that *might* need attention. **Not fixing anything in pyde-rust-sdk — just flagging for your review.** Use whichever you agree with, ignore the rest.

This message is structured so you can forward it as-is. Each item is independent.

---

## ✅ Things both SDKs handle the same way

So you know I actually looked:

- **Borsh wire format for contract calldata.** Both use `borsh::BorshSerialize` (Rust) / a mirror codec (TS) producing identical bytes.
- **`CallPayload {function: String, calldata: Vec<u8>}`** wrapping for `pyde_call` and `tx.data`.
- **FALCON-512 signing, Poseidon2 hashing, 32-byte addresses with no truncation.**
- **16-slot sliding nonce window, u64 nonces represented as `bigint` on the TS side.**
- **At-least-once log subscription with cursor-based resume.**
- Both SDKs have `WebSocket` surfaces; both are blocked client-side until the engine ships `pyde_subscribe`.

---

## 🔴 Items the TS SDK has but pyde-rust-sdk might be missing (or could differ on purpose)

Just flagging — many of these might be intentional design choices in Rust land.

### 1. `keypairFromSeed` for devnet account re-derivation

The TS SDK exposes (and `pyde-crypto-wasm` now ships) a `keypair_from_seed(seed: &[u8; 32])` that wraps `pyde_crypto::falcon::falcon_keygen_deterministic`. Lets the TS integration tests re-derive `devnet-i` locally via `Blake3("pyde-devnet-v1/" || i.to_le_bytes())` without round-tripping through the otigen keystore.

**Rust SDK has:** `LocalSigner::from_seed(seed: &[u8; 32])`. ✅ Already there. Just confirming naming parity.

### 2. Status string vs boolean in Receipt

Engine emits `Receipt.status` as a **string** (`"success" | "reverted" | "out_of_gas"`), not a boolean. Older specs / test fixtures sometimes still use boolean `success`. TS SDK reads both shapes.

**Action item maybe:** does `pyde-rust-sdk/src/types/rpc.rs::Receipt` deserialize the string `status` field, or does it expect boolean? If string, you might want to add helpers like `is_success() -> bool` that map the variants cleanly.

Rust SDK already has `Receipt::is_success()` per the inventory — but worth double-checking it reads the string form correctly.

### 3. Receipt's optional fields tolerance

Devnet receipts ship sparser than mainnet: `effective_gas`, `fee_burned`, `fee_validator`, `logs` may all be missing. TS SDK falls back to `"0x0"` / `[]` so callers see a stable shape.

**Action item maybe:** check whether `pyde-rust-sdk` errors out on missing fields in `Receipt`. If yes, consider `#[serde(default)]` for those fields.

### 4. WaveHeader wire-shape tolerance

Engine ships:

```json
{
  "wave_id": 0,
  "anchor_hash": [...],
  "state_root": { "blake3": [...], "poseidon2": [...] },
  "events_root": [...],
  "tx_count": 0,
  ...
}
```

i.e. `anchor_hash` as a 32-byte JSON **array** (not hex string), and `state_root` as a `{blake3, poseidon2}` dual-hash struct.

TS SDK tolerates: hex string, byte array, and `{blake3, poseidon2}` struct. Surfaces the Blake3 leg (execution-side authority).

**Action item maybe:** confirm `pyde-rust-sdk` reads the dual-hash `state_root` correctly. If `WaveHeader.state_root: String` is expected, deserialization will fail against the engine's actual JSON shape.

### 5. `Account` distinguished from `Account-with-zero-balance`

`pyde_getAccount` returns a populated zero-account for unknown addresses on some engine builds (`account_type: "eoa"`, `balance: 0x0`, etc.) and `null` on others. TS SDK's `getAccount` distinguishes:

- `null` when the wire envelope is empty (no on-chain record).
- populated `Account` when zero-valued but actually registered.

**Action item maybe:** consider whether `pyde-rust-sdk::Provider::get_account` returns `Option<AccountInfo>` and how it distinguishes "absent" from "zeroed". The wire envelope check (`!o.address && !o.nonce && !o.balance` → null) is the heuristic the TS side uses.

### 6. `BrowserWalletAdapter`-style sender verification

When a wallet (browser extension) returns a signed tx to a dapp, the dapp shouldn't trust the bytes blindly. The TS SDK's `BrowserWalletAdapter` extracts the first 32 bytes of the wire tx (the `from` field) and asserts they match the address the dapp requested. Throws `SigningError("returned signed tx sender != requested sender")` if not.

**Not applicable to Rust SDK** since there's no analogous browser-extension surface — but worth noting if `pyde-rust-sdk` ever grows a remote-signer trait, the same threat model applies.

### 7. Gas auto-estimate with safety multiplier

TS SDK's `Wallet::transfer` / `Wallet::send_call` (sendCall) call `provider.estimateGas(...)` internally and multiply by a default `1.2` safety margin before submission. Override via `opts.gasLimit` or `opts.gasMultiplier`.

**Action item maybe:** consider exposing a `WithGasMultiplier(f64)` builder method on `TxBuilder` or a high-level `Wallet::transfer` helper that auto-estimates. Rust SDK currently has `tx_builder.gas_limit(u64)` only — caller has to do the math.

---

## 🔴 Items pyde-rust-sdk has that the TS SDK doesn't (and might need to add)

These are good design choices in Rust land. Flagging because **the TS SDK might want to add equivalents**. Not asking you to fix anything in Rust.

### A. `Address` derivation helpers

Rust SDK has:

```rust
Address::from_pubkey(pubkey)         // EOA derivation — ✅ TS has this (deriveAddress)
Address::create(deployer, nonce)     // CREATE address derivation
Address::create2(deployer, salt, code_hash)  // CREATE2 (Solidity-style)
Address::from_contract_name(name)    // contract-name derivation
```

**TS SDK gap:** only `deriveAddress(publicKey)` for EOA. The other three derivations are missing. Will add to a follow-up if these are actually used in production.

### B. `TxBuilder` chainable pattern

Rust SDK has:

```rust
TxBuilder::new()
  .from(addr)
  .to(target)
  .chain_id(31337)
  .nonce(0)
  .value(1000)
  .gas_limit(100_000)
  .transfer(to, amount)           // shorthand
  .register_pubkey(&pubkey)       // shorthand
  .stake_deposit(stake)           // shorthand
  .claim_reward()                 // shorthand
  .multisig_treasury_spend(...)   // shorthand
  .deploy(name, wasm, init_data)  // shorthand
  .call(to, func_name, args)      // shorthand
  .build()?
```

**TS SDK gap:** `TxFields` is just a record type. No chainable builder. Each high-level tx type lives as a separate method on `Wallet`. Might be worth adding a `TxBuilder` class to TS for parity.

### C. Multisig module

Rust SDK has a complete `src/multisig.rs`:

```rust
pub const DOMAIN_MULTISIG_TX: u8 = 0x09;
pub const DOMAIN_ROTATE_MULTISIG: u8 = 0x0A;
pub const DOMAIN_EMERGENCY_PAUSE: u8 = 0x0B;
pub const DOMAIN_EMERGENCY_RESUME: u8 = 0x0C;
pub const DOMAIN_DISPUTE_SLASH: u8 = 0x10;

pub fn domain_byte(tx_type: TxType) -> Option<u8>;
pub fn canonical_msg(tx_type: TxType, nonce: u64, payload: &[u8]) -> Option<[u8; 32]>;
pub struct BundleEntry { ... }
pub type SigBundle = Vec<BundleEntry>;
pub struct MultisigTxPayload { ... }
pub async fn sign_action(signer: &dyn Signer, signer_index: u32, tx_type: TxType, nonce: u64, payload: &[u8]) -> Result<BundleEntry>;
```

**TS SDK gap:** multisig is entirely absent. Will add when there's a real use case.

### D. ABI extraction from WASM custom section

Rust SDK has:

```rust
pub const PYDE_ABI_SECTION_NAME: &str = "pyde.abi";
pub const MAX_SUPPORTED_ABI_VERSION: u32;
pub fn extract_abi(wasm: &[u8]) -> Result<ContractAbi>;
pub fn extract_abi_section(wasm: &[u8]) -> Result<&[u8]>;
```

**TS SDK gap:** only reads pre-extracted `abi.json`. Can't parse the `pyde.abi` custom section from a `.wasm` directly. Could add via the `wasm-parser` package if anyone needs it.

### E. ErrorCode enum

Rust SDK has the full 24-variant `ErrorCode` enum (per HOST_FN_ABI §4): `ERR_ACCESS_LIST_VIOLATION`, `ERR_CIPHERTEXT_INVALID`, `ERR_CROSS_CALL_FAILED`, `ERR_OUT_OF_GAS`, `ERR_REENTRANCY`, `ERR_INSUFFICIENT_BALANCE`, etc. Maps to `SdkError::HostFn { code, message }`.

**TS SDK gap:** only has the 8 high-level error classes. Chain-side host-fn error codes are surfaced inside `CallExceptionError.reason` as a string but no programmatic enum.

### F. Constants exposed as module-level

Rust SDK exports a clean set of `pub const`s:

```rust
GAS_TRANSFER: u64 = 100_000
GAS_ERC20_CALL: u64 = 500_000
GAS_ERC721_CALL: u64 = 1_000_000
GAS_DEPLOY: u64 = 10_000_000
GAS_CROSS_CALL_ORCHESTRATOR: u64 = 2_000_000
MAX_TX_SIZE: usize = 128 * 1024
MAX_CALLDATA: usize = 64 * 1024
MIN_GAS_LIMIT: Gas = 21_000
NONCE_WINDOW_SIZE: usize = 16
ADDRESS_LEN: usize = 32
FALCON_PUBKEY_LEN: usize = 897
FALCON_SECRET_LEN: usize = 1281
FALCON_SIG_MAX_LEN: usize = 690
HASH_LEN: usize = 32
DOMAIN_*  (5 multisig domain bytes)
```

**TS SDK gap:** these live in docs but aren't actual exports. Could expose as `Constants` namespace. Worth doing for parity.

### G. `Transport` trait abstraction

Rust SDK has a clean `Transport` trait + `HttpTransport` + `WsTransport` impls, with `RetryConfig` builder.

**TS SDK gap:** `Provider` is fetch-based directly. No transport abstraction. Means harder to plug in a custom transport (e.g., for offline signing relayers or in-memory mocks).

### H. `PendingTx` pattern

Rust SDK's `send_raw_transaction` returns a `PendingTx` handle with `.wait_for_receipt()`, `.with_poll_interval()`, `.with_timeout()`. Composable.

**TS SDK gap:** `sendRawTransaction` returns `TransactionResponse` with a `wait()` method; `sendAndWait` is a separate method. Less composable.

### I. RPC methods present in Rust SDK but not in TS

The 23 RPC methods the Rust `Provider` trait exposes — TS SDK is missing:

- `pyde_waveId` — Rust has direct wave-id getter. TS only has internal `latestWaveId` that's engine-blocked.
- `pyde_getNodeInfo` — Rust has `get_node_info()`. TS missing.
- `pyde_getMetrics` — Rust has `get_metrics()`. TS missing.
- `pyde_simulateTransaction` — Rust has `simulate_transaction()`. TS has `simulateTransaction` but it's RPC-backed via other methods, not the dedicated simulate RPC.
- `pyde_getTx` — Rust has both `get_receipt()` and `get_tx()` separately. TS has both but called `getTransaction` / `getTransactionReceipt`.
- `pyde_getEvents` (vs `pyde_getLogs`) — Rust exposes both. TS only `getLogs`.
- `pyde_getValidator` — Rust has `get_validator()`. TS missing.
- `pyde_getOperatorValidators` — Rust has `get_operator_validators()`. TS missing.
- `pyde_getSnapshot` — Rust has full snapshot getter. TS has only `getSnapshotManifest`.

Not sure which of these are actually engine-supported today vs spec-only — but TS could probably add stubs that match.

### J. `Signer` trait

Rust SDK has a clean `Signer` trait + `LocalSigner` impl. Lets users plug in remote / hardware signers behind the same interface.

**TS SDK gap:** has `AbstractSigner` (in `signer.ts`) but `Wallet` doesn't use it through a trait — it's just a method-level interface. `WalletAdapter` is the dapp-facing version but uses different abstraction. Could unify.

---

## 🟡 Cross-SDK consistency questions

These are design questions where the two SDKs disagree. Worth a quick alignment call.

### α. Keystore AEAD

- Rust SDK keystore: **AES-256-GCM**
- TS SDK keystore: **ChaCha20-Poly1305**

Both use Argon2id KDF, but the AEADs differ — so **keystores aren't portable across SDKs**. Probably intentional (each ecosystem has preferred primitives) but worth knowing.

### β. Wave-not-block naming

Per `wave_not_block_terminology.md`: wave-not-block applies to internal Rust types + field names too, not just host-fn surface.

Rust SDK has both `BlockHeader` and `WaveHeader` as separate types in `src/types/rpc.rs`. Worth checking whether `BlockHeader` is intentional (legacy compat) or should be removed.

### γ. `LogFilter` shape

- Rust SDK `LogFilter`:
  - `addresses: Option<Vec<String>>` (plural — multiple addresses)
  - `topics: Option<Vec<Option<Vec<String>>>>`
  - `from_block / to_block` (block, not wave)
  - `page_size, cursor`
- TS SDK `LogFilter`:
  - `contract: string` (single)
  - `topics: (string[] | null)[]` (4 positional slots)
  - `fromWave / toWave` (bigint)
  - `limit, cursor`

These look intentionally different shapes but worth confirming the engine's actual RPC accepts both.

### δ. `Log` shape

Rust SDK `Log` carries: `address, topics, data, block_number, transaction_hash, transaction_index, block_hash, log_index, removed`.

TS SDK `Log` carries: `waveId, txIndex, eventIndex, contract, topics, data`.

The naming divergence (wave vs block, txIndex vs transaction_hash, etc.) is significant. The engine returns one shape — both SDKs should converge on it.

### ε. WebSocket subscription targets

Rust SDK rejects most subscribe targets client-side with "not yet supported":
- `subscribe_logs` ✅ (the only one actually wired)
- `subscribe_new_waves` ⚠️ client-side reject
- `subscribe_pending_txs` ⚠️ client-side reject
- `subscribe_events` ⚠️ client-side reject

TS SDK has the same pattern — all three subscribe methods are wired but blocked at the engine level.

Worth aligning the client-side reject message and behavior across both SDKs.

---

## What I'd suggest as the priority list (for your next session, your call)

1. **WaveHeader dual-hash tolerance** (if not already there) — high impact, low effort. The engine ships `state_root: {blake3, poseidon2}` and the SDK might be failing to deserialize it.
2. **Receipt status string parsing** — same reason; the engine's wire shape is the string form.
3. **`pyde_getValidator` / `pyde_getOperatorValidators`** — if these are actually exposed in the engine, the Rust SDK is ahead of the TS SDK and the TS side should add them.
4. **Constants module** — quick win, both SDKs should expose a single source of truth.

The rest of the items can wait until there's a concrete user request.

---

That's everything I noticed. The Rust SDK is in great shape — these are corner-case alignment items, not architecture issues. Happy to dig deeper into any one of them.
