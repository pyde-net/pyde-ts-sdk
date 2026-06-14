# 09 — Encrypted mempool (MEV protection)

Threshold-encrypts the sensitive parts of a tx so the mempool can't front-run, sandwich, or censor.

[← TOC](./README.md)

> **Engine-side gap:** the devnet doesn't yet expose `pyde_sendRawEncryptedTransaction` or `pyde_getThresholdPublicKey`. The SDK encoder + sign path is complete; live exercise lands when the engine ships these methods.

## Why

In a plain mempool, validators (and anyone watching the gossip) see every pending tx's `to`, `value`, and `calldata` before commit. That's enough to front-run any DEX swap, sandwich-attack any high-value action, or censor a tx that hurts the validator's positions.

Pyde's encrypted mempool resolves this by:

1. Encrypting `(to, value, calldata)` against the **current committee's threshold public key** before submission.
2. Letting the encrypted tx flow through gossip / consensus as opaque ciphertext.
3. Decrypting at the **wave-commit boundary** via a threshold of committee shares — no individual validator can decrypt earlier.

The chain still sees `from`, `gas`, `nonce`, `chainId` (replay protection requires these). The MEV-relevant fields stay sealed until ordering is locked in.

Spec: Pyde Book Chapter 8.5 + Chapter 9.

## When to use it

| Use encrypted | Use plain |
|---|---|
| DEX swaps, AMM trades | Read-only / view calls (no submission anyway) |
| NFT mints with bounded supply | Routine transfers between trusted parties |
| MEV-sensitive contract interactions | Internal infra (treasury sweeps from a multisig) |
| Anything you'd front-run if you saw it | Validator staking / reward claims |

The encrypted path is ~10–20 % more expensive in v1 (additional ciphertext gas + the threshold-decryption surcharge). For low-MEV-risk txs, plain submission is fine.

## API

```ts
wallet.sendEncrypted(
  to: string,
  data: string,           // hex calldata (use Contract.encodeCall to build it)
  opts?: {
    gasLimit?: number;
    value?: bigint | number | string;
    deadline?: number;    // wave id past which the tx auto-cancels
    accessList?: AccessEntry[];
    estimateAccess?: boolean; // ⚠ off by default — leaks touched slot keys
    provider?: Provider;
  },
): Promise<Receipt>
```

```ts
wallet.transferEncrypted(
  to: string,
  amount: bigint | number,
  opts?: { deadline?: number; provider?: Provider },
): Promise<Receipt>
```
Convenience wrapper for a value-only send (no calldata, fixed `gasLimit: 21_000`).

## How it works

```
1. SDK fetches the committee's threshold public key via:
     pk = provider.getThresholdPublicKey()

2. SDK fetches (nonce, chainId) for the sender.

3. SDK calls pyde-crypto-wasm to build an encrypted tx envelope:
     wire = buildRawEncryptedTx(params, sk_hex)
   which:
     (a) builds the plain tx payload: borsh-encode(to, value, calldata, …)
     (b) threshold-encrypts the payload against `pk` (Kyber-768 KEM)
     (c) signs the envelope (FALCON-512) with the sender's SK
     (d) returns the wire-hex.

4. SDK sends via provider.sendRawEncryptedTransaction(wire).

5. Engine queues the ciphertext in the encrypted mempool. At wave-commit,
   committee shares are revealed and the chain decrypts + executes the txs
   in their final committed order.

6. SDK polls for the receipt the same way as a plain tx.
```

`getThresholdPublicKey` rotates per epoch — the SDK fetches it on every encrypted submission rather than caching, so a stale key never gets you stuck.

## Access lists are opt-in

```ts
await wallet.sendEncrypted(to, data, {
  estimateAccess: true, // ⚠ leaks the touched slot keys
});
```

The plain mempool accepts access lists as a hint to the parallel scheduler — they let the chain place a tx without serializing it against unknown state. **In the encrypted path, the access list defeats the encryption** for the slot keys it lists. The SDK leaves it **off by default**; only opt in if your contract's storage layout doesn't reveal sensitive information.

## Hex SK only (today)

`sendEncrypted` requires a hex-backed wallet:

```ts
const wallet = Wallet.generateUnsafe(); // hex SK in JS heap
await wallet.sendEncrypted(...);
```

Handle-backed wallets (`Wallet.generate()`) work everywhere else but not encrypted submission yet — that needs `buildRawEncryptedTxWithHandle` in `pyde-crypto-wasm`, which is on the SDK's "engine-side gap" list.

To work around: generate hex, encrypt-and-discard after the tx, or maintain a separate hex-backed wallet for encrypted ops and a handle-backed wallet for the rest.

## Deadline

```ts
await wallet.sendEncrypted(to, data, { deadline: 1_000_000n });
```

If the chain doesn't commit the tx by wave `deadline`, the chain auto-cancels it (the encrypted payload never gets decrypted, so there's no leakage). Useful when the tx's purpose is time-sensitive (an arbitrage that's only profitable for ~5 waves).

## Errors

| Class | When |
|---|---|
| `WalletDestroyedError` | `destroy()` called before send. |
| `SigningError` | hex SK invalid / WASM signer failed. |
| `RpcError` | Chain rejected the encrypted submission (e.g., committee key mismatch). |
| `TimeoutError` | Receipt polling timed out. The tx may still commit later — re-check with `provider.getTransactionReceipt`. |

## Gotchas

- **Encryption doesn't hide gas / nonce / sender.** Replay protection requires them in cleartext. If you need to hide the sender, run through a relayer.
- **The committee key rotates per epoch.** The SDK refetches on every send; no caching footgun.
- **`estimateAccess: true` defeats the MEV protection** for the slot keys it lists. The default is off — don't flip it without thinking through what you're revealing.
- **Plain `getTransactionReceipt`** is fine to poll — the receipt for an encrypted tx looks identical post-commit (decryption happened on chain).
- **You can't preview the ciphertext content.** `simulate` / `previewTransaction` only work on plain calls. Build the encrypted path with what you know about the contract; bugs surface as on-chain reverts.
