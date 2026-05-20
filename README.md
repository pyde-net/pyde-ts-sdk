<p align="center">
  <img src="./assets/logo.png" width="120" alt="Pyde logo" />
</p>

<h1 align="center">pyde-ts-sdk</h1>

<p align="center">
  <em>TypeScript SDK for the Pyde blockchain</em>
</p>

---

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
  - [Transaction Lookup](#transaction-lookup)
  - [Fee Data](#fee-data)
  - [Static Calls](#static-calls)
  - [Gas Estimation](#gas-estimation)
  - [Batch RPC](#batch-rpc)
- [Wallet](#wallet)
  - [Creating a Wallet](#creating-a-wallet)
  - [Restoring a Wallet](#restoring-a-wallet)
  - [Provider Binding](#provider-binding)
  - [Encrypted Keystore](#encrypted-keystore)
  - [Exporting Keys](#exporting-keys)
  - [Validation](#validation)
  - [Signing Messages](#signing-messages)
- [Address Utilities](#address-utilities)
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
  - [Simulating Calls](#simulating-calls)
  - [Gas Estimation](#gas-estimation-1)
  - [Payable Functions](#payable-functions)
  - [Arg Validation (before broadcast)](#arg-validation-before-broadcast)
  - [Decoding Return Values](#decoding-return-values)
  - [Decoding Write Return Data](#decoding-write-return-data)
  - [DeployData Builder](#deploydata-builder)
  - [Receipt Utilities](#receipt-utilities)
  - [Contract Events](#contract-events)
  - [Interface (Standalone ABI)](#interface-standalone-abi)
  - [Populate Transaction](#populate-transaction)
- [WebSocket Provider](#websocket-provider)
- [Abstract Signer](#abstract-signer)
- [Events & Logs](#events--logs)
- [Error Handling](#error-handling)
- [Hex Utilities](#hex-utilities)
- [Unit Formatting](#unit-formatting)
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
const contract = Contract.fromArtifact(
  "out/Counter.json",
  contractAddress,
  provider,
).connect(wallet);
const count = await contract.read("get_count");
await contract.write("increment");
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

### Transaction Lookup

```typescript
const tx = await provider.getTransaction("0xtxhash...");
if (tx) {
  console.log("From:", tx.from);
  console.log("To:", tx.to);
  console.log("Value:", tx.value);
}
```

Note: `returnData` is ephemeral — only available in the receipt immediately after execution, not in transaction lookups.

### Fee Data

Get current network fee info (Pyde uses EIP-1559 with no tips).

```typescript
const fees = await provider.getFeeData();
console.log("Gas price:", fees.gasPrice); // bigint (quanta per gas)
console.log("Base fee:", fees.baseFee); // same as gasPrice in Pyde
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
// Basic
const gas = await provider.estimateGas("0xcontract...", "0xcalldata...");

// With overrides (simulate from a specific sender, with value)
const gas2 = await provider.estimateGas("0xcontract...", "0xcalldata...", {
  from: wallet.address,
  value: 1000000n,
});
```

### Batch RPC

Send multiple calls in a single HTTP request to reduce round trips.

```typescript
const [balance, nonce, chainId] = await provider.batch([
  { method: "pyde_getBalance", params: [addr] },
  { method: "pyde_getTransactionCount", params: [addr] },
  { method: "pyde_chainId", params: [] },
]);
```

The provider also supports configurable timeout, retries, and headers:

```typescript
const provider = new Provider("http://127.0.0.1:8545", {
  timeout: 10000, // 10s timeout (default: 30s)
  retries: 3, // retry 3 times on failure (default: 0)
  headers: { "X-Api-Key": "my-key" },
});
```

---

## Wallet

### Creating a Wallet

```typescript
// Generate a brand new FALCON-512 keypair
const wallet = Wallet.generate();

console.log("Address:", wallet.address); // 0x...
console.log("Public Key:", wallet.publicKey); // 0x... (897 bytes)
```

### Restoring a Wallet

```typescript
// From combined private key (pk + sk hex, 2178 bytes)
const wallet = Wallet.fromPrivateKey("0xabcdef...");

// From individual key components
const wallet = Wallet.fromKeys(publicKeyHex, secretKeyHex);

// From encrypted keystore file
const wallet = Wallet.fromKeystore(
  "~/.pyde/wallets/my-wallet.json",
  "my-password",
);

// From encrypted keystore object (already in memory)
const wallet = Wallet.fromEncrypted(keystoreObj, "my-password");
```

### Provider Binding

Bind a provider to the wallet so you don't pass it on every call.

```typescript
// Bind once
const wallet = Wallet.generate().connect(provider);

// Now call without provider arg
const balance = await wallet.getBalance();
const nonce = await wallet.getNonce();
const receipt = await wallet.transfer("0xrecipient...", 1000000n);
const receipt2 = await wallet.deploy(deployData);
const receipt3 = await wallet.sendCall("0xcontract...", calldata);

// All methods still accept an explicit provider (backward compatible)
const receipt4 = await wallet.transfer(otherProvider, "0xrecipient...", 1000n);
```

### Encrypted Keystore

Wallets can be encrypted with AES-256-GCM and saved to disk. The encryption key is
derived via Poseidon2(password || salt), matching the Rust SDK's keystore format exactly.

```typescript
// Generate a new wallet and save encrypted to disk
const wallet = Wallet.createEncrypted(
  "/path/to/wallet.json",
  "strong-password",
);
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
const privateKey = wallet.exportPrivateKey(); // "0x..." (pk+sk, 2178 bytes)

// Store it safely, restore later with:
const restored = Wallet.fromPrivateKey(privateKey);
```

### Validation

```typescript
// Validate a private key before importing
Wallet.isValidPrivateKey("0xabcdef..."); // true/false
// Checks: length = 2178 bytes (897 pk + 1281 sk), valid hex chars

// Generate a random private key (without creating a full wallet)
const pk = Wallet.generatePrivateKey(); // "0x..." (2178 bytes)
const wallet = Wallet.fromPrivateKey(pk);
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

## Address Utilities

```typescript
import { Address } from "pyde-ts-sdk";

// Zero address
const zero = Address.zero(); // "0x0000...0000" (32 bytes)
Address.isZero(zero); // true

// Validation
Address.isValid("0x" + "ab".repeat(32)); // true
Address.isValid("0xshort"); // false
Address.isValid("0x" + "zz".repeat(32)); // false

// Validate and normalize (throws on invalid)
const addr = Address.validate("ab".repeat(32)); // "0xabab..." (adds 0x prefix)
Address.validate("bad"); // Error: Invalid address

// Equality (case-insensitive)
Address.equals("0xAB...AB", "0xab...ab"); // true

// Private key validation
Address.isValidPrivateKey(Wallet.generatePrivateKey()); // true
Address.isValidPrivateKey("0xshort"); // false
```

---

## Transactions

### Sending a Transfer

The simplest transaction — send native tokens from one address to another.

```typescript
import { ReceiptUtils } from "pyde-ts-sdk";

const receipt = await wallet.transfer(
  provider,
  "0xrecipient...", // to address
  1000000n, // amount in quanta
);

console.log("Success:", receipt.success);
console.log("Gas Used:", ReceiptUtils.gas(receipt)); // parsed number
console.log("Fee Paid:", receipt.feePaid); // hex string
```

### Calling a Contract Function

Send a state-changing transaction to a deployed contract.

```typescript
// Using Contract (recommended — validates args against ABI)
const contract = Contract.fromArtifact(
  "out/Contract.json",
  addr,
  provider,
).connect(wallet);
const receipt = await contract.write("deposit", { amount: 500 });

// Low-level (manual calldata + wallet)
const data = new ContractCall("deposit").argU64(500).build();
const receipt2 = await wallet.sendCall(provider, "0xcontract...", data);
```

### Deploying a Contract

```typescript
import { DeployData, ReceiptUtils } from "pyde-ts-sdk";

// Build deploy payload from artifact with named constructor args
const deployData = DeployData.fromArtifact("out/Counter.json", {
  initial_supply: 1000,
}).build();

const receipt = await wallet.deploy(provider, deployData);

// Extract contract address from receipt
const contractAddr = ReceiptUtils.contractAddress(receipt);
console.log("Deployed at:", contractAddr);

// Deploy with value (payable constructor)
const receipt2 = await wallet.deploy(provider, deployData, {
  value: 1000000n,
  gasLimit: 200_000_000,
});
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

// 3. Send — returns TransactionResponse with hash + wait()
const tx = await provider.sendRawTransaction(signedHex);
console.log("Tx hash:", tx.hash);

// 4. Wait for confirmation
const receipt = await tx.wait(10000);
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
  .argString("hello") // String
  .argU64(42) // u64
  .argBool(true) // bool
  .argU256(99n) // u256
  .argAddress("0xaa...") // Address
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
  .argVecOf(3, (b) =>
    b.argString("alice").argString("bob").argString("charlie"),
  )
  .build();

// Vec<u256>
new ContractCall("set_bigs")
  .argVecOf(2, (b) => b.argU256(100n).argU256(200n))
  .build();
```

### Structs & Tuples

```typescript
// Struct: [byte_len:8][fields...]
new ContractCall("set_user")
  .argStruct((s) => s.argString("alice").argU64(25).argBool(true))
  .build();

// Tuple: sequential fields, no length prefix
new ContractCall("set_pair")
  .argTuple((t) => t.argU64(1).argString("one"))
  .build();
```

### Nested Types

`argVecOf` and `argStruct` are composable — nest them arbitrarily.

```typescript
// Vec<Struct>
new ContractCall("set_users")
  .argVecOf(2, (b) =>
    b
      .argStruct((s) => s.argString("alice").argU64(25))
      .argStruct((s) => s.argString("bob").argU64(30)),
  )
  .build();

// Vec<Vec<u64>>
new ContractCall("set_matrix")
  .argVecOf(2, (b) => b.argVecU64([1, 2, 3]).argVecU64([4, 5, 6]))
  .build();

// Vec<Tuple>
new ContractCall("set_pairs")
  .argVecOf(2, (b) =>
    b
      .argTuple((t) => t.argU64(1).argString("one"))
      .argTuple((t) => t.argU64(2).argString("two")),
  )
  .build();

// Struct containing Vec
new ContractCall("set_team")
  .argStruct((s) =>
    s
      .argString("Team Alpha")
      .argVecOf(3, (b) =>
        b.argString("alice").argString("bob").argString("charlie"),
      ),
  )
  .build();
```

### ABI-Aware Contract (fromArtifact + connect)

The recommended way to interact with contracts — loads the full ABI including
struct/enum definitions, validates args before broadcast, auto-encodes and decodes.

```typescript
import { Contract } from "pyde-ts-sdk";

// Load from build artifact (gets all functions, structs, enums)
const contract = Contract.fromArtifact(
  "out/MyContract.json",
  addr,
  provider,
).connect(wallet);

// Read — auto-decoded return value
const count = await contract.read("get_count"); // bigint
const user = await contract.read("get_user"); // { name: "alice", age: 25n, active: true }
const scores = await contract.read("get_scores"); // [100n, 200n, 300n]
const status = await contract.read("get_status"); // "Active" (enum variant name)

// Write — validated, encoded, signed, sent, waited
await contract.write("deposit", { amount: 500 });
await contract.write("set_user", {
  user: { name: "alice", age: 25, active: true },
});
await contract.write("set_status", { status: "Active" });
await contract.write("set_scores", { scores: [100, 200, 300] });
```

### Simulating Calls

Static-call ANY function (view or setter) without sending a transaction. Useful for
previewing results or testing before committing to a real tx.

```typescript
// Simulate a setter function — see what it would return without sending a tx
const result = await contract.simulate("deposit", { amount: 500 });

// Same as read() but the name makes intent clear for non-view functions
const count = await contract.simulate("get_count");
```

### Gas Estimation

Estimate gas for a contract call using the ABI — validates args before estimation.

```typescript
const gas = await contract.estimateGas("deposit", { amount: 500 });
console.log("Estimated gas:", gas);

// Then use it in the write call
await contract.write("deposit", { amount: 500 }, { gasLimit: gas });
```

### Payable Functions

Send native tokens (value) with a contract call. The SDK validates the `payable`
attribute from the ABI — non-payable functions reject value.

```typescript
// Send value with a payable function
await contract.write("deposit", { amount: 500 }, { value: 1000000n });

// Combine value and gas limit
await contract.write(
  "deposit",
  { amount: 500 },
  { value: 1000000n, gasLimit: 50_000_000 },
);

// Non-payable function rejects value
await contract.write("withdraw", { amount: 100 }, { value: 1n });
// Error: withdraw() is not payable — cannot send value
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

### Decoding Write Return Data

`Contract.write()` returns a `ContractReceipt` with a `decodeReturnData()` method
that auto-decodes using the ABI return type.

```typescript
const receipt = await contract.write("deposit", { amount: 500 });
console.log(receipt.success); // true (standard receipt field)

const val = receipt.decodeReturnData(); // auto-decoded from ABI (e.g., 42n)
// Returns null if returnData is absent or function returns ()
```

Note: `returnData` is ephemeral — only available in the receipt immediately after
tx execution. It is not persisted on-chain.

### Decoding Return Values

Manual decoders for raw hex return data (low-level alternative to Contract.read).

```typescript
import {
  decodeU64,
  decodeI64,
  decodeU128,
  decodeI128,
  decodeU256,
  decodeI256,
  decodeBool,
  decodeAddress,
  decodeString,
  decodeBytes,
} from "pyde-ts-sdk";

// GP integers
const count = decodeU64("0x2a00000000000000"); // 42n
const neg = decodeI64("0x" + "ff".repeat(8)); // -1n

// Wide integers
const big = decodeU128("0x0100000000000000" + "00".repeat(8)); // 1n
const sneg = decodeI128("0x" + "ff".repeat(16)); // -1n
const huge = decodeU256("0x0100000000000000" + "00".repeat(24)); // 1n
const shuge = decodeI256("0x" + "ff".repeat(32)); // -1n

// Other types
const flag = decodeBool("0x0100000000000000"); // true
const name = decodeString("0x050000000000000068656c6c6f"); // "hello"
const addr = decodeAddress("0x" + "aa".repeat(32)); // "0xaaaa..."
const raw = decodeBytes("0x0300000000000000aabbcc"); // Buffer<aabbcc>
```

### DeployData Builder

Build properly formatted deploy transaction payloads.

```typescript
import { DeployData } from "pyde-ts-sdk";

// From artifact with named constructor args (recommended)
const data = DeployData.fromArtifact("out/Counter.json", {
  initial_supply: 1000,
  name: "MyToken",
  owner: "0xaabb...",
}).build();

// Constructor args are validated against the ABI — missing/wrong types throw
DeployData.fromArtifact("out/Counter.json", {}); // Error: missing arg 'initial_supply'

// No constructor args
const simple = DeployData.fromArtifact("out/Simple.json").build();

// From raw bytecodes with manual arg chaining (low-level)
const manual = new DeployData(constructorHex, runtimeHex)
  .argU64(1000)
  .argString("hello")
  .build();
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

// Decode return data directly from receipt
const count = ReceiptUtils.decodeU64(receipt); // bigint | null
const flag = ReceiptUtils.decodeBool(receipt); // boolean | null
const name = ReceiptUtils.decodeString(receipt); // string | null
```

---

### Contract Events

Query and decode contract events using the ABI.

```typescript
// Query historical events (decoded with named args)
const transfers = await contract.queryFilter("Transfer", 0, 1000);
for (const e of transfers) {
  console.log(e.name); // "Transfer"
  console.log(e.args.from); // "0xaabb..."
  console.log(e.args.to); // "0xccdd..."
  console.log(e.args.amount); // 1000n
}

// Parse a single raw log
const decoded = contract.parseLog(rawLog);
if (decoded) console.log(decoded.name, decoded.args);

// Get topic0 hash for building custom filters
const topic = contract.getEventTopic("Transfer");
```

### Interface (Standalone ABI)

Encode/decode without a contract address or provider — useful for off-chain encoding,
multisig transaction building, or log parsing.

```typescript
import { Interface } from "pyde-ts-sdk";

const iface = Interface.fromArtifact("out/Counter.json");

// Encode calldata
const data = iface.encodeFunctionData("deposit", { amount: 500 });

// Decode return value
const val = iface.decodeFunctionResult("get_count", "0x2a00000000000000");

// Parse logs
const event = iface.parseLog(rawLog);

// Get event topic hash
const topic = iface.getEventTopic("Transfer");
```

---

### Populate Transaction

Build an unsigned transaction without sending — for multisig, offline signing, or review.

```typescript
const tx = await contract.populateTransaction("deposit", { amount: 500 });
console.log(tx.from, tx.to, tx.data, tx.nonce);
// Sign later: wallet.signTransaction(tx)
```

---

## WebSocket Provider

Real-time subscriptions via WebSocket. Supports new blocks, pending transactions, and log filters.

```typescript
import { WebSocketProvider } from "pyde-ts-sdk";

const ws = new WebSocketProvider("ws://127.0.0.1:8546");
await ws.ready;

// Subscribe to new block headers
ws.onBlock((header) => {
  console.log("New block:", header.slot);
});

// Subscribe to pending transactions
ws.onPendingTransaction((txHash) => {
  console.log("Pending tx:", txHash);
});

// Subscribe to contract event logs
ws.onLogs({ address: "0xcontract..." }, (log) => {
  console.log("Event:", log.topics, log.data);
});

// Generic event listener
ws.on("block", (header) => console.log(header));
ws.once("block", (header) => console.log("First block only:", header));
ws.off("block", myListener);
ws.removeAllListeners();

// Standard queries also work over WebSocket
const balance = await ws.getBalance("0xaddress...");

// Cleanup
ws.destroy();
```

---

## Abstract Signer

Base class for custom signers (hardware wallets, remote signers, custodial).

```typescript
import { AbstractSigner } from "pyde-ts-sdk";

class LedgerSigner extends AbstractSigner {
  readonly address = "0x...";

  signTransaction(tx: TxFields): string {
    return this.ledger.sign(tx); // your hardware wallet logic
  }

  sign(messageHex: string): string {
    return this.ledger.signMessage(messageHex);
  }
}

const signer = new LedgerSigner().connect(provider);
```

`Wallet` extends `AbstractSigner` conceptually — same interface, same `connect()` method.

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
const transferSig = poseidon2Hash(
  "0x" + Buffer.from("Transfer").toString("hex"),
);

const logs = await provider.getLogs({
  fromBlock: 0,
  toBlock: 1000,
  topics: [transferSig], // only Transfer events
});
```

### Filter by indexed parameters

```typescript
// Transfer events TO a specific address
const logs = await provider.getLogs({
  address: "0xtoken...",
  topics: [
    transferSig, // topic[0] = event signature
    null, // topic[1] = from (any)
    recipientAddr, // topic[2] = to (specific address)
  ],
});
```

### OR matching on a topic position

```typescript
// Transfer events FROM alice OR bob
const logs = await provider.getLogs({
  topics: [
    transferSig,
    [aliceAddr, bobAddr], // topic[1] = alice OR bob
  ],
});
```

---

## Error Handling

All SDK errors extend `PydeError` with a typed `code` field for programmatic handling.

```typescript
import {
  PydeError, CallExceptionError, ConnectionError, TimeoutError,
  RpcError, isError, isCallException,
} from "pyde-ts-sdk";

try {
  const receipt = await contract.write("deposit", { amount: 500 });
} catch (e) {
  // Type-safe error checking
  if (isCallException(e)) {
    console.log("Reverted! Gas:", e.gasUsed);
    console.log("Reason:", e.reason); // auto-decoded revert string (or null)
    console.log("Data:", e.data); // raw return data hex
  }

  // Or check by error code
  if (isError(e, "CONNECTION_ERROR")) {
    console.log("Node unreachable");
  }
  if (isError(e, "TIMEOUT")) {
    console.log("Timed out waiting for receipt");
  }
  if (isError(e, "RPC_ERROR")) {
    console.log("RPC error:", (e as RpcError).rpcError);
  }
}
```

**Error codes:** `CALL_EXCEPTION`, `CONNECTION_ERROR`, `TIMEOUT`, `RPC_ERROR`, `SIGNING_ERROR`, `INVALID_ARGUMENT`, `INSUFFICIENT_FUNDS`, `UNKNOWN_ERROR`

---

## Hex Utilities

```typescript
import {
  isHexString, hexlify, getBytes, toBeHex,
  concat, zeroPadValue, stripZeros, dataLength, dataSlice,
} from "pyde-ts-sdk";

// Check if valid hex
isHexString("0xdeadbeef"); // true
isHexString("0xgg"); // false
isHexString("0xaabb", 2); // true (2 bytes)

// Convert to hex
hexlify(Buffer.from([0xde, 0xad])); // "0xdead"
hexlify(255n); // "0xff"
hexlify(42); // "0x2a"

// Convert from hex to Buffer
getBytes("0xdeadbeef"); // Buffer<deadbeef>

// BigInt to big-endian hex (with optional width)
toBeHex(255n); // "0xff"
toBeHex(255n, 4); // "0x000000ff" (4 bytes padded)

// Concatenate
concat(["0xdead", "0xbeef"]); // "0xdeadbeef"

// Pad / strip
zeroPadValue("0xff", 4); // "0x000000ff"
stripZeros("0x000000ff"); // "0xff"

// Slice
dataLength("0xdeadbeef"); // 4
dataSlice("0xdeadbeef", 1, 3); // "0xadbe"
```

---

## Unit Formatting

Convert between human-readable token amounts and raw integer units.
1 PYDE = 10^9 quanta (default). Custom decimals supported.

```typescript
import { parseUnits, formatUnits, parseQuanta, formatQuanta } from "pyde-ts-sdk";

// Parse human-readable → raw (with custom decimals)
parseUnits("1.5", 9); // 1500000000n
parseUnits("100", 18); // 100000000000000000000n
parseUnits("0.001", 9); // 1000000n

// Format raw → human-readable
formatUnits(1500000000n, 9); // "1.5"
formatUnits(1000000n, 9); // "0.001"

// PYDE shortcuts (9 decimals)
parseQuanta("2.5"); // 2500000000n
formatQuanta(2500000000n); // "2.5"

// Custom token with 18 decimals
const raw = parseUnits("0.5", 18);
formatUnits(raw, 18); // "0.5"

// Validation
parseUnits("1.0000000001", 9); // Error: Too many decimal places
```

---

## Cryptographic Primitives

Direct access to the WASM-compiled crypto layer.

### Key Generation

```typescript
import { generateKeypair, deriveAddress } from "pyde-ts-sdk";

const keypair = generateKeypair();
// {
// publicKey: "0x..." (897 bytes, FALCON-512 public key),
// secretKey: "0x..." (1281 bytes, FALCON-512 secret key),
// address: "0x..." (32 bytes, Poseidon2 hash of public key)
// }

// Derive address from a public key
const address = deriveAddress(keypair.publicKey); // "0x..." (32 bytes)
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

const hash = poseidon2Hash("0xdeadbeef"); // "0x..." (32 bytes)
```

### Function Selectors

```typescript
import { computeSelector } from "pyde-ts-sdk";

const selector = computeSelector("get_count"); // 0xd9e32bf7
const selector2 = computeSelector("increment"); // 0x3812e73e
```

---

## Architecture

```
pyde-ts-sdk/
├── src/
│ ├── index.ts — re-exports
│ ├── provider.ts — RPC client (fetch-based, async)
│ ├── wallet.ts — FALCON-512 key management + signing + provider binding
│ ├── contract.ts — calldata encoding + ABI-aware reads/writes
│ ├── address.ts — Address utilities (zero, validation, equality)
│ ├── units.ts — Unit formatting (parseUnits, formatUnits, parseQuanta)
│ ├── errors.ts — Typed error classes (PydeError, CallExceptionError, etc.)
│ ├── hex.ts — Hex utilities (hexlify, getBytes, toBeHex, concat, etc.)
│ ├── ws-provider.ts — WebSocket provider with subscriptions
│ ├── crypto.ts — WASM bridge wrapper
│ └── types.ts — Receipt, Log, TxFields, ReceiptUtils, TransactionResponse
├── wasm/ — compiled Rust → WASM (FALCON-512, Poseidon2)
└── tests/
    └── sdk.test.ts — 85+ unit tests
```

All cryptographic operations are compiled from Rust to WebAssembly, guaranteeing exact compatibility with the Pyde node:

- **FALCON-512** — post-quantum lattice-based signatures (WASM)
- **Poseidon2** — ZK-friendly algebraic hash for tx hashing, address derivation, key derivation (WASM)
- **AES-256-GCM** — quantum-resistant symmetric encryption for keystore (Node.js `crypto` module, Poseidon2 for KDF)
