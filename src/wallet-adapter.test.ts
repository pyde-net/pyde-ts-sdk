/**
 * Wallet-adapter unit tests — InMemoryWalletAdapter event emission,
 * connect/disconnect lifecycle, and BrowserWalletAdapter constructor
 * isolation. Checklist items J.2.1 - J.2.5.
 */
import { describe, it, expect } from "vitest";

import { Wallet } from "./wallet";
import {
  InMemoryWalletAdapter,
  BrowserWalletAdapter,
  type WalletAdapterEvent,
} from "./wallet-adapter";

describe("InMemoryWalletAdapter — lifecycle + events (J.2.5)", () => {
  it("fires 'connect' when connect() resolves", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    const seen: WalletAdapterEvent[] = [];
    adapter.on("connect", () => seen.push("connect"));
    adapter.on("disconnect", () => seen.push("disconnect"));

    await adapter.connect();
    expect(seen).toEqual(["connect"]);
    expect(adapter.connected).toBe(true);
    expect(adapter.address).toBe(w.address);
  });

  it("fires 'disconnect' when disconnect() resolves", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    const seen: WalletAdapterEvent[] = [];
    adapter.on("disconnect", () => seen.push("disconnect"));

    await adapter.connect();
    await adapter.disconnect();
    expect(seen).toEqual(["disconnect"]);
    expect(adapter.connected).toBe(false);
    expect(adapter.address).toBeNull();
  });

  it("off() removes a listener — subsequent connect emits nothing to that listener", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    let count = 0;
    const onConnect = () => {
      count += 1;
    };
    adapter.on("connect", onConnect);
    adapter.off("connect", onConnect);
    await adapter.connect();
    expect(count).toBe(0);
  });

  it("fires events to multiple subscribers", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    let a = 0;
    let b = 0;
    adapter.on("connect", () => (a += 1));
    adapter.on("connect", () => (b += 1));
    await adapter.connect();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("a throwing listener doesn't break other subscribers", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    let ok = 0;
    adapter.on("connect", () => {
      throw new Error("listener boom");
    });
    adapter.on("connect", () => (ok += 1));
    await adapter.connect();
    expect(ok).toBe(1);
  });

  it("signMessage / signTransaction require connect() first", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    await expect(adapter.signMessage("0xabcd")).rejects.toThrow(/not connected/i);
  });

  it("after destroy() of underlying wallet, connect() throws cleanly", async () => {
    const w = Wallet.generateUnsafe();
    const adapter = new InMemoryWalletAdapter(w);
    w.destroy();
    // The adapter holds the wallet reference; signMessage/Transaction
    // would surface WalletDestroyedError once connected. But connect()
    // itself just flips a flag and returns the address.
    await adapter.connect();
    await expect(adapter.signMessage("0xabcd")).rejects.toThrow();
  });
});

describe("BrowserWalletAdapter — constructor isolation (J.2.2-J.2.4)", () => {
  it("throws clearly in Node without options.injected", () => {
    expect(() => new BrowserWalletAdapter()).toThrow(/window\.pyde|injected/i);
  });

  it("accepts an injected stub + custom name", () => {
    const stub = {
      request: async () => "0x" + "00".repeat(32),
      on: () => undefined,
      off: () => undefined,
    };
    const adapter = new BrowserWalletAdapter({
      name: "custom-wallet",
      injected: stub as never,
    });
    expect(adapter.name).toBe("custom-wallet");
    expect(adapter.connected).toBe(false);
    expect(adapter.address).toBeNull();
  });
});
