# Integration tests

Live end-to-end tests against a local `otigen devnet`. Slower than the unit / property suite and excluded from the default `npm test` run.

## Prerequisites

- `otigen` on `$PATH` (built from the `pyde-net/otigen` workspace via `cargo install --path .` or `make install`)
- `pyde-crypto-wasm` built locally (Phase 2 of the SDK consumes it via a file: path; `make wasm` in that repo produces the ESM-shaped `pkg/`)

## Running

```bash
# Spawns devnet automatically + runs every `*.live.test.ts`
npm run test:integration

# Or attach to a devnet you're already running in another shell:
PYDE_DEVNET_URL=http://127.0.0.1:9933 npm run test:integration
```

The runner is configured for serial execution (one devnet on `127.0.0.1:9933` at a time) with generous per-test timeouts (3 minutes default, 2 minutes for hooks). Per-file timeouts kick in if the devnet hangs.

## File layout

| File                    | What it exercises                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `devnet.ts`             | Devnet lifecycle helper — spawn, wait-for-ready, teardown                                     |
| `fixtures.ts`           | Funded wallet provisioning via `otigen wallet --from-devnet` + transfer                       |
| `provider.live.test.ts` | Every read path on `Provider` (chain id / wave / balance / nonce / account / batch / getLogs) |
| `wallet.live.test.ts`   | End-to-end sign + send — generate, fund, registerPubkey, transfer                             |
| `ws.live.test.ts`       | `WebSocketProvider.subscribeNewHeads` against a live tick                                     |

## What's covered

- ✅ HTTP Provider read surface
- ✅ WebSocket Provider live subscriptions
- ✅ Wallet generate + register + native transfer
- ⏭ Contract deploy + call — coming in a follow-up (needs the storage-stress bundle build wired into setup)
- ✅ Private (commit-reveal) transaction submission — `sendPrivate` end-to-end (phase2.live)
- ⏭ ABI codegen output validation against the storage-stress artifact

## Wallet funding

The devnet's pre-funded accounts are recovered into the otigen keystore by `otigen wallet import --from-devnet`. The funding pattern then uses `otigen wallet transfer` (or falls back to a `Standard` tx via `otigen call` with the zero address) to send PYDE from `devnet-0` to an SDK-generated handle-backed wallet. The SDK then calls `registerPubkey` against the now-funded address and proceeds with the actual test logic.

This indirection through `otigen` (rather than loading the otigen keystore directly) is deliberate — the transfer pattern mirrors how a dapp user actually acquires funds. (Both keystores now use Argon2id + AES-256-GCM, so they're format-compatible; the indirection reflects the funding flow, not a cipher mismatch.)
