# 09 — Encrypted mempool (MEV protection)

Threshold-encrypts the sensitive parts of a tx so the mempool can't front-run, sandwich, or censor.

[← TOC](./README.md)

---

## Table of contents

- [Engine-side gap (read before using)](#engine-side-gap-read-before-using)
- [Why it exists](#why-it-exists)
- [When to use it](#when-to-use-it)
- API
  - [`wallet.sendEncrypted(to, data, opts?)`](#walletsendencryptedto-data-opts)
  - [`wallet.transferEncrypted(to, amount, opts?)`](#wallettransferencryptedto-amount-opts)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Privacy considerations](#privacy-considerations)
  - [Access lists are opt-in](#access-lists-are-opt-in)
- [Hex SK only (today)](#hex-sk-only-today)
- [Deadline](#deadline)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## Engine-side gap (read before using)

The devnet doesn't yet expose `pyde_sendRawEncryptedTransaction` or `pyde_getThresholdPublicKey`. The SDK encoder + sign path is complete; live exercise lands when the engine ships these methods.

**This means:** every `sendEncrypted` / `transferEncrypted` call below currently fails with `RpcError("method not found")` against the devnet. The SDK surface is stable — when the engine catches up, no SDK changes will be needed.

---

## Why it exists

In a plain mempool, validators (and anyone watching the gossip) see every pending tx's `to`, `value`, and `calldata` before commit. That's enough to:

- **Front-run** any DEX swap.
- **Sandwich-attack** any high-value action.
- **Censor** a tx that hurts the validator's positions.

Pyde's encrypted mempool resolves this:

1. The SDK encrypts `(to, value, calldata)` against the **current committee's threshold public key** before submission.
2. The encrypted tx flows through gossip + consensus as **opaque ciphertext**.
3. Decryption happens at the **wave-commit boundary** via a threshold of committee shares — no individual validator can decrypt earlier.

The chain still sees `from`, `gas`, `nonce`, `chainId` in cleartext (replay protection requires them). The MEV-relevant fields stay sealed until ordering is locked in.

**Spec:** Pyde Book Chapter 8.5 + Chapter 9.

---

## When to use it

| Use encrypted                          | Use plain                                        |
| -------------------------------------- | ------------------------------------------------ |
| DEX swaps, AMM trades                  | Read-only / view calls (no submission anyway)    |
| NFT mints with bounded supply          | Routine transfers between trusted parties        |
| MEV-sensitive contract interactions    | Internal infra (treasury sweeps from a multisig) |
| Anything you'd front-run if you saw it | Validator staking / reward claims                |

The encrypted path is **~10–20 % more expensive in v1** (additional ciphertext gas + the threshold-decryption surcharge). For low-MEV-risk txs, plain submission is fine.

---

## `wallet.sendEncrypted(to, data, opts?)`

Send a calldata-bearing tx through the encrypted mempool.

**Signature:**

```ts
wallet.sendEncrypted(
  to: string,
  data: string,
  opts?: {
    gasLimit?: number;
    value?: bigint | number | string;
    deadline?: bigint;
    accessList?: AccessEntry[];
    provider?: Provider;
  },
): Promise<{ envelopeHash: string }>
```

**Args:**

| Name              | Type                     | Description                                                          |
| ----------------- | ------------------------ | -------------------------------------------------------------------- |
| `to`              | `string`                 | Target address.                                                      |
| `data`            | `string`                 | Hex calldata. Build via `Contract.encodeCall(...)`.                  |
| `opts.gasLimit`   | `number`                 | Pin gas. Default `100_000_000` (encrypted txs have higher ceilings). |
| `opts.value`      | bigint / number / string | Quanta.                                                              |
| `opts.deadline`   | `bigint`                 | Wave id past which the tx auto-cancels.                              |
| `opts.accessList` | `AccessEntry[]`          | Manual access list. **⚠ leaks slot keys.**                           |
| `opts.provider`   | `Provider`               | Override the bound provider.                                         |

**Returns:** `Promise<{ envelopeHash: string }>` — the chain echoes back
the **envelope hash** (Blake3 of `version ‖ ciphertext_len ‖ ciphertext`).
Receipts key on the inner plaintext tx hash post-decryption; that hash
isn't exposed by `pyde-crypto-wasm.buildRawEncryptedTx` yet, so the SDK
returns `{ envelopeHash }` instead of polling. Treat a successful return
as "admitted to encrypted mempool". When the wasm side exposes the inner
hash, this method will start polling for the receipt the same way
`sendCall` does — no caller-side change.

**Throws:**

- `WalletDestroyedError` — `destroy()` called.
- `SigningError` — handle-backed wallet (encrypted send is hex-only for now).
- `RpcError` — chain rejected.

**Example — encrypted swap:**

```ts
import { Provider, Wallet, Contract, parseQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const wallet = Wallet.generateUnsafe();
wallet.connect(provider);
await wallet.registerPubkey();

const dex = await Contract.fromArtifact("./Dex.bundle/abi.json", "0xdex...", provider);
const calldata = dex.encodeCall("swap", {
  amountIn: parseQuanta("100"),
  tokenIn: "0xtokenA...",
  tokenOut: "0xtokenB...",
  minOut: parseQuanta("95"),
});

const receipt = await wallet.sendEncrypted("0xdex...", calldata, {
  deadline: 999_999n,
});
console.log("encrypted swap:", receipt.success);
```

---

## `wallet.transferEncrypted(to, amount, opts?)`

Encrypted variant of `transfer`. Value-only send through the MEV-protected mempool — hides the recipient + amount until commit.

**Signature:**

```ts
wallet.transferEncrypted(
  to: string,
  amount: bigint | number,
  opts?: { deadline?: bigint; provider?: Provider },
): Promise<{ envelopeHash: string }>
```

**Example:**

```ts
const { envelopeHash } = await wallet.transferEncrypted(
  "0xrecipient...",
  parseQuanta("1"),
  { deadline: 999_999n },
);
console.log("admitted; envelope:", envelopeHash);
```

---

## How it works under the hood

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. SDK fetches the committee's threshold public key:            │
│       pk = provider.getThresholdPublicKey()                     │
│                                                                 │
│ 2. SDK fetches (nonce, chainId) for the sender.                 │
│                                                                 │
│ 3. SDK calls pyde-crypto-wasm to build the encrypted envelope:  │
│       wire = buildRawEncryptedTx(params, sk_hex)                │
│    which:                                                       │
│       (a) Borsh-encodes the plain payload:                      │
│           borsh_encode(to, value, calldata, …)                  │
│       (b) Threshold-encrypts the payload against `pk`           │
│           (Kyber-768 KEM).                                      │
│       (c) FALCON-512-signs the envelope with the sender's SK.   │
│       (d) Returns the wire-hex.                                 │
│                                                                 │
│ 4. SDK sends via provider.sendRawEncryptedTransaction(wire).    │
│                                                                 │
│ 5. Engine queues the ciphertext in the encrypted mempool. At    │
│    wave-commit, committee shares are revealed and the chain     │
│    decrypts + executes the txs in their final committed order.  │
│                                                                 │
│ 6. SDK polls for the receipt the same way as a plain tx.        │
└─────────────────────────────────────────────────────────────────┘
```

`getThresholdPublicKey` **rotates per epoch** — the SDK fetches it on every encrypted submission rather than caching, so a stale key never gets you stuck.

---

## Privacy considerations

### Access lists are opt-in

```ts
await wallet.sendEncrypted(to, data, {
  accessList: myEntries, // ⚠ leaks the touched slot keys
});
```

The plain mempool accepts access lists as a hint to the parallel scheduler — they let the chain place a tx without serializing it against unknown state.

**In the encrypted path, the access list defeats the encryption** for the slot keys it lists. The SDK leaves it **off by default** — only pass `opts.accessList` when you explicitly want the parallel-scheduler hint and your storage layout doesn't disclose sensitive information from slot keys alone (e.g., the shape doesn't reveal which user is interacting).

---

## Hex SK only (today)

`sendEncrypted` requires a hex-backed wallet:

```ts
const wallet = Wallet.generateUnsafe(); // hex SK in JS heap
await wallet.sendEncrypted(...);
```

Handle-backed wallets (`Wallet.generate()`) work everywhere else but not encrypted submission yet — that needs `buildRawEncryptedTxWithHandle` in `pyde-crypto-wasm`, on the engine-side gap list.

**Workarounds:**

- Generate hex → use immediately → `destroy()` after the tx.
- Maintain a separate hex-backed wallet for encrypted ops and a handle-backed wallet for the rest.

---

## Deadline

```ts
await wallet.sendEncrypted(to, data, { deadline: 1_000_000n });
```

If the chain doesn't commit the tx by wave `deadline`, the chain **auto-cancels** it — the encrypted payload never gets decrypted, so there's no leakage.

Useful when the tx's purpose is time-sensitive (an arbitrage that's only profitable for ~5 waves).

---

## Errors

| Class                  | When                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `WalletDestroyedError` | `destroy()` called before send.                                                                            |
| `SigningError`         | Hex SK invalid / WASM signer failed / handle-backed wallet.                                                |
| `RpcError`             | Chain rejected the encrypted submission (e.g., committee key mismatch).                                    |
| `TimeoutError`         | Receipt polling timed out. The tx may still commit later — re-check with `provider.getTransactionReceipt`. |

---

## Gotchas

- **Encryption doesn't hide gas / nonce / sender.** Replay protection requires them in cleartext. If you need to hide the sender, run through a relayer.
- **The committee key rotates per epoch.** The SDK refetches on every send; no caching footgun.
- **Passing `accessList` defeats the MEV protection** for the slot keys it lists. The default is off — don't pass one without thinking through what you're revealing.
- **Plain `getTransactionReceipt`** is fine to poll — the receipt for an encrypted tx looks identical post-commit (decryption happened on chain).
- **You can't preview the ciphertext content.** `simulate` / `previewTransaction` only work on plain calls. Build the encrypted path with what you know about the contract; bugs surface as on-chain reverts.
- **Engine-side gap:** as of this writing, the devnet doesn't expose `pyde_sendRawEncryptedTransaction` or `pyde_getThresholdPublicKey`. Live exercise goes green once the engine ships them.
