# Examples

Runnable examples for `pyde-ts-sdk`. Each file is self-contained and includes a header explaining what it does + how to run it.

| File                  | What it shows                                                              |
| --------------------- | -------------------------------------------------------------------------- |
| `01-read-balance.ts`  | HTTP `Provider` — read balance, nonce, account record.                     |
| `02-send-transfer.ts` | `Wallet` — generate, register pubkey, send native transfer.                |
| `03-event-indexer.ts` | `WebSocketProvider` — live event subscription with at-least-once delivery. |

## Running

```bash
# In one terminal, run a local devnet (see Pyde Book for setup):
pyde devnet

# In another, run any example via tsx:
npx tsx examples/01-read-balance.ts 0x...
```

Examples default to `http://127.0.0.1:8545` (HTTP) and `ws://127.0.0.1:8546` (WS). Override with `PYDE_RPC_URL` / `PYDE_WS_URL` env vars.
