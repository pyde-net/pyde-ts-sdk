# 03 — Wallet

FALCON-512 signing, keystore I/O, transfer / sendCall / deploy / encrypted-send.

[← TOC](./README.md)

## Two key shapes

The same `Wallet` class wraps two different secret-key holdings:

| | Handle-backed (default) | Hex-backed |
|---|---|---|
| Constructor | `Wallet.generate()` | `Wallet.generateUnsafe()`, `Wallet.fromKeys`, `Wallet.fromEncrypted` |
| Where the SK lives | WASM linear memory | JS heap (as a hex string) |
| Survives a JS heap dump? | ✅ Yes | ❌ No — visible as a string |
| Can `toKeystore` export? | ❌ No (no hex to encrypt) | ✅ Yes |
| Encrypted `sendEncrypted`? | ❌ Not yet (needs `buildRawEncryptedTxWithHandle`) | ✅ Yes |

**Recommendation:** use `generate()` and `fromEncrypted()` for everything except keystore export. When you need to export, use `generateUnsafe()`, immediately `toKeystore` + write, and `destroy()` the wallet.

## Constructors

```ts
Wallet.generate(): Wallet
```
Fresh handle-backed keypair. SK in WASM heap.

```ts
Wallet.generateUnsafe(): Wallet
```
Fresh hex-backed keypair. SK in JS heap. ⚠ Encrypt + discard ASAP.

```ts
Wallet.fromKeys(publicKey: string, secretKey: string): Wallet
```
Restore from raw hex pub + sec. Hex-backed.

```ts
Wallet.fromEncrypted(keystore: Keystore, password: string): Promise<Wallet>
```
Decrypt a keystore object. The decrypted SK lives in JS heap until `destroy()`.

```ts
Wallet.fromKeystoreFile(path: string, password: string): Promise<Wallet>
```
Node-only file reader + decrypt.

## Provider binding

```ts
wallet.connect(provider: Provider): void
```
Bind a provider so `transfer` / `sendCall` / `getBalance` etc. can pull nonce + chain-id without a positional argument. Methods accept an optional `provider` override.

```ts
wallet.provider: Provider // throws if not connected
```

## Address + public key

```ts
wallet.address: string  // 0x-prefixed 64 hex (32 bytes, full Poseidon2)
wallet.publicKey: string // 897-byte FALCON-512 public key, hex
```

## Signing

```ts
wallet.signTransaction(tx: TxFields): string
```
Returns wire-encoded signed tx hex. Pass it to `provider.sendRawTransaction` (or use the higher-level `transfer` / `sendCall` instead).

```ts
wallet.sign(messageHex: string): string
```
Sign arbitrary message hex. Useful for off-chain auth challenges / EIP-191-style signatures.

```ts
wallet.hashTransaction(tx: TxFields): string
```
Canonical Poseidon2 tx hash (Chapter 11) — the same value the chain re-derives at verification time. Useful for offline checking before submission.

All signing methods throw `WalletDestroyedError` once `destroy()` has been called.

## Lifecycle

```ts
wallet.destroy(): void
```
Idempotent.
- Handle-backed: calls `crypto.dropKeypair(handle)` to wipe the WASM-side bytes.
- Hex-backed: drops the SK reference. V8 strings are immutable; the bytes themselves are not actively zeroized. Consider running sensitive code in a worker/iframe if JS-heap isolation matters.

Every subsequent signing method throws `WalletDestroyedError` with a clear message.

## Keystore export

```ts
wallet.toKeystore(password: string, params?: Partial<KdfParams>): Promise<Keystore>
```

| KDF param | Default | Notes |
|---|---|---|
| Argon2id `memory` | 64 MiB | Tunable down to ~16 MiB for low-end devices |
| Argon2id `iterations` | 3 | |
| Argon2id `parallelism` | 4 | |
| AEAD | ChaCha20-Poly1305 | |

The defaults take ~250 ms on a 2024 laptop and match `pyde keys generate` (Chapter 17).

```ts
wallet.saveKeystoreFile(path: string, password: string, params?): Promise<void>
```
Node-only: `mkdir -p`, write JSON, `chmod 0600`. Throws on handle-backed wallets.

## One-time on-chain registration

```ts
wallet.registerPubkey(provider?: Provider): Promise<Receipt>
```
First-time setup. Submits a `RegisterPubkey` tx so future signed txs from this address can be verified against the on-chain pubkey. **Required once** before any other write. Sender's address must already hold balance (no chicken-and-egg fix in v1).

## High-level write paths

All return `Receipt`. All accept either a bound provider or an explicit `opts.provider` override.

### `transfer(to, amount, optsOrProvider?)`

```ts
wallet.transfer(
  to: string,
  amount: bigint | number,
  optsOrProvider?: Provider | { provider?, gasLimit?, gasMultiplier? },
): Promise<Receipt>
```
Native PYDE transfer. Backward-compat: callers may pass a `Provider` positionally as the third arg.

### `sendCall(to, data, opts?)`

```ts
wallet.sendCall(
  to: string,
  data: string, // borsh-encoded CallPayload — usually built via Contract.encodeCall
  opts?: {
    gasLimit?: number;
    gasMultiplier?: number;
    value?: bigint | number | string;
    provider?: Provider;
  },
): Promise<Receipt>
```
Send a calldata-bearing tx. Most callers go through `Contract.write` instead — see [Chapter 04](./04-contract.md).

### `deploy(bundle, opts?)`

```ts
wallet.deploy(...): Promise<Receipt>
```
Submits a `Deploy` tx with a borsh-encoded `DeployData` (see `DeployData.fromArtifact`). Most authors use the `otigen deploy` CLI — see [Quickstart §3](./01-quickstart.md#3-deploy--call-a-contract).

### `sendEncrypted(...)` — MEV-protected

```ts
wallet.sendEncrypted(
  to: string,
  calldata: string,
  opts?: { provider?, gasLimit?, value?, deadline?, estimateAccess? },
): Promise<Receipt>
```
Threshold-encrypts `(to, value, calldata)` against the committee public key. The mempool sees ciphertext only; decryption happens at the wave-commit boundary. See [Chapter 09](./09-encrypted-mempool.md).

Hex-backed wallets only (until `pyde-crypto-wasm` ships `buildRawEncryptedTxWithHandle`).

### `transferEncrypted(to, amount, opts?)`

Same shape as `transfer`, but encrypted. Hides the recipient + amount until commit.

### Staking helpers

```ts
wallet.stakeDeposit(amount, opts?): Promise<Receipt>
wallet.stakeWithdraw(opts?): Promise<Receipt>
wallet.claimReward(opts?): Promise<Receipt>
```
Validator-side flows; most app developers don't need them.

## Gas auto-estimate

`transfer` and `sendCall` call `provider.estimateGas` internally:

```ts
gasLimit = ceil(provider.estimateGas(...) * gasMultiplier);
```

`gasMultiplier` defaults to `1.2` — a 20 % safety margin to absorb chain-state drift between the estimate and the commit. Override on the call:

```ts
await wallet.transfer(to, amount, { gasMultiplier: 1.5 });
await wallet.sendCall(to, data, { gasLimit: 5_000_000 }); // pin explicitly
```

**Fallback when the engine has no `pyde_estimateGas`:** 100k for value-only txs, 5M for calldata-bearing txs. Pinning `gasLimit` skips both the RPC call and the fallback.

## Read-side conveniences

```ts
wallet.getBalance(provider?: Provider): Promise<bigint>
wallet.getNonce(provider?: Provider): Promise<bigint>
```

## Errors

| Class | When |
|---|---|
| `WalletDestroyedError` | Any signing method after `destroy()`. |
| `SigningError` | `toKeystore` on a handle wallet · invalid arg shape · WASM signer failure. |
| `RpcError` | `provider.sendRawTransaction` returned a chain-side error. |
| `CallExceptionError` | `sendAndWait` saw a revert. |

See [Chapter 10 — Errors](./10-errors.md).

## Gotchas

- **`registerPubkey` once, ever.** Subsequent calls revert.
- **Generate a fresh wallet per session.** FALCON-512 isn't deterministic-from-seed in v1 (`pyde-crypto-wasm` doesn't expose `keypairFromSeed` yet).
- **Hex-backed wallets in long-lived processes are a footgun.** The SK string lives in V8 heap until GC. Use handle-backed wallets where possible; if you must use hex, scope the wallet tightly and `destroy()` early.
- **Nonces are bigint.** `Wallet.getNonce` returns `bigint` — don't `Number()` it.
- **`Provider` argument is optional after `connect()`.** Bind once, use everywhere.
