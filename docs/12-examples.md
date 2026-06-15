# 12 — Examples / recipes

Working snippets for the common dapp shapes. Every snippet copy-pastes.

[← TOC](./README.md)

## 1. Read a balance

```ts
import { Provider, formatQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const balance = await provider.getBalance("0xaddr...");
console.log(formatQuanta(balance), "PYDE");
```

## 2. Send a native transfer

```ts
import { Provider, Wallet, parseQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const wallet = Wallet.generate();
wallet.connect(provider);

await wallet.registerPubkey(); // once per address

const receipt = await wallet.transfer("0xrecipient...", parseQuanta("1.5"));
console.log(receipt.success ? "ok" : "reverted");

wallet.destroy();
```

## 3. Load a wallet from disk (Node)

```ts
import { Wallet } from "pyde-ts-sdk";

const wallet = await Wallet.fromKeystoreFile("/keys/alice.json", process.env.WALLET_PASSPHRASE!);

// Use the wallet
await wallet.transfer(/* … */);

// Wipe SK
wallet.destroy();
```

## 4. Generate a wallet + save to disk

```ts
import { Wallet } from "pyde-ts-sdk";

const wallet = Wallet.generateUnsafe(); // hex SK — required for keystore export
await wallet.saveKeystoreFile("/keys/alice.json", "strong-passphrase");
wallet.destroy();
```

The file is written with mode `0600` on POSIX.

## 5. Deploy a contract (via `otigen`)

```bash
# Build the contract (Rust example)
cd my-contract && otigen build

# Import devnet prefunded keys (once)
echo "test-pw" | otigen wallet import --from-devnet --password-stdin

# Deploy
echo "test-pw" | otigen deploy \
  --bundle ./artifacts/my-contract.bundle \
  --from devnet-0 \
  --password-stdin \
  --network devnet \
  --json
# → emits NDJSON; last line carries `contract_address`
```

## 6. Read a view function

```ts
import { Provider, Contract } from "pyde-ts-sdk";

const provider = new Provider("http://127.0.0.1:9933", { allowInsecureTransport: true });
const counter = await Contract.fromArtifact(
  "./artifacts/counter.bundle/abi.json",
  "0xcontract...",
  provider,
);

const count = await counter.read("get_count"); // bigint
```

## 7. Send a contract write

```ts
const writable = counter.connect(wallet);
const receipt = await writable.write("increment");

if (!receipt.success) {
  throw new Error("reverted");
}
```

Or with args + value:

```ts
const receipt = await writable.write(
  "deposit",
  { amount: 500n },
  { value: 500n }, // pays 500 quanta along with the call
);
```

## 8. Decode a return struct

If the contract has:

```rust
struct Position {
    owner: Address,
    size: u128,
    open: bool,
}

#[pyde::entry]
fn get_position(id: u64) -> Position { /* … */ }
```

```ts
const position = await market.read("get_position", { id: 42n });
console.log(position);
// { owner: "0x...", size: 1234567890000000n, open: true }
```

The borsh codec handles nested structs, `Vec<T>`, `Option<T>`, enums, and tuples — see [Chapter 04 → supported types](./04-contract.md#the-borsh-codec--supported-types).

## 9. Query past events

```ts
const transfers = await token.queryFilter(
  "Transfer",
  1_000n,
  2_000n, // toWave - fromWave ≤ 5,000
);

for (const ev of transfers) {
  console.log(
    `wave=${ev.log.waveId} tx=${ev.log.txIndex} ` +
      `from=${ev.args.from} to=${ev.args.to} amount=${ev.args.amount}`,
  );
}
```

## 10. Live event subscription

```ts
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("wss://rpc.pyde.network");

const transferTopic = token.getEventTopic("Transfer");
const unsub = await ws.subscribeLogs(
  { topics: [[transferTopic]], contract: token.address },
  (log) => {
    const ev = token.parseLog(log);
    if (ev) console.log(ev.name, ev.args);
  },
);

// later: await unsub(); ws.destroy();
```

## 11. Event indexer (paged backfill + live tail)

```ts
import { Provider, WebSocketProvider, Contract } from "pyde-ts-sdk";

const provider = new Provider(rpc);
const ws = new WebSocketProvider(wsUrl);
const token = await Contract.fromArtifact(abi, addr, provider);
const transferTopic = token.getEventTopic("Transfer");

// 1) Backfill in 5000-wave pages.
const head = await provider.getWave(); // returns "latest" head if engine supports it
const head_id = head!.waveId;
let cursor = 0n;
while (cursor < head_id) {
  const page = await provider.getLogs({
    contract: addr,
    topics: [[transferTopic]],
    fromWave: cursor,
    toWave: cursor + 5000n > head_id ? head_id : cursor + 5000n,
  });
  for (const log of page.events) {
    const ev = token.parseLog(log);
    if (ev) await index(ev);
  }
  cursor += 5000n + 1n;
}

// 2) Live tail.
await ws.subscribeLogs({ contract: addr, topics: [[transferTopic]] }, async (log) => {
  const ev = token.parseLog(log);
  if (ev) await index(ev);
});

async function index(ev: import("pyde-ts-sdk").EventLog) {
  // upsert into your DB, keyed by (waveId, txIndex, eventIndex)
}
```

## 12. React dapp skeleton

```tsx
import { PydeProvider, useBalance, useLiveWave, usePydeSigner } from "pyde-ts-sdk/react";
import { Wallet, formatPyde } from "pyde-ts-sdk";
import { useEffect, useState } from "react";

function App() {
  const [signer, setSigner] = useState<Wallet | null>(null);

  useEffect(() => {
    const w = Wallet.generate();
    setSigner(w);
    return () => w.destroy();
  }, []);

  if (!signer) return <p>loading…</p>;

  return (
    <PydeProvider rpcUrl="https://rpc.pyde.network" wsUrl="wss://rpc.pyde.network" signer={signer}>
      <Dapp />
    </PydeProvider>
  );
}

function Dapp() {
  const signer = usePydeSigner();
  const { data: balance } = useBalance(signer?.address);
  const wave = useLiveWave();

  return (
    <>
      <p>address: {signer?.address}</p>
      <p>balance: {balance != null && formatPyde(balance)} PYDE</p>
      <p>wave: {wave?.waveId.toString()}</p>
    </>
  );
}
```

## 13. Browser-injected wallet

```ts
import { BrowserWalletAdapter } from "pyde-ts-sdk";

const adapter = new BrowserWalletAdapter();
try {
  await adapter.connect(); // wallet UI pops here
} catch (e) {
  console.warn("user cancelled");
  return;
}

adapter.on("addressChange", () => location.reload());

await adapter.sendTransaction(tx, provider);
```

See [Chapter 07](./07-wallet-adapters.md) for the full adapter contract.

## 14. Encrypted (MEV-protected) send

```ts
import { Provider, Wallet, parseQuanta } from "pyde-ts-sdk";

const provider = new Provider("https://rpc.pyde.network");
const wallet = Wallet.generateUnsafe(); // hex SK required
wallet.connect(provider);
await wallet.registerPubkey();

const receipt = await wallet.transferEncrypted("0xrecipient...", parseQuanta("1"), {
  deadline: 999_999n,
});
```

See [Chapter 09](./09-encrypted-mempool.md).

## 15. Batch RPC

```ts
const random = "0x" + "12".repeat(32);
const [chainId, balance, nonce] = await provider.batch([
  { method: "pyde_chainId", params: [] },
  { method: "pyde_getBalance", params: [random] },
  { method: "pyde_getTransactionCount", params: [random] },
]);

console.log(BigInt(balance as string)); // 0n
```

One round-trip; results returned in request order; raw `unknown` (caller post-processes).

## 16. Type-safe contract bindings

```bash
npx pyde-tsgen ./artifacts/counter.bundle/abi.json ./types/counter.d.ts --name Counter
```

```ts
import { Contract } from "pyde-ts-sdk";
import type { CounterAbi } from "./types/counter";

const counter = await Contract.fromArtifact<CounterAbi>(abi, addr, provider);

await counter.read("get_count"); // ✅ → Promise<bigint>
await counter.read("getCount"); // ❌ type error
await counter.write("deposit", { arg0: 5n }); // ✅
```

See [Chapter 05](./05-codegen.md).
