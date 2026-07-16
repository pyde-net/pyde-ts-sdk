# Security Policy

This SDK handles cryptographic keys, signs transactions, and connects to live blockchain infrastructure. Security is taken seriously — this document explains how reports are handled, what's in scope, and what callers need to know.

## Reporting a vulnerability

Email **security@pyde.network** with a description of the issue and steps to reproduce. We respond within 72 hours.

Please do not file public GitHub issues for security bugs. The disclosure flow is private until a fix is published and downstream users have had time to upgrade.

## Scope

In scope:

- Memory-safety or sandbox-escape in `pyde-ts-sdk` itself
- Cryptographic misuse (incorrect signing, weak randomness, key leakage)
- Authentication or authorization bypass in any signer or wallet adapter
- Network-level handling that lets a malicious RPC node compromise a caller (e.g., crafted JSON-RPC response causing the SDK to forward unauthenticated state to user code)
- Encrypted-keystore weaknesses (KDF, AEAD, on-disk format)

Out of scope (report upstream):

- Bugs in `pyde-crypto-wasm` — report to that repo
- Bugs in the Pyde node or chain protocol — report under the chain's disclosure policy
- Issues in user-application code that consumes this SDK

## Caller responsibilities

This SDK can hold and sign with secret keys. Callers must:

- **Prefer the handle-based crypto API.** Functions like `generateKeypairHandle()` keep the FALCON-512 secret key inside the WASM heap and return only an opaque `u32` handle. Hex-string variants of the same functions return the secret as a JS string, which is reachable from browser dev tools, browser extensions with content-script access, process crash dumps, and accidental logging. Use the hex variant only when you must (e.g., encrypting the key to disk via the keystore), and discard the value at the earliest opportunity.
- **Never log secret material.** Do not pass `secretKey`, keystore plaintext, or signing-key handles into general-purpose logger functions. The SDK does not emit secrets in its own error messages; user code must hold the same discipline.
- **Use HTTPS / WSS in production.** The SDK does not refuse plaintext transports because development uses them; in any deployment, callers should pass `https://` and `wss://` endpoints and validate that the connection has not been downgraded.
- **Pin dependency versions.** Treat `pyde-ts-sdk` like any cryptographic dependency: pin exact versions in production, use `npm audit` in CI, and review changelogs before upgrading.

## Cryptographic primitives

The SDK does not implement primitives — every signature, encryption, hash, and KDF is delegated to [`pyde-crypto-wasm`](https://github.com/pyde-net/pyde-crypto-wasm), which is a wasm-bindgen wrapper around the same Rust crate the Pyde node uses. The primitives are:

- **FALCON-512** — post-quantum signatures (NIST PQC final-round)
- **Poseidon2** — ZK-friendly hash, used for address derivation and the JMT state tree
- **Blake3** — fast hash, used in parallel with Poseidon2 for ZK-light-client verification, and for the commit-reveal MEV-protection commitment (Blake3 commitment)

## Keystore format

The encrypted keystore mirrors the format used by `pyde keys generate` (per Pyde Book Chapter 17):

- **KDF:** Argon2id, default parameters tuned for ~250 ms on a modern laptop CPU
- **AEAD:** AES-256-GCM over the encoded secret key (ChaCha20-Poly1305 accepted on read for keystores written by pyde-ts-sdk ≤ 0.2.x)
- **At-rest layout:** the canonical multi-account envelope — `{ version: 1, accounts: { <name>: { address, pubkey, ciphertext, salt, nonce, cipher?, kdf: { name, memory_kb, iterations, parallelism } } } }`, all binary fields `0x`-prefixed hex, the AEAD tag appended to `ciphertext`. Byte-identical to `otigen wallet` and the playground, so one file opens across the whole ecosystem.

Parameters are documented in the keystore module's TSDoc and surfaced in errors when a keystore fails to decrypt.

## Supported versions

Pre-v1.0: only the latest minor receives security fixes.

After v1.0: the current major and the previous major receive fixes for one year following the next major's release.
