# 03 — Wallet

FALCON-512 signing + keystore I/O + high-level transfer / sendCall / deploy / encrypted-send.

[← TOC](./README.md)

---

## Table of contents

- [Two key shapes — handle vs hex](#two-key-shapes--handle-vs-hex)
- Constructors
  - [`Wallet.generate()`](#walletgenerate)
  - [`Wallet.generateUnsafe()`](#walletgenerateunsafe)
  - [`Wallet.fromKeys(publicKey, secretKey)`](#walletfromkeyspublickey-secretkey)
  - [`Wallet.fromEncrypted(keystore, password)`](#walletfromencryptedkeystore-password)
  - [`Wallet.fromKeystoreFile(path, password)`](#walletfromkeystorefilepath-password)
- Provider binding
  - [`wallet.connect(provider)`](#walletconnectprovider)
  - [`wallet.provider`](#walletprovider)
- Identity
  - [`wallet.address`](#walletaddress)
  - [`wallet.publicKey`](#walletpublickey)
- Signing primitives
  - [`wallet.signTransaction(tx)`](#walletsigntransactiontx)
  - [`wallet.sign(messageHex)`](#walletsignmessagehex)
  - [`wallet.hashTransaction(tx)`](#wallethashtransactiontx)
- Lifecycle
  - [`wallet.destroy()`](#walletdestroy)
- Keystore export
  - [`wallet.toKeystore(password, params?)`](#wallettokeystorepassword-params)
  - [`wallet.saveKeystoreFile(path, password, params?)`](#walletsavekeystorefilepath-password-params)
- One-time on-chain registration
  - [`wallet.registerPubkey(provider?)`](#walletregisterpubkeyprovider)
- High-level write paths
  - [`wallet.transfer(to, amount, optsOrProvider?)`](#wallettransferto-amount-optsorprovider)
  - [`wallet.sendCall(to, data, opts?)`](#walletsendcallto-data-opts)
  - [`wallet.deploy(...)`](#walletdeploy)
  - [`wallet.sendEncrypted(to, calldata, opts?)`](#walletsendencryptedto-calldata-opts)
  - [`wallet.transferEncrypted(to, amount, opts?)`](#wallettransferencryptedto-amount-opts)
- Staking helpers
  - [`wallet.stakeDeposit(amount, opts?)`](#walletstakedepositamount-opts)
  - [`wallet.stakeWithdraw(opts?)`](#walletstakewithdrawopts)
  - [`wallet.claimReward(opts?)`](#walletclaimrewardopts)
- Read-side conveniences
  - [`wallet.getBalance(provider?)`](#walletgetbalanceprovider)
  - [`wallet.getNonce(provider?)`](#walletgetnonceprovider)
- [Gas auto-estimate](#gas-auto-estimate)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## Two key shapes — handle vs hex

The same `Wallet` class wraps two different secret-key holdings:

|                            | Handle-backed (default)                            | Hex-backed                                                                                      |
| -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Constructor                | `Wallet.generate()`                                | `Wallet.generateUnsafe()`, `Wallet.fromKeys`, `Wallet.fromEncrypted`, `Wallet.fromKeystoreFile` |
| Where the SK lives         | WASM linear memory                                 | JS heap (as a hex string)                                                                       |
| Survives a JS heap dump?   | ✅ yes                                             | ❌ no — visible as a string                                                                     |
| Can `toKeystore` export?   | ❌ no (no hex to encrypt)                          | ✅ yes                                                                                          |
| Encrypted `sendEncrypted`? | ❌ not yet (needs `buildRawEncryptedTxWithHandle`) | ✅ yes                                                                                          |

**Recommendation:** use `generate()` and `fromEncrypted()` for everything except keystore export. When you need to export, use `generateUnsafe()`, immediately `toKeystore` + write, and `destroy()` the wallet.

---

## `Wallet.generate()`

Generate a fresh handle-backed keypair. SK stays in the WASM heap.

**Signature:**

```ts
Wallet.generate(): Wallet
```

**Returns:** `Wallet` — a fresh keypair. Address is `Poseidon2(falcon_public_key)`.

**Example:**

```ts
import { Wallet } from "pyde-ts-sdk";

const wallet = Wallet.generate();
console.log("address:", wallet.address);
console.log("publicKey (897 bytes):", wallet.publicKey.length, "hex chars");
```

**Expected output:**

```
address: 0x0cf4448bb99519a4aa04c7a5ee740483434f1b4bd234dc50e5032af30815e250
publicKey (897 bytes): 1796 hex chars
```

**Notes:**

- Uses OS entropy via `crypto.getRandomValues`.
- SK lives in `pyde-crypto-wasm` linear memory. Even a JS heap dump can't recover it.
- Use `destroy()` to wipe the SK when done.

---

## `Wallet.generateUnsafe()`

Generate a fresh hex-backed keypair. ⚠ SK enters the JS heap as a hex string.

**Signature:**

```ts
Wallet.generateUnsafe(): Wallet
```

**Returns:** `Wallet` — hex SK held in JS.

**Example:**

```ts
const wallet = Wallet.generateUnsafe();
// Immediately encrypt + discard:
await wallet.saveKeystoreFile("/keys/alice.json", "strong-passphrase");
wallet.destroy();
```

**When to use:**

- You need `toKeystore` / `saveKeystoreFile` to persist the wallet.
- You're integrating with code that requires the hex SK.
- You're using `sendEncrypted` (handle-backed not yet supported).

**Otherwise:** prefer `Wallet.generate()`.

---

## `Wallet.fromKeys(publicKey, secretKey)`

Restore a hex-backed wallet from raw hex pub + sec.

**Signature:**

```ts
Wallet.fromKeys(publicKey: string, secretKey: string): Wallet
```

**Args:**

| Name        | Type     | Description                                                               |
| ----------- | -------- | ------------------------------------------------------------------------- |
| `publicKey` | `string` | `0x`-prefixed 897-byte FALCON-512 pubkey hex (1794 hex chars after `0x`). |
| `secretKey` | `string` | `0x`-prefixed 1281-byte FALCON-512 secret hex.                            |

**Returns:** `Wallet` — hex-backed, address derived from `publicKey`.

**Example:**

```ts
const wallet = Wallet.fromKeys(savedPk, savedSk);
console.log("address:", wallet.address);
```

**Throws:** `SigningError` on malformed inputs (`Address` derivation fails or hex lengths mismatch).

---

## `Wallet.fromEncrypted(keystore, password)`

Decrypt a `Keystore` object into a hex-backed wallet.

**Signature:**

```ts
Wallet.fromEncrypted(keystore: Keystore, password: string): Promise<Wallet>
```

**Args:**

| Name       | Type       | Description                            |
| ---------- | ---------- | -------------------------------------- |
| `keystore` | `Keystore` | Argon2id + ChaCha20-Poly1305 envelope. |
| `password` | `string`   | Decryption passphrase.                 |

**Returns:** `Promise<Wallet>` — hex-backed wallet with SK in JS heap.

**`Keystore` shape:**

```ts
interface Keystore {
  address: string;       // 32-byte address hex
  publicKey: string;     // FALCON-512 pubkey hex (897 bytes)
  kdf: "argon2id";
  kdfParams: {
    m: number;           // memory cost in KiB (default 65,536 = 64 MiB)
    t: number;           // iterations (default 3)
    p: number;           // parallelism (default 4)
    salt: string;        // 16-byte salt hex
  };
  cipher: "chacha20-poly1305";
  nonce: string;         // 12-byte AEAD nonce hex
  ciphertext: string;    // encrypted SK + AEAD tag, hex
  version: 1;
}
```

**Example:**

```ts
import { readFileSync } from "node:fs";

const json = readFileSync("/keys/alice.json", "utf-8");
const keystore = JSON.parse(json);
const wallet = await Wallet.fromEncrypted(keystore, "strong-passphrase");
console.log("loaded:", wallet.address);
```

**Throws:** `SigningError` on wrong password or tampered ciphertext.

---

## `Wallet.fromKeystoreFile(path, password)`

Node-only convenience: read a keystore JSON file + decrypt.

**Signature:**

```ts
Wallet.fromKeystoreFile(path: string, password: string): Promise<Wallet>
```

**Returns:** `Promise<Wallet>`.

**Example:**

```ts
const wallet = await Wallet.fromKeystoreFile("/keys/alice.json", process.env.WALLET_PASSPHRASE!);
```

**Throws:**

- `Error` — file doesn't exist or can't be read.
- `SigningError` — decryption failed.

---

## `wallet.connect(provider)`

Bind a provider so subsequent methods can pull nonce / chain-id without a positional argument.

**Signature:**

```ts
wallet.connect(provider: Provider): void
```

**Example:**

```ts
const wallet = Wallet.generate();
wallet.connect(provider);

// Now `provider` is implicit:
await wallet.transfer(to, 1n);

// Or pass `opts.provider` to override:
await wallet.transfer(to, 1n, { provider: otherProvider });
```

---

## `wallet.provider`

The bound provider. Throws if not yet connected.

**Type:** `Provider` (getter).

**Throws:** `Error("No provider bound — call wallet.connect(provider)")`.

---

## `wallet.address`

The wallet's 32-byte address (hex).

**Type:** `string` — `0x` + 64 hex chars.

**Example:**

```ts
const wallet = Wallet.generate();
console.log(wallet.address);
```

**Expected output:**

```
0x0cf4448bb99519a4aa04c7a5ee740483434f1b4bd234dc50e5032af30815e250
```

---

## `wallet.publicKey`

The FALCON-512 public key.

**Type:** `string` — `0x` + 1794 hex chars (897 bytes).

**Example:**

```ts
console.log(wallet.publicKey.slice(0, 22) + "...");
```

**Expected output:**

```
0x0943494b728c5e8492...
```

---

## `wallet.signTransaction(tx)`

Sign a transaction. Returns wire-encoded signed tx hex ready for `provider.sendRawTransaction`.

**Signature:**

```ts
wallet.signTransaction(tx: TxFields): string
```

**Args:**

| Name | Type       | Description           |
| ---- | ---------- | --------------------- |
| `tx` | `TxFields` | Unsigned tx envelope. |

**`TxFields` shape:**

```ts
interface TxFields {
  from: string;
  to: string;
  value: bigint | number | string;
  data: string; // hex
  gasLimit: number;
  nonce: bigint;
  chainId: number;
  txType: TxType;
  accessList?: AccessEntry[];
  feePayer?: FeePayer;
  deadline?: bigint;
}
```

**Returns:** `string` — `0x`-prefixed hex of the borsh-encoded `pyde_engine_types::Tx`.

**Example:**

```ts
const tx = {
  from: wallet.address,
  to: "0xrecipient...",
  value: 1_000_000_000n,
  data: "0x",
  gasLimit: 100_000,
  nonce: 0n,
  chainId: 31337,
  txType: TxType.Standard,
};
const wire = wallet.signTransaction(tx);
const submitted = await provider.sendRawTransaction(wire);
console.log("submitted:", submitted.hash);
```

**Throws:**

- `WalletDestroyedError` — `destroy()` was called.
- `SigningError` — malformed `tx` or WASM signer error.

---

## `wallet.sign(messageHex)`

Sign an arbitrary message. For off-chain auth challenges / EIP-191-style signatures.

**Signature:**

```ts
wallet.sign(messageHex: string): string
```

**Args:**

| Name         | Type     | Description                             |
| ------------ | -------- | --------------------------------------- |
| `messageHex` | `string` | `0x`-prefixed hex of the message bytes. |

**Returns:** `string` — `0x`-prefixed hex of the FALCON-512 signature (~666 bytes typical).

**Example:**

```ts
const sig = wallet.sign("0xdeadbeef");
console.log("sig length:", (sig.length - 2) / 2, "bytes");
```

**Expected output:**

```
sig length: 666 bytes
```

---

## `wallet.hashTransaction(tx)`

Compute the canonical Poseidon2 tx hash. **Doesn't sign.** Useful for offline checking.

**Signature:**

```ts
wallet.hashTransaction(tx: TxFields): string
```

**Returns:** `string` — `0x` + 64 hex chars.

**Example:**

```ts
const hash = wallet.hashTransaction(tx);
console.log("expected tx hash:", hash);

// After submission, verify the chain-side hash matches:
const submitted = await provider.sendRawTransaction(wallet.signTransaction(tx));
console.log("chain reported:", submitted.hash);
console.log("match:", submitted.hash === hash);
```

**Expected output:**

```
expected tx hash: 0x3d352d22070ca9d42e6167c8f65a70923e0d105fa3e89b02b72f56f0db55fecb
chain reported:   0x3d352d22070ca9d42e6167c8f65a70923e0d105fa3e89b02b72f56f0db55fecb
match: true
```

---

## `wallet.destroy()`

Wipe the SK material. Idempotent.

**Signature:**

```ts
wallet.destroy(): void
```

**What it does:**

- Handle-backed: calls `crypto.dropKeypair(handle)` to wipe the WASM-side bytes.
- Hex-backed: drops the SK reference. V8 strings are immutable; the bytes themselves are not actively zeroized in the JS heap. Use a worker / iframe if JS-heap isolation matters.

After `destroy()`, **every** signing method throws `WalletDestroyedError`.

**Example:**

```ts
const wallet = Wallet.generate();
await wallet.transfer(to, 1n);

wallet.destroy();

await wallet.transfer(to, 1n);
// throws WalletDestroyedError
```

---

## `wallet.toKeystore(password, params?)`

Encrypt the wallet's SK with `password` and return the keystore object. **Hex-backed wallets only.**

**Signature:**

```ts
wallet.toKeystore(
  password: string,
  params?: Partial<KdfParams>,
): Promise<Keystore>
```

**`KdfParams` (defaults):**

| Param         | Default              | Notes                                                              |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| `memory`      | `64 * 1024` (64 MiB) | Argon2id memory cost. Tunable down to ~16 MiB for low-end devices. |
| `iterations`  | `3`                  | Argon2id iterations.                                               |
| `parallelism` | `4`                  | Argon2id parallelism.                                              |

**AEAD:** ChaCha20-Poly1305 (24-byte nonce).

**Defaults take ~250 ms on a 2024 laptop** — matches `pyde keys generate` (Chapter 17).

**Returns:** `Promise<Keystore>`.

**Throws:**

- `WalletDestroyedError` — `destroy()` called.
- `SigningError` — handle-backed wallet (no hex to export).

**Example:**

```ts
const wallet = Wallet.generateUnsafe();
const keystore = await wallet.toKeystore("strong-passphrase");
console.log("ciphertext size:", (keystore.ciphertext.length - 2) / 2, "bytes");
```

**Expected output:**

```
ciphertext size: 1281 bytes
```

---

## `wallet.saveKeystoreFile(path, password, params?)`

Node-only: encrypt + write to disk with mode `0600`.

**Signature:**

```ts
wallet.saveKeystoreFile(
  path: string,
  password: string,
  params?: Partial<KdfParams>,
): Promise<void>
```

**Example:**

```ts
const wallet = Wallet.generateUnsafe();
await wallet.saveKeystoreFile("/keys/alice.json", "strong-passphrase");
wallet.destroy();
```

**On POSIX:** the file is `chmod 0600` after write.
**On Windows / network FS:** `chmod` fails silently — file mode unchanged.

---

## `wallet.registerPubkey(provider?)`

Register the FALCON pubkey on chain. **Required once per address** before any signed Standard tx is accepted.

**Spec:** Chapter 11 §11.8 `RegisterPubkey`.

**Signature:**

```ts
wallet.registerPubkey(provider?: Provider): Promise<Receipt>
```

**What it sends:**

- `txType: RegisterPubkey`
- `to: ZERO_ADDRESS`
- `data: this.publicKey` (897 bytes)
- `value: 0`
- `gasLimit: 200_000`
- **No signature** — RegisterPubkey txs are unsigned; the chain checks `from == Poseidon2(data)`.

**Sender must already hold balance** (no chicken-and-egg fix in v1).

**Example:**

```ts
const wallet = Wallet.generate();
wallet.connect(provider);

const receipt = await wallet.registerPubkey();
console.log("registered:", receipt.success);
```

**Expected output:**

```
registered: true
```

**Notes:**

- Subsequent calls revert (`AuthKeys::Single(...)` already set).
- **Engine-side gap:** the `otigen devnet` orchestrator's wave-application dispatcher doesn't include `RegisterPubkey` — see [README → Status](./README.md#status).

---

## `wallet.transfer(to, amount, optsOrProvider?)`

Build, sign, send a native PYDE transfer.

**Signature:**

```ts
wallet.transfer(
  to: string,
  amount: bigint | number,
  optsOrProvider?: Provider | {
    provider?: Provider;
    gasLimit?: number;
    gasMultiplier?: number;
  },
): Promise<Receipt>
```

**Args:**

| Name             | Type               | Description                                                             |
| ---------------- | ------------------ | ----------------------------------------------------------------------- |
| `to`             | `string`           | Recipient address.                                                      |
| `amount`         | `bigint \| number` | Quanta (use `parseQuanta("1.5")` to convert from PYDE).                 |
| `optsOrProvider` | see signature      | Backward-compat: pass `Provider` positionally **or** an options object. |

**Returns:** `Promise<Receipt>` — receipt after inclusion.

**Example — bound provider, auto-estimate gas:**

```ts
wallet.connect(provider);
const receipt = await wallet.transfer("0xrecipient...", parseQuanta("1.5"));
console.log("tx:", receipt.txHash, "ok:", receipt.success);
```

**Expected output:**

```
tx: 0x3d352d22... ok: true
```

**Example — pin gas limit:**

```ts
await wallet.transfer(to, parseQuanta("1"), { gasLimit: 50_000 });
```

**Example — tune the auto-estimate safety multiplier:**

```ts
await wallet.transfer(to, parseQuanta("1"), { gasMultiplier: 1.5 });
```

See [Gas auto-estimate](#gas-auto-estimate) for details.

---

## `wallet.sendCall(to, data, opts?)`

Send a calldata-bearing tx (state-changing contract call). Most callers use `Contract.write` instead.

**Signature:**

```ts
wallet.sendCall(
  to: string,
  data: string,
  opts?: {
    gasLimit?: number;
    gasMultiplier?: number;
    value?: bigint | number | string;
    provider?: Provider;
  },
): Promise<Receipt>
```

**Args:**

| Name                 | Type                     | Description                                                           |
| -------------------- | ------------------------ | --------------------------------------------------------------------- |
| `to`                 | `string`                 | Contract address.                                                     |
| `data`               | `string`                 | Borsh-encoded `CallPayload`, usually built via `Contract.encodeCall`. |
| `opts.gasLimit`      | `number`                 | Pin gas (skip auto-estimate).                                         |
| `opts.gasMultiplier` | `number`                 | Safety multiplier applied to the simulate-reported `gas_used`. Default `1.2`. |
| `opts.value`         | bigint / number / string | PYDE quanta attached to the call.                                     |
| `opts.provider`      | `Provider`               | Override the bound provider.                                          |

**Returns:** `Promise<Receipt>`.

**Example:**

```ts
const counter = await Contract.fromArtifact(abi, addr, provider);
const data = counter.encodeCall("increment");
const receipt = await wallet.sendCall(addr, data);
```

---

## `wallet.deploy(...)`

Submits a `Deploy` tx carrying a borsh-encoded `DeployData`.

**Signature:**

```ts
wallet.deploy(
  bundle: DeployData,
  opts?: { gasLimit?: number; value?: bigint | number | string; provider?: Provider },
): Promise<Receipt>
```

Most authors use the `otigen deploy` CLI; this is the in-process equivalent. See [Chapter 04 — Contract → `DeployData`](./04-contract.md#deploydata--deploy-tx-payload) for the bundle.

---

## `wallet.sendEncrypted(to, calldata, opts?)`

Threshold-encrypts `(to, value, calldata)` against the committee pubkey before submission. **MEV-protected.**

**Signature:**

```ts
wallet.sendEncrypted(
  to: string,
  calldata: string,
  opts?: {
    gasLimit?: number;
    value?: bigint | number | string;
    deadline?: bigint;
    accessList?: AccessEntry[];
    provider?: Provider;
  },
): Promise<{ envelopeHash: string }>
```

**Hex-backed wallets only** (until `pyde-crypto-wasm` ships `buildRawEncryptedTxWithHandle`).

Returns `{ envelopeHash }` — receipts key on the inner plaintext tx hash post-decryption; that hash isn't exposed by `buildRawEncryptedTx` yet, so the SDK doesn't poll. Treat a successful return as "admitted to encrypted mempool".

See [Chapter 09 — encrypted mempool](./09-encrypted-mempool.md) for the full flow, when to use it, and the `accessList` privacy considerations.

---

## `wallet.transferEncrypted(to, amount, opts?)`

Encrypted variant of `transfer`. Value-only send through the MEV-protected mempool. Same hex-SK constraint.

**Signature:**

```ts
wallet.transferEncrypted(
  to: string,
  amount: bigint | number,
  opts?: { deadline?: bigint; provider?: Provider },
): Promise<{ envelopeHash: string }>
```

---

## `wallet.stakeDeposit(amount, opts?)`

Validator-side flow. Lock ≥ `MIN_VALIDATOR_STAKE` (10,000 PYDE) and register as a validator.

**Signature:**

```ts
wallet.stakeDeposit(
  amount: bigint,
  opts?: { provider?: Provider },
): Promise<Receipt>
```

---

## `wallet.stakeWithdraw(opts?)`

Begin the 30-day unbonding period.

**Signature:**

```ts
wallet.stakeWithdraw(opts?: { provider?: Provider }): Promise<Receipt>
```

---

## `wallet.claimReward(opts?)`

Claim accrued staking yield from the pool.

**Signature:**

```ts
wallet.claimReward(opts?: { provider?: Provider }): Promise<Receipt>
```

---

## `wallet.getBalance(provider?)`

Convenience wrapper around `provider.getBalance(wallet.address)`.

**Signature:**

```ts
wallet.getBalance(provider?: Provider): Promise<bigint>
```

**Example:**

```ts
const balance = await wallet.getBalance();
console.log(formatQuanta(balance), "PYDE");
```

---

## `wallet.getNonce(provider?)`

Convenience wrapper around `provider.getNonce(wallet.address)`.

**Signature:**

```ts
wallet.getNonce(provider?: Provider): Promise<bigint>
```

---

## Gas auto-estimate

`transfer` and `sendCall` use the SDK's built-in conservative defaults (see [Provider → Gas estimation status](./02-provider.md#gas-estimation-status)):

```ts
gasLimit = data === "0x" ? 100_000 : 5_000_000;
```

When Tier-2 wires `pyde_simulateTransaction`, the same path will pick up real chain estimates with a `1.2×` safety multiplier — no caller-side change required.

`gasMultiplier` defaults to `1.2` — a 20 % safety margin to absorb chain-state drift between the estimate and the commit.

**Override on the call:**

```ts
await wallet.transfer(to, amount, { gasMultiplier: 1.5 }); // tune
await wallet.sendCall(to, data, { gasLimit: 5_000_000 }); // pin
```

**Defaults today:**

- `Wallet.transfer`: fixed 100k gas (plain transfers don't execute code; the chain's `pyde_simulateTransaction` returns `receipt: null` for them).
- `Wallet.sendCall`: signs a probe tx, calls `provider.simulateTransaction`, applies `gasUsed × gasMultiplier` (default `1.2`), and inherits the inferred access list on the real submit. Falls back to a fixed 5M default + no access list if simulate fails.

Pinning `gasLimit` skips the simulate round-trip entirely.

---

## Errors

| Class                  | When                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `WalletDestroyedError` | Any signing method after `destroy()`.                                      |
| `SigningError`         | `toKeystore` on a handle wallet · invalid arg shape · WASM signer failure. |
| `RpcError`             | `provider.sendRawTransaction` returned a chain-side error.                 |
| `CallExceptionError`   | `sendAndWait` saw a revert.                                                |

See [Chapter 10 — Errors](./10-errors.md).

---

## Gotchas

- **`registerPubkey` once, ever.** Subsequent calls revert.
- **Generate a fresh wallet per session.** Until `pyde-crypto-wasm.keypairFromSeed` covers all generation paths, `Wallet.generate()` uses fresh OS entropy each time.
- **Hex-backed wallets in long-lived processes are a footgun.** The SK string lives in V8 heap until GC. Use handle-backed wallets where possible; if you must use hex, scope the wallet tightly and `destroy()` early.
- **Nonces are bigint.** `wallet.getNonce()` returns `bigint` — don't `Number()` it.
- **`provider` argument is optional after `connect()`.** Bind once, use everywhere.
- **`saveKeystoreFile` is Node-only.** Browsers can use `toKeystore` + `localStorage` / `IndexedDB`.
- **`transferEncrypted` / `sendEncrypted` require a hex-backed wallet.** Plain `Wallet.generate()` won't work for encrypted send today.
- **`Wallet.sendCall` round-trips to the chain for gas + access list.** Each invocation does a probe-sign + `simulateTransaction` before the real submit. Pin `opts.gasLimit` when you've already got a bound and want to skip the extra RPC. `Wallet.transfer` stays cheap (fixed 100k, no simulate).
