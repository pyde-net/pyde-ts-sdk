# 09 — Private transactions (commit-reveal)

Reserve a tx's ordering slot with a salted Blake3 commitment before its contents are visible, then open it with a reveal — so the mempool can't content-target your tx for a front-run or sandwich.

[← TOC](./README.md)

---

## Table of contents

- [What it guarantees (and what it doesn't)](#what-it-guarantees-and-what-it-doesnt)
- [How it works — commit → reveal → execute](#how-it-works--commit--reveal--execute)
- [When to use it](#when-to-use-it)
- High-level API
  - [`wallet.sendPrivate(inner)`](#walletsendprivateinner)
  - [`wallet.transferPrivate(to, amount, opts?)`](#wallettransferprivateto-amount-opts)
  - [`PrivateSendHandle`](#privatesendhandle)
- Low-level API (relays / advanced flows)
  - [`wallet.buildCommit(args, opts?)`](#walletbuildcommitargs-opts)
  - [`wallet.buildReveal(args, opts?)`](#walletbuildrevealargs-opts)
- [Primitives — `pyde-ts-sdk/private-tx`](#primitives--pyde-ts-sdkprivate-tx)
  - [Constants](#constants)
  - [`requiredBond(valueCeiling)`](#requiredbondvalueceiling)
  - [`commitmentHash(innerTxBytes, nonce)`](#commitmenthashinnertxbytes-nonce)
  - [`encodeCommitPayload` / `encodeRevealPayload`](#encodecommitpayload--encoderevealpayload)
- [Bond economics](#bond-economics)
- [The reveal window](#the-reveal-window)
- [Sign the inner tx once (FALCON non-determinism)](#sign-the-inner-tx-once-falcon-non-determinism)
- [Errors](#errors)
- [Gotchas](#gotchas)

---

## What it guarantees (and what it doesn't)

In a plain mempool, validators (and anyone watching gossip) see every pending tx's `to`, `value`, and `data` before its order is locked in. That's enough to **front-run** a swap, **sandwich** a high-value action, or **censor** a tx that hurts a validator's positions.

Commit-reveal breaks the link between _seeing a tx's contents_ and _placing it in the order_:

1. You publish a **Commit** — a salted `Blake3` hash of the fully-signed inner tx. The commit reserves an ordering slot in its wave; the contents stay hidden.
2. Once the order is finalized, you publish a **Reveal** that discloses the salt + the inner tx bytes. The inner tx executes in the reveal wave's resolution pass, **in commit order**.

No secret key is involved anywhere. There is no committee, no shared secret, nothing to reconstruct or trust — a reveal opens exactly one transaction and unlocks nothing else.

**Honest guarantee — state it exactly this way:**

> Content-targeted front-running is prevented. This is **not** a total ordering lock against unrelated txs that arrive in the reveal→execute window.

An adversary can't read your swap and insert a targeted trade ahead of it, because your ordering slot was fixed before your bytes were visible. An adversary _can_ still submit unrelated txs into the same wave — commit-reveal fixes _your_ position relative to what was already committed, not the entire wave's composition.

**Spec:** Pyde Book Chapter 9.

---

## How it works — commit → reveal → execute

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. Sign the inner tx ONCE.                                            │
│       innerWire  = wallet.signTransaction(innerTx)                    │
│       innerBytes = getBytes(innerWire)   // reuse verbatim            │
│                                                                       │
│ 2. Draw a fresh 32-byte salt and hash the commitment:                │
│       commitment = commitmentHash(innerBytes, salt)                   │
│                  = Blake3("pyde-commit-reveal-v1" ‖ innerBytes ‖ salt)│
│                                                                       │
│ 3. COMMIT (TxType.Commit = 0x11): to = zero address, value = bond.   │
│       data = encodeCommitPayload({ commitment, valueCeiling })       │
│    Reserves the ordering slot; debits the bond. Await inclusion.     │
│                                                                       │
│ 4. REVEAL (TxType.Reveal = 0x12): to = zero address, value = 0.      │
│       data = encodeRevealPayload({ commitment, nonce: salt, innerTx })│
│    Discloses (salt, innerBytes). Sent AFTER the commit is included,  │
│    so commit_wave < reveal_wave (the engine requires this).          │
│                                                                       │
│ 5. EXECUTE: the engine recomputes the commitment from the revealed   │
│    bytes, matches it, and runs the inner tx in the reveal wave's     │
│    resolution pass — in commit order. The bond is refunded.          │
└──────────────────────────────────────────────────────────────────────┘
```

The chain still sees `from`, `gas`, `nonce`, and `chainId` in cleartext on the commit and reveal txs (replay protection requires them). The MEV-relevant fields — `to`, `value`, `data` — stay sealed inside the commitment until the reveal.

---

## When to use it

| Use a private tx                       | Use a plain tx                                   |
| -------------------------------------- | ------------------------------------------------ |
| DEX swaps, AMM trades                  | Read-only / view calls (no submission anyway)    |
| NFT mints with bounded supply          | Routine transfers between trusted parties        |
| MEV-sensitive contract interactions    | Internal infra (treasury sweeps from a multisig) |
| Anything you'd front-run if you saw it | Validator staking / reward claims                |

A private tx costs one extra commit tx (plus a refundable bond) and adds a few waves of latency versus a plain send. For low-MEV-risk txs, plain submission is fine.

---

## `wallet.sendPrivate(inner)`

One-call commit-reveal. Signs the inner tx, posts the commit, waits for the commit to be included, then auto-reveals — all in a single `await`. The returned handle's `waitForReceipt()` resolves on the **inner tx** receipt: the real outcome.

**Signature:**

```ts
wallet.sendPrivate(inner: {
  to: string;
  data?: string;                              // calldata hex; "0x" for value-only
  value?: bigint | number | string;           // quanta
  gasLimit?: number;
  valueCeiling?: bigint | number | string;    // must be >= value; drives the bond
  accessList?: AccessEntry[];
  provider?: Provider;
  timeoutMs?: number;
}): Promise<PrivateSendHandle>
```

**Args:**

| Name           | Type                     | Description                                                                                                                                 |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `to`           | `string`                 | Target address of the hidden inner tx.                                                                                                      |
| `data`         | `string`                 | Hex calldata. `"0x"` for a value-only send. Build via `Contract.encodeCall(...)`.                                                           |
| `value`        | bigint / number / string | Quanta attached to the inner tx. Default `0`.                                                                                               |
| `gasLimit`     | `number`                 | Inner-tx gas. Default `100_000` for `data === "0x"`, else `5_000_000`.                                                                      |
| `valueCeiling` | bigint / number / string | Declared upper bound on the hidden value. Must be `>= value`. Drives the bond. **Over-declare to hide the true amount.** Default = `value`. |
| `accessList`   | `AccessEntry[]`          | Optional parallel-scheduler hint for the inner tx.                                                                                          |
| `provider`     | `Provider`               | Override the bound provider.                                                                                                                |
| `timeoutMs`    | `number`                 | Applied to both the commit-inclusion wait and the inner-tx receipt wait.                                                                    |

**Returns:** `Promise<PrivateSendHandle>` — see [`PrivateSendHandle`](#privatesendhandle).

**Throws:**

- `WalletDestroyedError` — `destroy()` was called.
- `SigningError` — `valueCeiling < value`, or the WASM signer failed.
- `RpcError` — the chain rejected the commit or reveal.

**Example — a private swap:**

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

const handle = await wallet.sendPrivate({
  to: "0xdex...",
  data: calldata,
  // Over-declare the ceiling so the true value isn't inferable from the bond.
  // bond = max(1 PYDE, 1% of valueCeiling).
  valueCeiling: parseQuanta("500"),
});

console.log("commit included:", handle.commitHash);
console.log("reveal broadcast:", handle.revealHash);

// Resolves on the INNER tx receipt — the real swap outcome.
const receipt = await handle.waitForReceipt();
console.log("swap ok:", receipt.success, "gas used:", receipt.gasUsed);
```

---

## `wallet.transferPrivate(to, amount, opts?)`

Value-only convenience over `sendPrivate` (`data = "0x"`). Hides the recipient + amount behind the commitment until the reveal.

**Signature:**

```ts
wallet.transferPrivate(
  to: string,
  amount: bigint | number,
  opts?: {
    valueCeiling?: bigint;
    provider?: Provider;
    timeoutMs?: number;
  },
): Promise<PrivateSendHandle>
```

**Example:**

```ts
const handle = await wallet.transferPrivate("0xrecipient...", parseQuanta("1"), {
  // Over-declare so the bond doesn't reveal the transfer is exactly 1 PYDE.
  valueCeiling: parseQuanta("50"),
});
const receipt = await handle.waitForReceipt();
console.log("transfer ok:", receipt.success);
```

---

## `PrivateSendHandle`

Returned by `sendPrivate` / `transferPrivate`. The commit and reveal are plumbing; the outcome you care about is the **inner** tx receipt, which `waitForReceipt` resolves.

```ts
interface PrivateSendHandle {
  /** Hash of the Commit tx (reserved the ordering slot, posted the bond). */
  commitHash: string;
  /** Hash of the Reveal tx (opened the commitment; bond refunded on accept). */
  revealHash: string;
  /** Hash of the hidden inner tx — the receipt key for the REAL outcome. */
  innerHash: string;
  /** The Commit tx's own receipt (already resolved — the commit was awaited). */
  commitReceipt: Receipt;
  /** Resolves on the INNER tx's receipt. It executes in the reveal wave's
   *  resolution pass, in commit order — so allow a few waves. Throws
   *  `TimeoutError` if not seen by `timeoutMs` (default 30 s). */
  waitForReceipt(timeoutMs?: number): Promise<Receipt>;
}
```

`waitForReceipt` keys on `innerHash`, not `commitHash` or `revealHash` — polling either of those returns the plumbing receipt, not the swap/transfer result.

---

## `wallet.buildCommit(args, opts?)`

Low-level: build + sign a `Commit` tx and return the signed wire, its hash, and the bond posted. Most callers want `sendPrivate` — this exists for relays and advanced flows that manage the commit and reveal separately.

**Signature:**

```ts
wallet.buildCommit(
  args: { commitment: Uint8Array; valueCeiling: bigint },
  opts?: { gasLimit?: number; provider?: Provider },
): Promise<{ wire: string; hash: string; bond: bigint }>
```

Fetches the sender's next nonce + chainId internally, sets `to = zero address`, `value = requiredBond(valueCeiling)`, `txType = Commit`, and `data = encodeCommitPayload({ commitment, valueCeiling })`.

---

## `wallet.buildReveal(args, opts?)`

Low-level: build + sign a `Reveal` tx for an already-committed commitment. **Relay-friendly — any wallet may reveal on behalf of the committer** (the disclosed preimage is the authorization). `innerTx` is the signed inner-tx wire (hex or bytes) that was hashed into the commitment.

**Signature:**

```ts
wallet.buildReveal(
  args: { commitment: Uint8Array; nonce: Uint8Array; innerTx: Uint8Array | string },
  opts?: { gasLimit?: number; provider?: Provider },
): Promise<{ wire: string; hash: string }>
```

Sets `to = zero address`, `value = 0`, `txType = Reveal`, and `data = encodeRevealPayload({ commitment, nonce, innerTx })`.

**Example — manage the commit and reveal by hand:**

```ts
import { Provider, Wallet, TxType, getBytes, commitmentHash } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const wallet = Wallet.generateUnsafe();
wallet.connect(provider);

// 1. Sign the inner tx ONCE. The commit, reveal, and inner tx occupy three
//    consecutive nonces (they execute commit → reveal → inner, in that order).
const base = await wallet.getNonce();
const innerTx = {
  from: wallet.address,
  to: "0xrecipient...",
  value: parseQuanta("1"),
  data: "0x",
  gasLimit: 100_000,
  nonce: base + 2n,
  chainId: 31337,
  txType: TxType.Standard,
};
const innerWire = wallet.signTransaction(innerTx);
const innerBytes = getBytes(innerWire); // reuse these EXACT bytes below

// 2. Salt + commitment.
const salt = crypto.getRandomValues(new Uint8Array(32));
const commitment = commitmentHash(innerBytes, salt);

// 3. Commit (posts the bond) — await inclusion so commit_wave < reveal_wave.
const commit = await wallet.buildCommit({ commitment, valueCeiling: parseQuanta("50") });
await provider.sendAndWait(commit.wire);
console.log("bond posted:", commit.bond, "quanta");

// 4. Reveal — disclose (salt, innerBytes). Any wallet holding these may send it.
const reveal = await wallet.buildReveal({ commitment, nonce: salt, innerTx: innerBytes });
await provider.sendRawTransaction(reveal.wire);
```

---

## Primitives — `pyde-ts-sdk/private-tx`

Everything below is exported both from `./private-tx` and from the package root `pyde-ts-sdk`. Use these to build commit/reveal payloads directly (e.g. inside a relay) without going through `Wallet`.

### Constants

| Symbol                       | Value                     | Meaning                                                                                                                |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `COMMIT_REVEAL_WINDOW_WAVES` | `120n`                    | Reveal window in waves (~60 s at 500 ms/wave). Miss it → bond forfeit. A censorship cushion, not the expected latency. |
| `MIN_COMMIT_BOND`            | `1_000_000_000n`          | Flat bond floor: 1 PYDE (1 PYDE = 10⁹ quanta).                                                                         |
| `COMMIT_BOND_BPS`            | `100n`                    | Bond scaling in basis points of `valueCeiling` (100 bps = 1%).                                                         |
| `COMMITMENT_DOMAIN_TAG`      | `"pyde-commit-reveal-v1"` | Domain-separation tag hashed into every commitment. Wire-frozen.                                                       |
| `TxType.Commit`              | `0x11`                    | Commit tx type. `to` = zero address, `value` = bond.                                                                   |
| `TxType.Reveal`              | `0x12`                    | Reveal tx type. `to` = zero address, `value` = 0.                                                                      |

**Payload types:**

```ts
interface CommitPayload {
  commitment: Uint8Array; // 32-byte commitmentHash(innerTxBytes, nonce)
  valueCeiling: bigint; // sender-declared upper bound on the hidden value (u128 quanta)
}

interface RevealPayload {
  commitment: Uint8Array; // must equal the committed hash
  nonce: Uint8Array; // the 32-byte salt drawn at commit time
  innerTx: Uint8Array; // borsh(Tx) of the hidden, fully-signed tx — the SAME bytes hashed in
}
```

### `requiredBond(valueCeiling)`

```ts
requiredBond(valueCeiling: bigint): bigint
// = max(MIN_COMMIT_BOND, valueCeiling * COMMIT_BOND_BPS / 10_000n)
```

The minimum bond a `Commit` must post for a declared `valueCeiling`. Debited at commit, refunded when the matching reveal is accepted, burned if the commitment is never revealed inside the window.

```ts
import { requiredBond, parseQuanta } from "pyde-ts-sdk";

requiredBond(parseQuanta("0.5")); // 1_000_000_000n  (floor: 1 PYDE)
requiredBond(parseQuanta("500")); // 5_000_000_000n  (1% of 500 PYDE = 5 PYDE)
```

### `commitmentHash(innerTxBytes, nonce)`

```ts
commitmentHash(innerTxBytes: Uint8Array, nonce: Uint8Array /* 32 bytes */): Uint8Array
// = Blake3(COMMITMENT_DOMAIN_TAG ‖ innerTxBytes ‖ nonce)
```

`innerTxBytes` is `borsh(inner_tx)` of the fully-signed hidden tx; `nonce` is a fresh 32-byte CSPRNG salt, never reused. Mirrors the engine's `commitment_hash` byte-for-byte. Throws if `nonce.length !== 32`.

### `encodeCommitPayload` / `encodeRevealPayload`

```ts
encodeCommitPayload({ commitment, valueCeiling }: CommitPayload): Uint8Array
// = commitment[32] ‖ value_ceiling (u128 LE, 16 bytes)

encodeRevealPayload({ commitment, nonce, innerTx }: RevealPayload): Uint8Array
// = commitment[32] ‖ nonce[32] ‖ borsh Vec<u8>(innerTx)  (u32 LE length prefix + bytes)
```

These are the exact bytes that go in `tx.data` for a Commit (`0x11`) and Reveal (`0x12`) respectively. `buildCommit` / `buildReveal` call them for you.

---

## Bond economics

The bond prices commit-spam: reserving an ordering slot and never revealing forfeits real value.

| Rule         | Detail                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| **Amount**   | `max(1 PYDE, 1% of valueCeiling)` — the flat floor or 1% of the declared ceiling, whichever is larger. |
| **Debited**  | At commit (it's the Commit tx's `value`).                                                              |
| **Refunded** | When the matching reveal is accepted inside the window.                                                |
| **Burned**   | If the commitment is never revealed within `COMMIT_REVEAL_WINDOW_WAVES`.                               |

Because the bond scales with `valueCeiling`, **over-declaring the ceiling to hide your true amount costs more** — it's a deliberate privacy/cost trade-off. Declare only as high as your privacy needs require.

---

## The reveal window

A commit not revealed within `COMMIT_REVEAL_WINDOW_WAVES` (`120n`, ~60 s at 500 ms/wave) after its commit wave forfeits its bond and its reserved slot lapses.

An honest wallet auto-reveals as soon as the commit finalizes (~1–2 s end to end) — `sendPrivate` does this for you. The 120-wave window is a **liveness / censorship cushion**, not the latency you should expect. If a validator briefly censors your reveal, you still have the rest of the window to get it in.

---

## Sign the inner tx once (FALCON non-determinism)

**The single most important rule of the low-level flow:** sign the inner tx **once**, and reuse those exact bytes for both the commitment hash and the reveal payload.

FALCON-512 signatures are **non-deterministic** — signing the same tx twice yields different bytes. If you re-encode or re-sign the inner tx between commit and reveal, its bytes change, the engine's recomputed `commitmentHash` no longer matches the committed value, and **the reveal is rejected** — you lose the bond.

```ts
// ✅ Correct: sign once, reuse the bytes.
const innerWire = wallet.signTransaction(innerTx);
const innerBytes = getBytes(innerWire);
const commitment = commitmentHash(innerBytes, salt);
// ... later, reveal with the SAME innerBytes:
await wallet.buildReveal({ commitment, nonce: salt, innerTx: innerBytes });

// ❌ Wrong: re-signing produces different (non-deterministic) bytes.
const commitment = commitmentHash(getBytes(wallet.signTransaction(innerTx)), salt);
await wallet.buildReveal({
  commitment,
  nonce: salt,
  innerTx: getBytes(wallet.signTransaction(innerTx)), // DIFFERENT bytes → reveal rejected
});
```

`sendPrivate` handles this internally — it signs the inner tx once and threads the same bytes through both steps.

---

## Errors

| Class                  | When                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WalletDestroyedError` | `destroy()` called before `sendPrivate` / `buildCommit` / `buildReveal`.                                                                   |
| `SigningError`         | `valueCeiling < value`, malformed inner tx, or WASM signer failure.                                                                        |
| `RpcError`             | Chain rejected the commit or reveal (e.g. bond too low, commitment mismatch, window elapsed).                                              |
| `TimeoutError`         | `waitForReceipt` didn't see the inner-tx receipt by `timeoutMs`. The tx may still commit — re-check with `provider.getTransactionReceipt`. |

See [Chapter 10 — Errors](./10-errors.md).

---

## Gotchas

- **Commit-reveal hides _contents_, not _identity_.** `from`, `gas`, `nonce`, and `chainId` are cleartext on the commit and reveal txs (replay protection needs them). If you must hide the sender, route through a relayer.
- **The guarantee is scoped.** Content-targeted front-running is prevented; it is **not** a total ordering lock against unrelated txs arriving in the reveal→execute window.
- **`waitForReceipt` resolves on the _inner_ tx**, not the commit or reveal. Poll `handle.innerHash` (which it does for you) — never `commitHash` / `revealHash` — for the real outcome.
- **Sign the inner tx once.** FALCON-512 is non-deterministic; re-signing breaks the commitment match and burns your bond. See [above](#sign-the-inner-tx-once-falcon-non-determinism).
- **The bond scales with `valueCeiling`.** Over-declaring hides your amount but costs 1% of the ceiling (min 1 PYDE). It's refunded on reveal-accept, burned on abandon.
- **Reveal before the window closes.** Miss `COMMIT_REVEAL_WINDOW_WAVES` (120 waves, ~60 s) and the bond is forfeit. `sendPrivate` auto-reveals in ~1–2 s; the window only matters if a reveal is delayed or censored.
- **Any wallet can reveal.** `buildReveal` needs only `(commitment, salt, innerBytes)` — the disclosed preimage is the authorization, which is what makes relay-submitted reveals possible.
