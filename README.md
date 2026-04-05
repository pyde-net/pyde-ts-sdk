# pyde-ts-sdk

TypeScript SDK for interacting with the Pyde blockchain. Post-quantum secure via WASM-compiled FALCON-512 cryptography.

---

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Provider](#provider)
  - [Connecting to a Node](#connecting-to-a-node)
  - [Chain Queries](#chain-queries)
  - [Account Queries](#account-queries)
  - [Block Queries](#block-queries)
  - [Static Calls](#static-calls)
  - [Gas Estimation](#gas-estimation)
- [Wallet](#wallet)
  - [Creating a Wallet](#creating-a-wallet)
  - [Restoring a Wallet](#restoring-a-wallet)
  - [Encrypted Keystore](#encrypted-keystore)
  - [Exporting Keys](#exporting-keys)
  - [Signing Messages](#signing-messages)
- [Transactions](#transactions)
  - [Sending a Transfer](#sending-a-transfer)
  - [Calling a Contract Function](#calling-a-contract-function)
  - [Deploying a Contract](#deploying-a-contract)
  - [Raw Transaction Submission](#raw-transaction-submission)
  - [Waiting for Receipts](#waiting-for-receipts)
- [Contract Interaction](#contract-interaction)
  - [Building Calldata](#building-calldata)
  - [Wide Types (u128, u256)](#wide-types-u128-u256)
  - [Multi-Arg Calls](#multi-arg-calls)
  - [Vectors](#vectors)
  - [Structs & Tuples](#structs--tuples)
  - [Nested Types](#nested-types)
  - [ABI-Aware Contract (fromArtifact + connect)](#abi-aware-contract-fromartifact--connect)
  - [Arg Validation (before broadcast)](#arg-validation-before-broadcast)
  - [Decoding Return Values](#decoding-return-values)
  - [DeployData Builder](#deploydata-builder)
  - [Receipt Utilities](#receipt-utilities)
- [Events & Logs](#events--logs)
- [Error Handling](#error-handling)
- [Cryptographic Primitives](#cryptographic-primitives)
  - [Key Generation](#key-generation)
  - [Signing & Verification](#signing--verification)
  - [Hashing](#hashing)
  - [Function Selectors](#function-selectors)
- [Architecture](#architecture)

---

## Installation

```bash
npm install pyde-ts-sdk
```

---

## Getting Started

```typescript
import { Provider, Wallet, Contract } from "pyde-ts-sdk";

// 1. Connect to a node
const provider = new Provider("http://127.0.0.1:8545");

// 2. Create a wallet
const wallet = Wallet.generate();
console.log("My address:", wallet.address);

// 3. Check balance
const balance = await provider.getBalance(wallet.address);
console.log("Balance:", balance, "quanta");

// 4. Send a transfer
const receipt = await wallet.transfer(provider, recipientAddress, 1000000n);
console.log("Tx:", receipt.txHash, "Success:", receipt.success);

// 5. Interact with a contract (load ABI from build artifact)
const contract = Contract.fromArtifact("out/Counter.json", contractAddress, provider)
  .connect(wallet);
const count = await contract.read("get_count");
await contract.write("increment", {});
```

---

## Provider

### Connecting to a Node

```typescript
const provider = new Provider("http://127.0.0.1:8545");
```

The provider handles all JSON-RPC communication with the Pyde node. All methods are async and return promises.

### Chain Queries

```typescript
// Current block number (slot)
const block = await provider.getBlockNumber();

// Chain ID (for replay protection)
const chainId = await provider.getChainId();

// Current base fee (in quanta per gas unit)
const gasPrice = await provider.getGasPrice();
```

### Account Queries

```typescript
// Native token balance (in quanta — 1 PYDE = 10^9 quanta)
const balance = await provider.getBalance("0xaabb...");

// Transaction nonce (for building the next tx)
const nonce = await provider.getNonce("0xaabb...");

// Contract bytecode (empty string if EOA)
const code = await provider.getCode("0xcontract...");

// Storage slot value
const storage = await provider.getStorageAt("0xcontract...", 0);
```

### Block Queries

```typescript
const block = await provider.getBlockByNumber(42);
if (block) {
  console.log("Slot:", block.slot);
  console.log("Timestamp:", block.timestamp);
  console.log("Proposer:", block.proposer);
}
```

### Static Calls

Execute a contract function without creating a transaction. No gas is consumed.

```typescript
// Using Contract (recommended)
const contract = Contract.fromArtifact("out/Counter.json", addr, provider);
const count = await contract.read("get_count");

// Low-level (manual calldata)
const resultHex = await provider.call("0xcontract...", "0xcalldata...");
```

### Gas Estimation

Estimate how much gas a transaction will consume.

```typescript
const estimatedGas = await provider.estimateGas("0xcontract...", "0xcalldata...");
console.log("Estimated gas:", estimatedGas);
```

---

## Wallet

### Creating a Wallet

```typescript
// Generate a brand new FALCON-512 keypair
const wallet = Wallet.generate();

console.log("Address:", wallet.address);       // 0x...
console.log("Public Key:", wallet.publicKey);   // 0x... (897 bytes)
```

### Restoring a Wallet

```typescript
// From combined private key (pk + sk hex, 2178 bytes)
const wallet = Wallet.fromPrivateKey("0xabcdef...");

// From individual key components
const wallet = Wallet.fromKeys(publicKeyHex, secretKeyHex);

// From encrypted keystore file
const wallet = Wallet.fromKeystore("~/.pyde/wallets/my-wallet.json", "my-password");

// From encrypted keystore object (already in memory)
const wallet = Wallet.fromEncrypted(keystoreObj, "my-password");
```

### Encrypted Keystore

Wallets can be encrypted with AES-256-GCM and saved to disk. The encryption key is
derived via Poseidon2(password || salt), matching the Rust SDK's keystore format exactly.

```typescript
// Generate a new wallet and save encrypted to disk
const wallet = Wallet.createEncrypted("/path/to/wallet.json", "strong-password");
// File is chmod 600 on Unix

// Export an existing wallet as encrypted keystore
const keystore = wallet.toKeystore("strong-password");
// Returns { address, public_key, encrypted_secret_key, salt, nonce, version }

// Save keystore to a specific file
wallet.saveKeystore("/path/to/backup.json", "strong-password");

// Load from file
const restored = Wallet.fromKeystore("/path/to/wallet.json", "strong-password");
console.log(restored.address === wallet.address); // true

// Load from in-memory keystore object
const restored2 = Wallet.fromEncrypted(keystore, "strong-password");

// Wrong password → throws
Wallet.fromEncrypted(keystore, "wrong");
// Error: decryption failed — wrong password?
```

### Exporting Keys

```typescript
// Export combined private key for backup
const privateKey = wallet.exportPrivateKey();  // "0x..." (pk+sk, 2178 bytes)

// Store it safely, restore later with:
const restored = Wallet.fromPrivateKey(privateKey);
```

### Signing Messages

```typescript
// Sign any 32-byte message hash
const signature = wallet.sign("0x" + "ab".repeat(32));

// Sign a transaction (returns wire-encoded signed tx hex)
const signedTxHex = wallet.signTransaction({
  from: wallet.address,
  to: "0xrecipient...",
  value: 1000,
  data: "0x",
  gasLimit: 21000,
  nonce: 0,
  chainId: 31337,
  txType: 0,
});
```

---

## Transactions

### Sending a Transfer

The simplest transaction — send native tokens from one address to another.

```typescript
import { ReceiptUtils } from "pyde-ts-sdk";

const receipt = await wallet.transfer(
  provider,
  "0xrecipient...",  // to address
  1000000n           // amount in quanta
);

console.log("Success:", receipt.success);
console.log("Gas Used:", ReceiptUtils.gas(receipt));     // parsed number
console.log("Fee Paid:", receipt.feePaid);                // hex string
```

### Calling a Contract Function

Send a state-changing transaction to a deployed contract.

```typescript
// Using Contract (recommended — validates args against ABI)
const contract = Contract.fromArtifact("out/Contract.json", addr, provider)
  .connect(wallet);
const receipt = await contract.write("deposit", { amount: 500 });

// Low-level (manual calldata + wallet)
const data = new ContractCall("deposit").argU64(500).build();
const receipt2 = await wallet.sendCall(provider, "0xcontract...", data);
```

### Deploying a Contract

```typescript
import { DeployData, ReceiptUtils } from "pyde-ts-sdk";

// Build deploy payload (with constructor args)
const deployData = new DeployData(constructorHex, runtimeHex)
  .argU64(1000)
  .build();

const receipt = await wallet.deploy(
  provider,
  deployData,
  100_000_000  // gas limit (optional, defaults to 100M)
);

// Extract contract address from receipt
const contractAddr = ReceiptUtils.contractAddress(receipt);
console.log("Deployed at:", contractAddr);
```

### Raw Transaction Submission

For full control over the transaction lifecycle.

```typescript
// 1. Build transaction fields
const tx = {
  from: wallet.address,
  to: "0xrecipient...",
  value: "1000",
  data: "0x",
  gasLimit: 21000,
  nonce: await provider.getNonce(wallet.address),
  chainId: await provider.getChainId(),
  txType: 0,
};

// 2. Sign (returns wire-encoded hex)
const signedHex = wallet.signTransaction(tx);

// 3. Send
const txHash = await provider.sendRawTransaction(signedHex);

// 4. Wait for confirmation
const receipt = await provider.waitForReceipt(txHash, 10000);
```

### Waiting for Receipts

```typescript
// Poll until receipt is available (with timeout)
const receipt = await provider.waitForReceipt(txHash, 10000); // 10s timeout

// Or send + wait in one call (throws on revert)
const receipt = await provider.sendAndWait(signedTxHex, 10000);
```

---

## Contract Interaction

> **Recommended**: Use `Contract.fromArtifact()` with `.read()` / `.write()` for ABI-aware
> interaction with validation. The `ContractCall` builder below is for low-level / dynamic use
> when you don't have an artifact.

### Low-Level Calldata Builder

Use `ContractCall` when you need manual control over calldata encoding.

```typescript
import { ContractCall } from "pyde-ts-sdk";

// No args
new ContractCall("increment").build();

// GP types (8 bytes)
new ContractCall("set_u8").argU8(255).build();
new ContractCall("set_u16").argU16(1000).build();
new ContractCall("set_u32").argU32(100000).build();
new ContractCall("set_u64").argU64(42).build();
new ContractCall("set_i64").argI64(-1).build();
new ContractCall("set_active").argBool(true).build();

// Address (32 bytes)
new ContractCall("set_owner").argAddress("0xaabb...").build();

// String (length-prefixed, 8-byte aligned)
new ContractCall("set_name").argString("hello").build();
```

### Wide Types (u128, u256)

```typescript
// u128 / i128 (16 bytes)
new ContractCall("set_amount").argU128(1000000000000n).build();
new ContractCall("set_signed").argI128(-500n).build();

// u256 / i256 (32 bytes)
new ContractCall("set_big").argU256(99n).build();
new ContractCall("set_signed_big").argI256(-1n).build();
```

### Multi-Arg Calls

Chain multiple arguments in order.

```typescript
new ContractCall("set_all")
  .argString("hello")    // String
  .argU64(42)             // u64
  .argBool(true)          // bool
  .argU256(99n)           // u256
  .argAddress("0xaa...")  // Address
  .build();
```

### Vectors

```typescript
// Vec<u64>
new ContractCall("set_scores").argVecU64([100, 200, 300]).build();

// Vec<bool>
new ContractCall("set_flags").argVecBool([true, false, true]).build();

// Vec<Address>
new ContractCall("set_addrs").argVecAddress(["0xaa...", "0xbb..."]).build();

// Vec<String> — use argVecOf for any element type
new ContractCall("set_names")
  .argVecOf(3, b => b
    .argString("alice")
    .argString("bob")
    .argString("charlie"))
  .build();

// Vec<u256>
new ContractCall("set_bigs")
  .argVecOf(2, b => b.argU256(100n).argU256(200n))
  .build();
```

### Structs & Tuples

```typescript
// Struct: [byte_len:8][fields...]
new ContractCall("set_user")
  .argStruct(s => s
    .argString("alice")
    .argU64(25)
    .argBool(true))
  .build();

// Tuple: sequential fields, no length prefix
new ContractCall("set_pair")
  .argTuple(t => t.argU64(1).argString("one"))
  .build();
```

### Nested Types

`argVecOf` and `argStruct` are composable — nest them arbitrarily.

```typescript
// Vec<Struct>
new ContractCall("set_users")
  .argVecOf(2, b => b
    .argStruct(s => s.argString("alice").argU64(25))
    .argStruct(s => s.argString("bob").argU64(30)))
  .build();

// Vec<Vec<u64>>
new ContractCall("set_matrix")
  .argVecOf(2, b => b
    .argVecU64([1, 2, 3])
    .argVecU64([4, 5, 6]))
  .build();

// Vec<Tuple>
new ContractCall("set_pairs")
  .argVecOf(2, b => b
    .argTuple(t => t.argU64(1).argString("one"))
    .argTuple(t => t.argU64(2).argString("two")))
  .build();

// Struct containing Vec
new ContractCall("set_team")
  .argStruct(s => s
    .argString("Team Alpha")
    .argVecOf(3, b => b
      .argString("alice")
      .argString("bob")
      .argString("charlie")))
  .build();
```

### ABI-Aware Contract (fromArtifact + connect)

The recommended way to interact with contracts — loads the full ABI including
struct/enum definitions, validates args before broadcast, auto-encodes and decodes.

```typescript
import { Contract } from "pyde-ts-sdk";

// Load from build artifact (gets all functions, structs, enums)
const contract = Contract.fromArtifact("out/MyContract.json", addr, provider)
  .connect(wallet);

// Read — auto-decoded return value
const count = await contract.read("get_count");           // bigint
const user = await contract.read("get_user");             // { name: "alice", age: 25n, active: true }
const scores = await contract.read("get_scores");         // [100n, 200n, 300n]
const status = await contract.read("get_status");         // "Active" (enum variant name)

// Write — validated, encoded, signed, sent, waited
await contract.write("deposit", { amount: 500 });
await contract.write("set_user", { user: { name: "alice", age: 25, active: true } });
await contract.write("set_status", { status: "Active" });
await contract.write("set_scores", { scores: [100, 200, 300] });
```

### Arg Validation (before broadcast)

Args are validated against the ABI before any transaction is sent:

```typescript
// Missing param → error
await contract.write("deposit", {});
// Error: deposit(): missing required param 'amount' (u64)

// Wrong type → error
await contract.write("deposit", { amount: "hello" });
// Error: deposit().amount: expected u64, got string

// Out of range → error
await contract.write("deposit", { amount: -1 });
// Error: deposit().amount: value -1 out of range for u64 (0 to 18446744073709551615)

// Missing struct field → error
await contract.write("set_user", { user: { name: "alice" } });
// Error: set_user().user: missing field 'age' for struct UserInfo

// Unknown enum variant → error
await contract.write("set_status", { status: "Unknown" });
// Error: set_status().status: unknown variant 'Unknown' for enum Status. Valid: Active, Inactive, Banned

// Write without connect() → error
const readOnly = Contract.fromArtifact("out/Contract.json", addr, provider);
await readOnly.write("deposit", { amount: 500 });
// Error: No wallet connected. Use contract.connect(wallet) first.
```

### Decoding Return Values

Manual decoders for raw hex return data (low-level alternative to Contract.read).

```typescript
import {
  decodeU64, decodeI64, decodeU128, decodeI128,
  decodeU256, decodeI256, decodeBool, decodeAddress,
  decodeString, decodeBytes,
} from "pyde-ts-sdk";

// GP integers
const count = decodeU64("0x2a00000000000000");                    // 42n
const neg   = decodeI64("0x" + "ff".repeat(8));                    // -1n

// Wide integers
const big   = decodeU128("0x0100000000000000" + "00".repeat(8));  // 1n
const sneg  = decodeI128("0x" + "ff".repeat(16));                  // -1n
const huge  = decodeU256("0x0100000000000000" + "00".repeat(24)); // 1n
const shuge = decodeI256("0x" + "ff".repeat(32));                  // -1n

// Other types
const flag  = decodeBool("0x0100000000000000");                    // true
const name  = decodeString("0x050000000000000068656c6c6f");        // "hello"
const addr  = decodeAddress("0x" + "aa".repeat(32));               // "0xaaaa..."
const raw   = decodeBytes("0x0300000000000000aabbcc");             // Buffer<aabbcc>
```

### DeployData Builder

Build properly formatted deploy transaction payloads.

```typescript
import { DeployData } from "pyde-ts-sdk";

// No constructor args
const simple = new DeployData(constructorHex, runtimeHex).build();

// With constructor args
const withArgs = new DeployData(constructorHex, runtimeHex)
  .argU64(1000)         // initial supply
  .argString("MyToken") // name
  .argBool(true)        // mintable
  .build();

// Format: [clen:4 LE][rlen:4 LE][constructor][runtime][args]
```

### Receipt Utilities

Helper functions for parsing receipt fields.

```typescript
import { ReceiptUtils } from "pyde-ts-sdk";

// Parse gas used from hex string to number
const gas = ReceiptUtils.gas(receipt);

// Extract contract address from deploy receipt
const addr = ReceiptUtils.contractAddress(receipt); // string | null

// Get raw return data as hex
const hex = ReceiptUtils.returnHex(receipt); // "0x..." or "0x"
```

---

## Events & Logs

Query event logs from the chain with optional topic filtering.

### Basic — filter by contract and block range

```typescript
const logs = await provider.getLogs({
  fromBlock: 0,
  toBlock: 100,
  address: "0xcontract...",
});

for (const log of logs) {
  console.log("Contract:", log.address);
  console.log("Topics:", log.topics);
  console.log("Data:", log.data);
}
```

### Filter by event signature (topic[0])

```typescript
import { poseidon2Hash } from "pyde-ts-sdk";

// Event signature hash (same as how the compiler indexes events)
const transferSig = poseidon2Hash("0x" + Buffer.from("Transfer").toString("hex"));

const logs = await provider.getLogs({
  fromBlock: 0,
  toBlock: 1000,
  topics: [transferSig],  // only Transfer events
});
```

### Filter by indexed parameters

```typescript
// Transfer events TO a specific address
const logs = await provider.getLogs({
  address: "0xtoken...",
  topics: [
    transferSig,     // topic[0] = event signature
    null,            // topic[1] = from (any)
    recipientAddr,   // topic[2] = to (specific address)
  ],
});
```

### OR matching on a topic position

```typescript
// Transfer events FROM alice OR bob
const logs = await provider.getLogs({
  topics: [
    transferSig,
    [aliceAddr, bobAddr],  // topic[1] = alice OR bob
  ],
});
```

---

## Error Handling

All async methods throw standard JavaScript errors with descriptive messages.

```typescript
try {
  const receipt = await wallet.transfer(provider, to, amount);
  console.log("Success! Gas:", receipt.gasUsed);
} catch (error) {
  const msg = (error as Error).message;

  if (msg.includes("reverted")) {
    // Transaction executed but reverted (e.g., require! failed)
    console.log("Transaction reverted");
  } else if (msg.includes("Connection")) {
    // Can't reach the node
    console.log("Node unreachable");
  } else if (msg.includes("Receipt not available")) {
    // Timeout waiting for block confirmation
    console.log("Timeout — tx may still be pending");
  } else if (msg.includes("RPC error")) {
    // Node returned an error (invalid params, etc.)
    console.log("RPC error:", msg);
  } else {
    console.log("Unexpected error:", msg);
  }
}
```

---

## Cryptographic Primitives

Direct access to the WASM-compiled crypto layer.

### Key Generation

```typescript
import { generateKeypair, deriveAddress } from "pyde-ts-sdk";

const keypair = generateKeypair();
// {
//   publicKey: "0x..." (897 bytes, FALCON-512 public key),
//   secretKey: "0x..." (1281 bytes, FALCON-512 secret key),
//   address: "0x..."   (32 bytes, Poseidon2 hash of public key)
// }

// Derive address from a public key
const address = deriveAddress(keypair.publicKey);  // "0x..." (32 bytes)
```

### Signing & Verification

```typescript
import { signMessage, verifySignature } from "pyde-ts-sdk";

const signature = signMessage(secretKeyHex, messageHex);
const isValid = verifySignature(publicKeyHex, messageHex, signature);
```

### Transaction Hashing & Signing

```typescript
import { hashTransaction, signTransaction } from "pyde-ts-sdk";

// Compute transaction hash without signing
const txHash = hashTransaction({
  from: wallet.address,
  to: "0xrecipient...",
  value: 1000,
  data: "0x",
  gasLimit: 21000,
  nonce: 0,
  chainId: 31337,
  txType: 0,
});

// Sign a transaction — returns wire-encoded signed tx hex
const signedTxHex = signTransaction(txFields, secretKeyHex);
```

### Hashing

```typescript
import { poseidon2Hash } from "pyde-ts-sdk";

const hash = poseidon2Hash("0xdeadbeef");  // "0x..." (32 bytes)
```

### Function Selectors

```typescript
import { computeSelector } from "pyde-ts-sdk";

const selector = computeSelector("get_count");   // 0xd9e32bf7
const selector2 = computeSelector("increment");  // 0x3812e73e
```

---

## Architecture

```
pyde-ts-sdk/
├── src/
│   ├── index.ts       — re-exports
│   ├── provider.ts    — RPC client (fetch-based, async)
│   ├── wallet.ts      — FALCON-512 key management + signing
│   ├── contract.ts    — calldata encoding + ABI-aware reads
│   ├── crypto.ts      — WASM bridge wrapper
│   └── types.ts       — Receipt, Log, TxFields, etc.
├── wasm/              — compiled Rust → WASM (FALCON-512, Poseidon2)
└── tests/
    └── sdk.test.ts    — 50 unit tests
```

All cryptographic operations are compiled from Rust to WebAssembly, guaranteeing exact compatibility with the Pyde node:
- **FALCON-512** — post-quantum lattice-based signatures (WASM)
- **Poseidon2** — ZK-friendly algebraic hash for tx hashing, address derivation, key derivation (WASM)
- **AES-256-GCM** — quantum-resistant symmetric encryption for keystore (Node.js `crypto` module, Poseidon2 for KDF)
