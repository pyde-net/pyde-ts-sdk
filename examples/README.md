# Examples

Runnable examples for `pyde-ts-sdk`. Each file is self-contained and includes a header explaining what it does + how to run it.

| File                   | What it shows                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| `01-read-balance.mjs`  | HTTP `Provider` — read balance, nonce, account record.                      |
| `02-send-transfer.mjs` | `Wallet` — derive devnet-1 from its deterministic seed and send a transfer. |
| `03-event-indexer.mjs` | `WebSocketProvider` — live event subscription with at-least-once delivery.  |

## Running

```bash
# In one terminal, run a local devnet:
otigen devnet --rpc-listen 127.0.0.1:9933 --prefund-count 2

# In another, build the SDK once + run any `.mjs` example:
npm run build
node --experimental-wasm-modules examples/01-read-balance.mjs 0x...
```

The `.mjs` siblings exist because `tsx` can't load the vendored `.wasm` directly (`ERR_UNKNOWN_FILE_EXTENSION '.wasm'` from `pyde_crypto_wasm_bg.wasm`). The `.mjs` files import from `dist/index.js` — a self-contained ESM bundle that Node loads with `--experimental-wasm-modules`. The `.ts` versions are the source-of-truth for reading; `tsx examples/<file>.ts` will fail.

Examples default to `http://127.0.0.1:9933` (HTTP) and `ws://127.0.0.1:9933/ws` (WS) — `otigen devnet`'s actual endpoints. Override with `PYDE_RPC_URL` / `PYDE_WS_URL` env vars.
