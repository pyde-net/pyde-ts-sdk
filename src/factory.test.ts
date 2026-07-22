/**
 * Factory-pattern (PIP-0006) child-address derivation — unit tests (no devnet).
 *
 * Replays the pyde-host golden conformance vectors byte-for-byte. The
 * canonical home of the fixture is `pyde-net/pyde-host/vectors/
 * child_address.json`; the copy under `src/__fixtures__/` is verbatim —
 * regenerate upstream (`cargo test -p pyde-host regenerate_golden_vectors
 * -- --ignored`) and re-copy, never edit here.
 *
 * Covers: childPreimage / childAddress against all vectors, the engine's
 * pinned KAT anchored independently of the fixture, saltOfBytes /
 * saltOfCounter / saltOfUnorderedPair (incl. the unsigned-sort
 * sign-boundary vector), and the Instantiated event decoder.
 */
import { describe, it, expect } from "vitest";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import {
  CHILD_ADDRESS_DOMAIN_TAG,
  INSTANTIATED_TOPIC0,
  childAddress,
  childPreimage,
  saltOfBytes,
  saltOfCounter,
  saltOfUnorderedPair,
  decodeInstantiated,
  type InstantiatedEvent,
} from "./factory";
import { InvalidArgumentError } from "./errors";
import type { Log } from "./types";
import golden from "./__fixtures__/child_address.json";

interface ChildVector {
  name: string;
  parent: string;
  template: string;
  salt: string;
  preimage: string;
  child_address: string;
  salt_source_typed?: string;
  salt_source_borsh?: string;
  salt_source_pair_args?: string[];
}

const vectors = golden.vectors as ChildVector[];

// --------------------------------------------------------------------------
// Golden vectors — full replay
// --------------------------------------------------------------------------
describe("child_address.json golden vectors", () => {
  it("fixture carries all 13 vectors", () => {
    expect(vectors.length).toBe(13);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      it("childPreimage assembles the 107-byte preimage", () => {
        const preimage = childPreimage(v.parent, v.template, v.salt);
        expect(preimage).toBe("0x" + v.preimage);
        expect((preimage.length - 2) / 2).toBe(107);
      });

      it("childAddress reproduces the vector", () => {
        expect(childAddress(v.parent, v.template, v.salt)).toBe("0x" + v.child_address);
      });

      if (v.salt_source_borsh !== undefined) {
        it("saltOfBytes(salt_source_borsh) reproduces the identity salt", () => {
          expect(saltOfBytes(v.salt_source_borsh!)).toBe("0x" + v.salt);
        });
      }

      if (v.salt_source_pair_args !== undefined) {
        it("saltOfUnorderedPair sorts unsigned-bytewise, order-independent", () => {
          const [a, b] = v.salt_source_pair_args!;
          // pair_args are deliberately UNSORTED — reproducing the salt
          // from them requires actually implementing the sort.
          expect(saltOfUnorderedPair(a!, b!)).toBe("0x" + v.salt);
          expect(saltOfUnorderedPair(b!, a!)).toBe("0x" + v.salt);
          // A naive unsorted concat of the args as passed must diverge.
          expect(saltOfBytes(a! + b!)).not.toBe("0x" + v.salt);
        });
      }
    });
  }

  it("saltOfCounter(0n) / (1n) reproduce the counter vectors", () => {
    const c0 = vectors.find((v) => v.name === "salt-of-counter-0")!;
    const c1 = vectors.find((v) => v.name === "salt-of-counter-1")!;
    expect(saltOfCounter(0n)).toBe("0x" + c0.salt);
    expect(saltOfCounter(1n)).toBe("0x" + c1.salt);
    // number and bigint forms agree
    expect(saltOfCounter(0)).toBe(saltOfCounter(0n));
    expect(saltOfCounter(1)).toBe(saltOfCounter(1n));
  });
});

// --------------------------------------------------------------------------
// Engine KAT — anchored independently of the fixture file
// --------------------------------------------------------------------------
describe("engine KAT anchor (crates/account/src/address.rs)", () => {
  it("11×32 / 22×32 / 33×32 → pinned child address", () => {
    const parent = "0x" + "11".repeat(32);
    const template = "0x" + "22".repeat(32);
    const salt = "0x" + "33".repeat(32);
    expect(childAddress(parent, template, salt)).toBe(
      "0x354ab9a58e3fb76b484390a2ef277594042e12fd0b74343e5bf34dba492f3dfe",
    );
  });

  it("domain tag is the 11 wire-frozen ASCII bytes", () => {
    expect(CHILD_ADDRESS_DOMAIN_TAG).toBe("pyde-child:");
    expect(bytesToHex(utf8ToBytes(CHILD_ADDRESS_DOMAIN_TAG))).toBe("707964652d6368696c643a");
  });
});

// --------------------------------------------------------------------------
// Input validation
// --------------------------------------------------------------------------
describe("input validation", () => {
  const OK = "0x" + "ab".repeat(32);

  it("childAddress rejects non-32-byte inputs", () => {
    expect(() => childAddress("0x1234", OK, OK)).toThrow(InvalidArgumentError);
    expect(() => childAddress(OK, "0x" + "ab".repeat(31), OK)).toThrow(/must be 32 bytes/);
    expect(() => childAddress(OK, OK, "0x" + "ab".repeat(33))).toThrow(/must be 32 bytes/);
    expect(() => childAddress("0xzz".repeat(32), OK, OK)).toThrow(InvalidArgumentError);
  });

  it("childPreimage accepts bare hex like the rest of the SDK", () => {
    expect(childPreimage("11".repeat(32), "22".repeat(32), "33".repeat(32))).toBe(
      childPreimage("0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)),
    );
  });

  it("saltOfCounter enforces u64 range", () => {
    expect(() => saltOfCounter(-1n)).toThrow(/out of u64 range/);
    expect(() => saltOfCounter(1n << 64n)).toThrow(/out of u64 range/);
    expect(() => saltOfCounter(1.5)).toThrow(/safe integer/);
    expect(saltOfCounter((1n << 64n) - 1n)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("saltOfUnorderedPair rejects non-32-byte members", () => {
    expect(() => saltOfUnorderedPair(OK, "0xabcd")).toThrow(/must be 32 bytes/);
    expect(() => saltOfUnorderedPair("0x", OK)).toThrow(/must be 32 bytes/);
  });

  it("saltOfBytes accepts empty input (borsh of the unit value)", () => {
    const unit = vectors.find((v) => v.name === "salt-of-unit-empty-borsh")!;
    expect(saltOfBytes("")).toBe("0x" + unit.salt);
    expect(saltOfBytes(new Uint8Array(0))).toBe("0x" + unit.salt);
  });
});

// --------------------------------------------------------------------------
// Instantiated event decoding
// --------------------------------------------------------------------------

/** Build a KAT Instantiated log: value 2^100 + 7 proves full-u128 decode. */
function katLog(): { log: Log; expected: Omit<InstantiatedEvent, "log"> } {
  const parent = "0x" + "11".repeat(32);
  const template = "0x" + "22".repeat(32);
  const salt = "0x" + "33".repeat(32);
  const child = childAddress(parent, template, salt);
  const value = (1n << 100n) + 7n;

  const valueLe = new Uint8Array(16);
  let x = value;
  for (let i = 0; i < 16; i++) {
    valueLe[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  const data = parent + salt.slice(2) + bytesToHex(valueLe);

  const log: Log = {
    waveId: 42n,
    txIndex: 0,
    eventIndex: 0,
    contract: parent,
    topics: [INSTANTIATED_TOPIC0, child, template],
    data,
  };
  return { log, expected: { child, template, parent, salt, value } };
}

describe("decodeInstantiated", () => {
  it('topic0 constant equals Blake3("pyde.Instantiated")', () => {
    expect(INSTANTIATED_TOPIC0).toBe("0x" + bytesToHex(blake3(utf8ToBytes("pyde.Instantiated"))));
  });

  it("round-trips a constructed KAT event", () => {
    const { log, expected } = katLog();
    const ev = decodeInstantiated(log);
    expect(ev.child).toBe(expected.child);
    expect(ev.template).toBe(expected.template);
    expect(ev.parent).toBe(expected.parent);
    expect(ev.salt).toBe(expected.salt);
    expect(ev.value).toBe(expected.value);
    expect(typeof ev.value).toBe("bigint");
    // parent in data duplicates the emitting factory
    expect(ev.parent).toBe(log.contract);
    expect(ev.log).toBe(log);
  });

  it("rejects a wrong topic0", () => {
    const { log } = katLog();
    const wrong = { ...log, topics: ["0x" + "ff".repeat(32), ...log.topics.slice(1)] };
    expect(() => decodeInstantiated(wrong)).toThrow(InvalidArgumentError);
    expect(() => decodeInstantiated(wrong)).toThrow(/not the Instantiated event/);
  });

  it("rejects missing topics", () => {
    const { log } = katLog();
    const short = { ...log, topics: [INSTANTIATED_TOPIC0, log.topics[1]!] };
    expect(() => decodeInstantiated(short)).toThrow(/expected 3 topics/);
  });

  it("rejects short and long data", () => {
    const { log } = katLog();
    const short = { ...log, data: log.data.slice(0, log.data.length - 2) }; // 79 bytes
    expect(() => decodeInstantiated(short)).toThrow(/exactly 80 bytes/);
    const long = { ...log, data: log.data + "00" }; // 81 bytes
    expect(() => decodeInstantiated(long)).toThrow(/exactly 80 bytes/);
  });
});
