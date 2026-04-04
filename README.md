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
  - [Multi-Arg Calls](#multi-arg-calls)
  - [ABI-Aware Reads](#abi-aware-reads)
  - [Decoding Return Values](#decoding-return-values)
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
import { Provider, Wallet, ContractCall } from "pyde-ts-sdk";

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

// 5. Call a contract
const data = new ContractCall("get_count").build();
const result = await provider.call(contractAddress, data);
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

Execute a contract function without creating a transaction. No gas is consumed. Used for read-only queries.

```typescript
// Build calldata (selector + args)
const data = new ContractCall("get_count").build();

// Execute static call
const resultHex = await provider.call("0xcontract...", data);
```

### Gas Estimation

Estimate how much gas a transaction will consume.

```typescript
const data = new ContractCall("deposit").argU64(500).build();
const estimatedGas = await provider.estimateGas("0xcontract...", data);
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
const receipt = await wallet.transfer(
  provider,
  "0xrecipient...",  // to address
  1000000n           // amount in quanta
);

console.log("Success:", receipt.success);
console.log("Gas Used:", receipt.gasUsed);
console.log("Fee Paid:", receipt.feePaid);
```

### Calling a Contract Function

Send a state-changing transaction to a deployed contract.

```typescript
// Build calldata
const data = new ContractCall("deposit").argU64(500).build();

// Sign, send, and wait for receipt
const receipt = await wallet.sendCall(
  provider,
  "0xcontract...",   // contract address
  data,              // calldata
  100_000_000        // gas limit (optional, defaults to 100M)
);
```

### Deploying a Contract

```typescript
const receipt = await wallet.deploy(
  provider,
  "0xdeploybytecode...",  // constructor + runtime bytecode
  100_000_000             // gas limit
);

// Contract address is in the receipt's returnData
console.log("Deployed at:", receipt.returnData);
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

### Building Calldata

Use `ContractCall` to encode function selectors and arguments.

```typescript
import { ContractCall } from "pyde-ts-sdk";

// Function with no args
const data = new ContractCall("increment").build();

// Function with a u64 arg
const data = new ContractCall("deposit").argU64(500).build();

// Function with a boolean arg
const data = new ContractCall("set_active").argBool(true).build();

// Function with an address arg
const data = new ContractCall("set_owner")
  .argAddress("0xaabb...")
  .build();

// Function with a string arg
const data = new ContractCall("set_name")
  .argString("hello")
  .build();
```

### Multi-Arg Calls

Chain multiple arguments in order.

```typescript
const data = new ContractCall("set_all")
  .argString("hello")    // String
  .argU64(42)             // u64
  .argBool(true)          // bool
  .argAddress("0xaa...")  // Address
  .build();
```

### ABI-Aware Reads

Register function return types for auto-decoded reads.

```typescript
import { Contract } from "pyde-ts-sdk";

const contract = new Contract("0xcontract...", provider);
contract.addFunction("get_count", "u64");
contract.addFunction("get_name", "String");
contract.addFunction("is_active", "bool");
contract.addFunction("get_owner", "Address");

// Returns the correct TypeScript type automatically
const count = await contract.read("get_count");   // bigint (42n)
const name = await contract.read("get_name");     // string ("hello")
const active = await contract.read("is_active");  // boolean (true)
const owner = await contract.read("get_owner");   // string ("0xaa...")
```

### Decoding Return Values

Manual decoders for raw hex return data.

```typescript
import { decodeU64, decodeBool, decodeString, decodeAddress } from "pyde-ts-sdk";

const count = decodeU64("0x2a00000000000000");                    // 42n
const flag = decodeBool("0x0100000000000000");                     // true
const name = decodeString("0x050000000000000068656c6c6f");         // "hello"
const addr = decodeAddress("0x" + "aa".repeat(32));                // "0xaaaa..."
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
import { generateKeypair } from "pyde-ts-sdk";

const keypair = generateKeypair();
// {
//   publicKey: "0x..." (897 bytes, FALCON-512 public key),
//   secretKey: "0x..." (1281 bytes, FALCON-512 secret key),
//   address: "0x..."   (32 bytes, Poseidon2 hash of public key)
// }
```

### Signing & Verification

```typescript
import { signMessage, verifySignature } from "pyde-ts-sdk";

const signature = signMessage(secretKeyHex, messageHex);
const isValid = verifySignature(publicKeyHex, messageHex, signature);
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
    └── sdk.test.ts    — 17 unit tests
```

All cryptographic operations are compiled from Rust to WebAssembly, guaranteeing exact compatibility with the Pyde node:
- **FALCON-512** — post-quantum lattice-based signatures
- **Poseidon2** — ZK-friendly algebraic hash (tx hashing, address derivation)
- **AES-256-GCM** — quantum-resistant symmetric encryption (via Rust SDK keystore)
