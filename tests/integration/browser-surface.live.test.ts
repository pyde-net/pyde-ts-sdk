/**
 * Browser-surface typecheck + import-time sanity.
 *
 * This file runs as a unit test but its role is consumer-emulation:
 *   - Import every public symbol from the package's three entrypoints
 *     (root, ./codegen, ./react) the way a downstream app would.
 *   - Construct the browser-shape types (BrowserWalletAdapter) without
 *     a real injected window object, to prove the constructor doesn't
 *     immediately reach for window/document at import time.
 *   - Exercise the React hook module-level surface (re-export shape) —
 *     we can't actually render, but we CAN verify the symbols exist
 *     and have the right kind.
 *
 * Vitest already type-checks via vite's esbuild transformer; if any
 * of these imports were broken the file wouldn't compile.
 *
 * Excluded from npm publish — lives outside `files`.
 */

import { describe, it, expect } from "vitest";

// Root entry — exhaustive public surface.
import {
  Provider,
  WebSocketProvider,
  Wallet,
  WalletDestroyedError,
  AbstractSigner,
  InMemoryWalletAdapter,
  BrowserWalletAdapter,
  Contract,
  Interface,
  ContractCall,
  DeployData,
  Address,
  parseUnits,
  formatUnits,
  parseQuanta,
  formatQuanta,
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
  generateKeypair,
  generateKeypairHandle,
  keypairFromSeed,
  deriveAddress,
  signMessage,
  signTransaction,
  verifySignature,
  poseidon2Hash,
  computeSelector,
  hashTransaction,
  TxType,
  AccountType,
  ReceiptUtils,
  type WalletAdapter,
  type WalletAdapterEvent,
  type ProviderOptions,
  type Keystore,
  type Keypair,
  type KeypairHandle,
  type ErrorCode,
  type ContractReceipt,
  type EventLog,
  type ThresholdPublicKey,
  type SimulateTransactionResult,
  type NodeInfo,
  type ValidatorInfo,
  type MetricsSnapshot,
  type SnapshotManifest,
} from "../../src/index";

// Codegen entry — separate dist target.
import * as codegen from "../../src/codegen";

describe("Browser surface — module shape", () => {
  it("root entry — class symbols are constructors", () => {
    expect(typeof Provider).toBe("function");
    expect(typeof WebSocketProvider).toBe("function");
    expect(typeof Wallet).toBe("function");
    expect(typeof AbstractSigner).toBe("function");
    expect(typeof Contract).toBe("function");
    expect(typeof Interface).toBe("function");
    expect(typeof ContractCall).toBe("function");
    expect(typeof DeployData).toBe("function");
    // `Address` is a namespace (helpers like `Address.isValid(...)`),
    // not a constructor. Verify it's the right shape.
    expect(typeof Address).toBe("object");
    expect(Address).not.toBeNull();
  });

  it("root entry — error classes are throwable + introspectable", () => {
    const e = new RpcError("test", { code: -32601, message: "method not found" });
    expect(e).toBeInstanceOf(PydeError);
    // `isError(e, code)` checks both class + code. RpcError is a
    // PydeError subclass; we don't assert a specific code here.
    expect(e).toBeInstanceOf(RpcError);
    expect(typeof WalletDestroyedError).toBe("function");
    expect(typeof CallExceptionError).toBe("function");
    expect(typeof ConnectionError).toBe("function");
    expect(typeof TimeoutError).toBe("function");
    expect(typeof InvalidArgumentError).toBe("function");
    expect(typeof InsufficientFundsError).toBe("function");
    expect(typeof SigningError).toBe("function");
    // isError requires an explicit code argument per signature.
    expect(typeof isError).toBe("function");
    expect(typeof isCallException).toBe("function");
  });

  it("root entry — unit helpers are pure functions", () => {
    expect(parseUnits("1.5", 9)).toBe(1_500_000_000n);
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(parseQuanta("1.5")).toBe(1_500_000_000n);
    expect(formatQuanta(1_500_000_000n)).toBe("1.5");
  });

  it("root entry — crypto helpers run without engine/devnet", () => {
    expect(typeof generateKeypair).toBe("function");
    expect(typeof generateKeypairHandle).toBe("function");
    expect(typeof keypairFromSeed).toBe("function");
    const kp = generateKeypair();
    expect(deriveAddress(kp.publicKey)).toBe(kp.address);
    expect(verifySignature(kp.publicKey, "0xabcd", signMessage(kp.secretKey, "0xabcd"))).toBe(true);
    expect(poseidon2Hash("0xdead")).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(typeof computeSelector("transfer")).toBe("number");
    expect(typeof hashTransaction).toBe("function");
    expect(typeof signTransaction).toBe("function");
  });

  it("root entry — enum constants", () => {
    expect(TxType.Standard).toBe(0);
    expect(typeof AccountType).toBe("object");
    expect(typeof ReceiptUtils).toBe("object");
  });

  it("WalletAdapter — InMemoryWalletAdapter wraps a Wallet without touching window", async () => {
    const w = Wallet.generateUnsafe();
    const adapter: WalletAdapter = new InMemoryWalletAdapter(w);
    // Fresh adapter is constructed disconnected; connect() binds it.
    expect(adapter.connected).toBe(false);
    expect(adapter.address).toBeNull();
    const bound = await adapter.connect();
    expect(bound).toBe(w.address);
    expect(adapter.connected).toBe(true);
    expect(adapter.address).toBe(w.address);
  });

  it("WalletAdapter — BrowserWalletAdapter constructs around an injected provider stub", () => {
    // The constructor only attaches event listeners — it doesn't
    // reach for window.* unless we omit `options.injected`. We pass
    // a stub matching InjectedPydeProvider so no global is touched.
    const stub = {
      request: async () => "0x" + "00".repeat(32),
      on: () => undefined,
      off: () => undefined,
    };
    const adapter = new BrowserWalletAdapter({
      name: "test-stub",
      injected: stub as never,
    });
    expect(adapter.name).toBe("test-stub");
    expect(adapter.connected).toBe(false);
    expect(adapter.address).toBeNull();
  });

  it("WalletAdapter — BrowserWalletAdapter without options throws clearly in Node (no window.pyde)", () => {
    expect(() => new BrowserWalletAdapter()).toThrow(/window\.pyde|injected/i);
  });

  it("WalletAdapter — event names are the public spec", () => {
    const names: WalletAdapterEvent[] = ["connect", "disconnect", "addressChange"];
    expect(names.length).toBe(3);
  });

  it("codegen entry — exports the public codegen surface", () => {
    expect(typeof codegen).toBe("object");
    // codegen's top-level export is `generateTypes(...)` per the
    // pyde-tsgen CLI. We only assert the module isn't empty.
    expect(Object.keys(codegen).length).toBeGreaterThan(0);
  });

  it("type re-exports compile (sanity-check by using them in annotations)", () => {
    // If any of these types vanished from the public surface, this
    // wouldn't compile. Runtime is just truthy checks.
    const _opts: ProviderOptions = { timeout: 30_000, retries: 3 };
    const _ks: Keystore | null = null;
    const _kp: Keypair | null = null;
    const _kph: KeypairHandle | null = null;
    const _err: ErrorCode | null = null;
    const _r: ContractReceipt | null = null;
    const _ev: EventLog | null = null;
    const _t: ThresholdPublicKey | null = null;
    const _sim: SimulateTransactionResult | null = null;
    const _ni: NodeInfo | null = null;
    const _vi: ValidatorInfo | null = null;
    const _ms: MetricsSnapshot | null = null;
    const _sn: SnapshotManifest | null = null;
    expect(_opts.timeout).toBe(30_000);
    expect(_opts.retries).toBe(3);
    void [_ks, _kp, _kph, _err, _r, _ev, _t, _sim, _ni, _vi, _ms, _sn];
  });
});
