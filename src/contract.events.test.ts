import { describe, it, expect } from "vitest";
import { blake3 } from "@noble/hashes/blake3";
import { Contract } from "./contract";
import { Provider } from "./provider";

// Event topic-0 is `Blake3("name(canonicalType1,…)")` — the value pyde-host's
// `#[event]` derive computes, the contract passes to `emit_event`, and the
// engine stores. Regression guard: it must NOT revert to the old FNV-selector
// (4-byte name selector + 28 zero bytes), which never matched a real log.

const provider = new Provider("http://127.0.0.1:9933", { allowInsecureTransport: true }); // constructed only; never called
const ADDR = "0x" + "11".repeat(32);

// Real engine ABIs carry event fields under `params` with an `indexed_mask`
// bitmask (NOT `fields` + per-field `indexed`) — use the real shape here.
const ABI = JSON.stringify({
  contract: "Demo",
  functions: [],
  events: [
    {
      name: "Transfer",
      params: [
        { name: "from", ty: "Address" },
        { name: "to", ty: "Address" },
        { name: "amount", ty: "U128" },
      ],
      indexed_mask: 0b011, // from + to indexed
    },
    { name: "Ping", params: [], indexed_mask: 0 },
  ],
});

const topic0 = (sig: string) =>
  "0x" + Buffer.from(blake3(new TextEncoder().encode(sig))).toString("hex");

describe("event topic0 = Blake3(canonical signature)", () => {
  const c = Contract.fromJson(ABI, ADDR, provider);

  it("matches Blake3 of the canonical Solidity-style signature", () => {
    expect(c.getEventTopic("Transfer")).toBe(topic0("Transfer(address,address,uint128)"));
  });

  it("no-field event is `Name()`", () => {
    expect(c.getEventTopic("Ping")).toBe(topic0("Ping()"));
  });

  it("is a full 32-byte hash, not the old FNV-selector-with-28-zeros form", () => {
    const t = c.getEventTopic("Transfer");
    expect(t).toHaveLength(66); // 0x + 64 hex
    expect(t.endsWith("0".repeat(56))).toBe(false);
  });

  it("throws on an event not in the ABI", () => {
    expect(() => c.getEventTopic("Nope")).toThrow(/unknown event/);
  });

  it("parseLog matches a log carrying the real topic0 (and rejects a wrong one)", () => {
    const from = "0x" + "aa".repeat(32);
    const to = "0x" + "bb".repeat(32);
    const good = { contract: ADDR, topics: [c.getEventTopic("Transfer"), from, to], data: "0x" } as never;
    expect(c.parseLog(good)?.name).toBe("Transfer");

    const bad = { contract: ADDR, topics: ["0x" + "00".repeat(32)], data: "0x" } as never;
    expect(c.parseLog(bad)).toBeNull();
  });
});
