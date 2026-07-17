# 03 — Wallet

FALCON-512 signing + keystore I/O + high-level transfer / sendCall / deploy / private (commit-reveal) send.

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
- Private (commit-reveal) write paths
  - [`wallet.sendPrivate(inner)`](#walletsendprivateinner)
  - [`wallet.transferPrivate(to, amount, opts?)`](#wallettransferprivateto-amount-opts)
  - [`wallet.buildCommit(args, opts?)`](#walletbuildcommitargs-opts)
  - [`wallet.buildReveal(args, opts?)`](#walletbuildrevealargs-opts)
  - [`PrivateSendHandle`](#privatesendhandle)
- Staking helpers
  - [`wallet.stakeDeposit(falconPubkey, amount, opts?)`](#walletstakedepositfalconpubkey-amount-opts)
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

|                          | Handle-backed (default)   | Hex-backed                                                                                      |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------- |
| Constructor              | `Wallet.generate()`       | `Wallet.generateUnsafe()`, `Wallet.fromKeys`, `Wallet.fromEncrypted`, `Wallet.fromKeystoreFile` |
| Where the SK lives       | WASM linear memory        | JS heap (as a hex string)                                                                       |
| Survives a JS heap dump? | ✅ yes                    | ❌ no — visible as a string                                                                     |
| Can `toKeystore` export? | ❌ no (no hex to encrypt) | ✅ yes                                                                                          |
| Private `sendPrivate`?   | ✅ yes                    | ✅ yes                                                                                          |

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
Wallet.fromEncrypted(
  keystore: Keystore | LegacyFlatKeystore,
  password: string,
  opts?: { name?: string },   // pick an account from a multi-account envelope
): Promise<Wallet>
```

**Args:**

| Name        | Type                             | Description                                                |
| ----------- | -------------------------------- | ---------------------------------------------------------- |
| `keystore`  | `Keystore \| LegacyFlatKeystore` | Canonical envelope, or a legacy flat keystore (read-only). |
| `password`  | `string`                         | Decryption passphrase.                                     |
| `opts.name` | `string?`                        | Account to open; optional for a single-entry file.         |

**Returns:** `Promise<Wallet>` — hex-backed wallet with SK in JS heap.

**`Keystore` shape:**

```ts
// Canonical multi-account envelope — byte-identical to `otigen wallet`, the
// playground, and pyde-book §8.7. One file opens everywhere.
interface Keystore {
  version: 1;
  accounts: Record<string, KeystoreEntry>;
}

interface KeystoreEntry {
  address: string; // 0x + 64 hex (32-byte address)
  pubkey: string; // 0x + hex (897-byte FALCON-512 pubkey) — field is `pubkey`
  ciphertext: string; // 0x + hex of AES-256-GCM(sk) with the 16-byte tag appended
  salt: string; // 0x + hex, 16 bytes
  nonce: string; // 0x + hex, 12 bytes
  cipher?: "aes-256-gcm" | "chacha20-poly1305"; // absent ⇒ aes-256-gcm; chacha never written
  kdf: { name: "argon2id"; memory_kb: number; iterations: number; parallelism: number };
}
```

`fromEncrypted` also accepts a **`LegacyFlatKeystore`** on read — the flat,
single-account shape (`publicKey`, bare hex, nested `kdfParams`) written by
pyde-ts-sdk ≤ 0.2.x. It is never written; new keystores always use the envelope.

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
  opts?: { name?: string; m?: number; t?: number; p?: number },
): Promise<Keystore>   // canonical envelope with one entry keyed by `name`
```

**`opts` (all optional):**

| Field  | Default       | Notes                                                                     |
| ------ | ------------- | ------------------------------------------------------------------------- |
| `name` | `"default"`   | The account key for the single entry in the envelope.                     |
| `m`    | `65536` (KiB) | Argon2id memory cost (64 MiB). The written floor; readers tolerate lower. |
| `t`    | `3`           | Argon2id iterations.                                                      |
| `p`    | `4`           | Argon2id parallelism.                                                     |

**AEAD:** AES-256-GCM (12-byte nonce). ChaCha20-Poly1305 keystores written by older SDK versions are still accepted on read.

**Defaults take ~250 ms on a 2024 laptop** — matches `pyde keys generate` (Chapter 17).

**Returns:** `Promise<Keystore>`.

**Throws:**

- `WalletDestroyedError` — `destroy()` called.
- `SigningError` — handle-backed wallet (no hex to export).

**Example:**

```ts
const wallet = Wallet.generateUnsafe();
const keystore = await wallet.toKeystore("strong-passphrase", { name: "alice" });
console.log("account:", Object.keys(keystore.accounts)[0]); // "alice"
```

**Expected output:**

```
account: alice
```

---

## `wallet.saveKeystoreFile(path, password, params?)`

Node-only: encrypt + write to disk with mode `0600`.

**Signature:**

```ts
wallet.saveKeystoreFile(
  path: string,
  password: string,
  opts?: { name?: string; m?: number; t?: number; p?: number },
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

| Name                 | Type                     | Description                                                                   |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `to`                 | `string`                 | Contract address.                                                             |
| `data`               | `string`                 | Borsh-encoded `CallPayload`, usually built via `Contract.encodeCall`.         |
| `opts.gasLimit`      | `number`                 | Pin gas (skip auto-estimate).                                                 |
| `opts.gasMultiplier` | `number`                 | Safety multiplier applied to the simulate-reported `gas_used`. Default `1.2`. |
| `opts.value`         | bigint / number / string | PYDE quanta attached to the call.                                             |
| `opts.provider`      | `Provider`               | Override the bound provider.                                                  |

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
  deployData: string,
  opts?: { gasLimit?: number; value?: bigint | number | string; provider?: Provider },
): Promise<Receipt>
```

`deployData` is the `0x`-prefixed hex of the borsh-encoded `pyde_engine_types::DeployData` envelope. Build it from a [`DeployData`](./04-contract.md#deploydata--deploy-tx-payload) instance via `data.build()`. Most authors use the `otigen deploy` CLI; this is the in-process equivalent.

---

## `wallet.sendPrivate(inner)`

One-call private send through **commit-reveal** — Pyde's front-running protection. The wallet publishes a salted Blake3 commitment (a `Commit`, which reserves the ordering slot and posts a refundable bond), waits for it to be included, then opens it with a `Reveal` that discloses the hidden inner tx. There is **no committee, no shared secret, nothing to decrypt** — the commitment alone fixes the ordering position before the contents are visible. This one call runs the whole dance and auto-reveals the moment the commit is included (~1-2 s), so it feels like a single send.

**Guarantee (be honest about scope):** content-targeted front-running is prevented; this is **NOT** a total ordering lock against unrelated txs arriving in the reveal→execute window.

**Signature:**

```ts
wallet.sendPrivate(inner: {
  to: string;
  data?: string;                          // "0x" for a value-only send
  value?: bigint | number | string;       // quanta
  gasLimit?: number;
  valueCeiling?: bigint | number | string; // must be >= value; drives the bond
  accessList?: AccessEntry[];
  provider?: Provider;
  timeoutMs?: number;
}): Promise<PrivateSendHandle>
```

**Args:**

| Name           | Type                     | Description                                                                                                                               |
| -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `to`           | `string`                 | Recipient / contract address of the hidden inner tx.                                                                                      |
| `data`         | `string`                 | Calldata hex. `"0x"` for a value-only transfer. Default `"0x"`.                                                                           |
| `value`        | bigint / number / string | Quanta attached to the inner tx. Default `0`.                                                                                             |
| `gasLimit`     | `number`                 | Inner-tx gas. Defaults to `100_000` for a value-only send, `5_000_000` for a call.                                                        |
| `valueCeiling` | bigint / number / string | Declared upper bound on the hidden value. Must be `>= value`. Drives the bond; over-declare to hide the true amount. Defaults to `value`. |
| `accessList`   | `AccessEntry[]`          | Optional prefetch hints for the inner tx.                                                                                                 |
| `provider`     | `Provider`               | Override the bound provider.                                                                                                              |
| `timeoutMs`    | `number`                 | Applied to both the commit-inclusion wait and the inner-tx receipt wait.                                                                  |

**The bond:** `requiredBond(valueCeiling) = max(MIN_COMMIT_BOND, valueCeiling × COMMIT_BOND_BPS / 10_000)` — a `1` PYDE (`MIN_COMMIT_BOND`) flat floor or `1 %` (`COMMIT_BOND_BPS`) of the ceiling, whichever is larger. It is debited at commit, refunded when the reveal is accepted, and **burned** if the commitment is never revealed within `COMMIT_REVEAL_WINDOW_WAVES` (`120n` waves, ~60 s — a censorship cushion, not the expected latency).

**Returns:** `Promise<PrivateSendHandle>` — see [`PrivateSendHandle`](#privatesendhandle). Its `waitForReceipt()` resolves on the **inner** tx's receipt, which executes in the reveal wave's resolution pass, in commit order.

**Example:**

```ts
import { Wallet, parseQuanta } from "pyde-ts-sdk";

const wallet = Wallet.generate();
wallet.connect(provider);

// Private contract call; over-declare the ceiling to hide the true amount.
const handle = await wallet.sendPrivate({
  to: contractAddr,
  data: counter.encodeCall("deposit"),
  value: parseQuanta("2"),
  valueCeiling: parseQuanta("10"),
});

console.log("commit:", handle.commitHash);
console.log("reveal:", handle.revealHash);

// waitForReceipt resolves on the INNER tx — the real outcome.
const receipt = await handle.waitForReceipt();
console.log("inner tx:", receipt.txHash, "ok:", receipt.success);
```

**Notes:**

- Works with **any** wallet — handle-backed (`generate()`) or hex-backed. No hex-SK constraint.
- The inner tx is signed **once** and those exact bytes are reused for both the commitment and the reveal (FALCON-512 is non-deterministic — re-signing would break the commitment match).
- The commit, reveal, and inner tx consume three consecutive nonces from the sender's account.

See [Chapter 09 — Private transactions (commit-reveal)](./09-private-transactions.md) for the full protocol, the reveal-window semantics, and `accessList` privacy considerations.

---

## `wallet.transferPrivate(to, amount, opts?)`

Value-only convenience over [`sendPrivate`](#walletsendprivateinner) (`data = "0x"`). Same commit-reveal flow and guarantee.

**Signature:**

```ts
wallet.transferPrivate(
  to: string,
  amount: bigint | number,
  opts?: { valueCeiling?: bigint; provider?: Provider; timeoutMs?: number },
): Promise<PrivateSendHandle>
```

**Example:**

```ts
import { Wallet, parseQuanta } from "pyde-ts-sdk";

const wallet = Wallet.generate();
wallet.connect(provider);

const handle = await wallet.transferPrivate("0xrecipient...", parseQuanta("5"));
const receipt = await handle.waitForReceipt();
console.log("private transfer ok:", receipt.success);
```

---

## `wallet.buildCommit(args, opts?)`

Low-level: build + sign a `Commit` tx. Returns the signed wire, its tx hash, and the bond posted. Most callers want [`sendPrivate`](#walletsendprivateinner) — this exists for relays / advanced flows that manage the commit and reveal separately.

**Signature:**

```ts
wallet.buildCommit(
  args: { commitment: Uint8Array; valueCeiling: bigint },
  opts?: { gasLimit?: number; provider?: Provider },
): Promise<{ wire: string; hash: string; bond: bigint }>
```

**Args:**

| Name                | Type         | Description                                                                           |
| ------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `args.commitment`   | `Uint8Array` | 32-byte `commitmentHash(innerTxBytes, nonce)`.                                        |
| `args.valueCeiling` | `bigint`     | Declared upper bound on the hidden value; drives `bond = requiredBond(valueCeiling)`. |
| `opts.gasLimit`     | `number`     | Commit-tx gas. Default `200_000`.                                                     |
| `opts.provider`     | `Provider`   | Override the bound provider (needed for the nonce + chain-id lookup).                 |

**Returns:** `{ wire, hash, bond }` — submit `wire` via `provider.sendRawTransaction` (the Commit's `to` is the zero address and its `value` is `bond`).

---

## `wallet.buildReveal(args, opts?)`

Low-level: build + sign a `Reveal` tx that opens an already-published commitment. **Any** wallet may reveal on behalf of the committer — the disclosed preimage is the authorization.

**Signature:**

```ts
wallet.buildReveal(
  args: { commitment: Uint8Array; nonce: Uint8Array; innerTx: Uint8Array | string },
  opts?: { gasLimit?: number; provider?: Provider },
): Promise<{ wire: string; hash: string }>
```

**Args:**

| Name              | Type                   | Description                                                                                   |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `args.commitment` | `Uint8Array`           | The 32-byte commitment being opened (must equal the committed hash).                          |
| `args.nonce`      | `Uint8Array`           | The 32-byte salt drawn at commit time.                                                        |
| `args.innerTx`    | `Uint8Array \| string` | The signed inner-tx wire (hex or bytes) that was hashed into the commitment — reuse verbatim. |
| `opts.gasLimit`   | `number`               | Reveal-tx gas. Default `5_000_000`.                                                           |
| `opts.provider`   | `Provider`             | Override the bound provider.                                                                  |

**Example — manual commit → reveal:**

```ts
import { Wallet, commitmentHash, getBytes, parseQuanta, TxType } from "pyde-ts-sdk";
import { randomBytes } from "node:crypto";

const wallet = Wallet.generate();
wallet.connect(provider);

const [base, chainId] = await provider.getNonceAndChainId(wallet.address);

// 1. Sign the hidden inner tx ONCE — reuse these exact bytes everywhere.
const innerWire = wallet.signTransaction({
  from: wallet.address,
  to: "0xrecipient...",
  value: parseQuanta("5").toString(),
  data: "0x",
  gasLimit: 100_000,
  nonce: base + 2n,
  chainId,
  txType: TxType.Standard,
});
const innerBytes = getBytes(innerWire);

// 2. Commit to it under a fresh 32-byte salt, then await inclusion.
const salt = randomBytes(32);
const commitment = commitmentHash(innerBytes, salt);
const commit = await wallet.buildCommit({ commitment, valueCeiling: parseQuanta("5") });
await provider.sendAndWait(commit.wire); // reserves the slot, posts commit.bond

// 3. Once the commit is included, open it.
const reveal = await wallet.buildReveal({ commitment, nonce: salt, innerTx: innerBytes });
await provider.sendRawTransaction(reveal.wire);
```

---

## `PrivateSendHandle`

The handle returned by [`sendPrivate`](#walletsendprivateinner) / [`transferPrivate`](#wallettransferprivateto-amount-opts). The commit and reveal are plumbing; the outcome that matters is the **inner** tx receipt, which `waitForReceipt` resolves.

```ts
interface PrivateSendHandle {
  commitHash: string; // Commit tx hash (reserved the slot, posted the bond)
  revealHash: string; // Reveal tx hash (opened the commitment; bond refunded on accept)
  innerHash: string; // hidden inner tx hash — the receipt key for the REAL outcome
  commitReceipt: Receipt; // the Commit tx's own receipt (already resolved)
  waitForReceipt(timeoutMs?: number): Promise<Receipt>;
}
```

`waitForReceipt(timeoutMs?)` resolves on the inner tx's receipt — it executes in the reveal wave's resolution pass, in commit order, so allow a few waves. Throws `TimeoutError` if not seen by `timeoutMs`.

---

## `wallet.stakeDeposit(falconPubkey, amount, opts?)`

Validator-side flow. Lock ≥ `MIN_VALIDATOR_STAKE` (10,000 PYDE) and register as a validator.

**Signature:**

```ts
wallet.stakeDeposit(
  falconPubkey: string,
  amount: bigint | number,
  opts?: { gasLimit?: number; provider?: Provider },
): Promise<Receipt>
```

`falconPubkey` is the `0x`-prefixed hex of the 897-byte FALCON-512 pubkey the chain will record against the validator record. Typically the wallet's own `publicKey`, but separable for delegated-validator-key setups.

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
- **`sendPrivate` / `transferPrivate` work with any wallet.** Handle-backed (`Wallet.generate()`) or hex-backed — no special constraint. Reveal within `COMMIT_REVEAL_WINDOW_WAVES` (120 waves) or the bond is burned; the one-call flow auto-reveals on commit inclusion, so this only bites manual `buildCommit` / `buildReveal` flows.
- **`Wallet.sendCall` round-trips to the chain for gas + access list.** Each invocation does a probe-sign + `simulateTransaction` before the real submit. Pin `opts.gasLimit` when you've already got a bound and want to skip the extra RPC. `Wallet.transfer` stays cheap (fixed 100k, no simulate).
