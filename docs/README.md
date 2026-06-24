# pyde-ts-sdk — reference documentation

TypeScript SDK for [Pyde](https://pyde.network) — the post-quantum, MEV-resistant L1.

This is the full reference. For the 5-line "send a transaction" path, jump straight to [Quickstart](./01-quickstart.md). For the surface map of every public export, scroll to the **TOC** below.

## Status

Pre-1.0, in active development. Spec citations in every chapter tie behavior back to the [Pyde Book](https://book.pyde.network).

What works today (verified live against `otigen devnet`):

- HTTP RPC: chain id, balance, account, nonce, batch, wave header decode, log paging
- Borsh-canonical contract codec — primitives, `String`, `Bytes`, `Vec<T>`, `Option<T>`, tuple, fixed array, struct, enum
- Contract round-trips through deployed `otigen/examples/borsh-coverage` (struct + enum + Vec live-verified)
- Handle-based wallet (FALCON-512 SK stays in the WASM heap)
- Argon2id + ChaCha20-Poly1305 keystore (Node-only file helpers)
- Type-safe `Contract<TAbi>` narrowing via `pyde-tsgen`-emitted ABI shapes
- Wallet adapter pattern (`InMemoryWalletAdapter` + `BrowserWalletAdapter`) for dapp ↔ wallet wiring

Still gated on engine work — surfaces exist, but the chain hasn't shipped the RPC yet:

- `pyde_subscribe` / `pyde_unsubscribe` — WS subscriptions
- `pyde_sendRawEncryptedTransaction` + `pyde_getThresholdPublicKey` — encrypted (MEV-protected) submission
- **Tier-2 catalog alignment** — wrap `pyde_simulateTransaction` so `Wallet.transfer` / `sendCall` / `Contract.estimateGas` pick up real chain estimates instead of fixed 100k / 5M defaults, and access lists can be inferred. Same `pyde_simulateTransaction` returns the receipt + access list together. (Today the SDK uses hardcoded defaults and the chain serializes against missing access lists.)

Still gated on tooling — code path is built, no funded test:

- Wallet `generate → fund → registerPubkey → transfer` end-to-end (needs `pyde-crypto-wasm.keypairFromSeed` to derive devnet prefunded keys locally, or `otigen wallet transfer` to push value to an SDK address)

## Install

```bash
npm install pyde-ts-sdk
```

> **Not yet published to npm.** The line above is what the install will look like; for now, link locally against the source.

Requires Node ≥ 20 (Node 22 recommended). The browser bundle is ESM via `dist/index.js`; pair with Vite / Rollup / webpack. `pyde-crypto-wasm`'s ESM-bundler shape needs a wasm loader (`vite-plugin-wasm` for Vite, native `webassembly/async` for webpack 5).

## TOC

| Chapter                                             | Topic                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| [01 — Quickstart](./01-quickstart.md)               | Read a balance · Send a transfer · Deploy + call a contract       |
| [02 — Provider](./02-provider.md)                   | HTTP RPC client: every method, options, retries, errors           |
| [03 — Wallet](./03-wallet.md)                       | Handle vs hex SK, keystore, sign, gas auto-estimate               |
| [04 — Contract](./04-contract.md)                   | `Contract.read` / `write` / `queryFilter` + `Contract<TAbi>`      |
| [05 — Codegen (`pyde-tsgen`)](./05-codegen.md)      | ABI → TS bindings, type-safe `<Name>Abi` shape                    |
| [07 — Wallet adapters](./07-wallet-adapters.md)     | `WalletAdapter` interface, `InMemory` + `Browser` + custom        |
| [08 — WebSocket](./08-websocket.md)                 | `WebSocketProvider` — subscriptions, cursor resume, terminalError |
| [09 — Encrypted mempool](./09-encrypted-mempool.md) | MEV-protected submission, threshold encryption flow               |
| [10 — Errors](./10-errors.md)                       | Error hierarchy, `isError`, `scrubError`, retry semantics         |
| [11 — Utility surface](./11-units-hex-address.md)   | `parsePyde` / `hexlify` / `Address`                               |
| [12 — Examples / recipes](./12-examples.md)         | Read · Send · Index · Deploy · Encrypted                          |
| [13 — Migration](./13-migration.md)                 | Upgrade notes between SDK versions                                |
| [14 — Internals](./14-internals.md)                 | Borsh wire format · `CallPayload` · ABI normalisation             |

## At a glance — the public surface

Provider + WebSocket:

```ts
import { Provider, WebSocketProvider } from "pyde-ts-sdk";
```

Signing:

```ts
import { Wallet, AbstractSigner } from "pyde-ts-sdk";
```

Adapters:

```ts
import { InMemoryWalletAdapter, BrowserWalletAdapter, type WalletAdapter } from "pyde-ts-sdk";
```

Contracts:

```ts
import { Contract, Interface, DeployData, type ContractReceipt, type EventLog } from "pyde-ts-sdk";
```

Crypto primitives (used by the higher-level APIs above; rarely needed directly):

```ts
import {
  generateKeypair,
  generateKeypairHandle,
  dropKeypair,
  signMessage,
  signMessageWithHandle,
  hashTransaction,
  poseidon2Hash,
  computeSelector,
  thresholdEncrypt,
  buildRawEncryptedTx,
} from "pyde-ts-sdk";
```

Simulation (Tier 1 — RPC-backed; local wasmtime ships in v1.1):

```ts
import { simulateTransaction, previewTransaction, applySimulation } from "pyde-ts-sdk";
```

Units / hex / address helpers:

```ts
import {
  parsePyde,
  formatPyde,
  parseQuanta,
  formatQuanta,
  parseUnits,
  formatUnits,
  isHexString,
  hexlify,
  getBytes,
  toBeHex,
  concat,
  zeroPadValue,
  stripZeros,
  Address,
} from "pyde-ts-sdk";
```

Errors:

```ts
import {
  PydeError,
  CallExceptionError,
  ConnectionError,
  TimeoutError,
  InvalidArgumentError,
  InsufficientFundsError,
  RpcError,
  SigningError,
  isError,
  isCallException,
  type ErrorCode,
} from "pyde-ts-sdk";
```

Codegen (subpath export, programmatic) or CLI:

```ts
import { generateTypes } from "pyde-ts-sdk/codegen";
// or:
//   npx pyde-tsgen path/to/Foo.abi.json path/to/foo.d.ts --name Foo
```

## Spec references

| Topic                                   | Spec source                                          |
| --------------------------------------- | ---------------------------------------------------- |
| RPC surface                             | Pyde Book Chapter 17.4                               |
| Transaction wire                        | Pyde Book Chapter 11                                 |
| Wave header / state root hybrid         | Pyde Book Chapter 6 + `hash_strategy_and_validation` |
| Encrypted mempool                       | Pyde Book Chapter 8.5 + Chapter 9                    |
| Host fn ABI                             | `HOST_FN_ABI_SPEC.md`                                |
| Event encoding (Borsh)                  | `HOST_FN_ABI_SPEC.md §14`                            |
| Keystore (Argon2id + ChaCha20-Poly1305) | Pyde Book Chapter 17                                 |

## Conventions

- All wave / nonce / `u64` wire fields are `bigint` end-to-end. Use `bigint` literals (`0n`, `42n`) at call sites.
- Addresses are `0x`-prefixed 64 hex chars (32 bytes, full Poseidon2 — no truncation).
- Receipt success is `receipt.success === true`. `txHash` is the canonical Poseidon2 hash.
- Encrypted send is opt-in (`Wallet.sendEncrypted`) and uses a separate path; standard send is plain.
- HTTP / WSS are required by default; pass `allowInsecureTransport: true` on the provider when targeting a local devnet.

## Getting help

- Source: <https://github.com/pyde-net/pyde-ts-sdk>
- Issues: <https://github.com/pyde-net/pyde-ts-sdk/issues>
- Spec book: <https://book.pyde.network>
