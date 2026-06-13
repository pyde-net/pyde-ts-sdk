import { describe, it, expect } from "vitest";
import {
  isHexString,
  hexlify,
  getBytes,
  toBeHex,
  concat,
  zeroPadValue,
  stripZeros,
  dataLength,
  dataSlice,
} from "./hex";

describe("isHexString", () => {
  it("accepts 0x-prefixed lowercase hex", () => {
    expect(isHexString("0xabcdef")).toBe(true);
  });
  it("accepts uppercase + mixed case", () => {
    expect(isHexString("0xABcDEF")).toBe(true);
  });
  it("accepts hex without 0x prefix", () => {
    expect(isHexString("deadbeef")).toBe(true);
  });
  it("rejects non-strings", () => {
    expect(isHexString(123 as unknown as string)).toBe(false);
    expect(isHexString(null as unknown as string)).toBe(false);
  });
  it("rejects non-hex characters", () => {
    expect(isHexString("0xgg")).toBe(false);
  });
  it("respects byte-length constraint", () => {
    expect(isHexString("0x" + "ab".repeat(32), 32)).toBe(true);
    expect(isHexString("0x" + "ab".repeat(31), 32)).toBe(false);
  });
});

describe("hexlify", () => {
  it("normalises hex strings to lowercase 0x-prefixed", () => {
    expect(hexlify("ABCDEF")).toBe("0xabcdef");
    expect(hexlify("0xDeAdBeEf")).toBe("0xdeadbeef");
  });
  it("encodes positive numbers + bigints", () => {
    expect(hexlify(255)).toBe("0xff");
    expect(hexlify(0n)).toBe("0x0");
    expect(hexlify(2n ** 64n)).toBe("0x10000000000000000");
  });
  it("encodes Uint8Array", () => {
    expect(hexlify(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
  });
  it("rejects negative bigints", () => {
    expect(() => hexlify(-1n)).toThrow(/negative/);
  });
  it("rejects fractional numbers", () => {
    expect(() => hexlify(1.5)).toThrow(/Invalid/);
  });
});

describe("getBytes", () => {
  it("decodes hex to Uint8Array", () => {
    const b = getBytes("0xdead");
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Array.from(b)).toEqual([0xde, 0xad]);
  });
  it("passes Uint8Array through", () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(getBytes(u)).toBe(u);
  });
  it("rejects odd-length hex", () => {
    expect(() => getBytes("0xabc")).toThrow(/even length/);
  });
});

describe("toBeHex", () => {
  it("encodes without width", () => {
    expect(toBeHex(255)).toBe("0xff");
    expect(toBeHex(0xabcd)).toBe("0xabcd");
  });
  it("encodes with width padding", () => {
    expect(toBeHex(1, 4)).toBe("0x00000001");
  });
});

describe("concat", () => {
  it("concatenates hex strings + bytes", () => {
    expect(concat(["0xde", "0xad"])).toBe("0xdead");
    expect(concat([new Uint8Array([0xbe]), "0xef"])).toBe("0xbeef");
  });
});

describe("zeroPadValue", () => {
  it("left-pads with zeros", () => {
    expect(zeroPadValue("0x01", 4)).toBe("0x00000001");
  });
  it("rejects values longer than the target", () => {
    expect(() => zeroPadValue("0xabcdef", 2)).toThrow(/exceeds/);
  });
});

describe("stripZeros", () => {
  it("strips leading zero bytes", () => {
    expect(stripZeros("0x000000ff")).toBe("0xff");
  });
});

describe("dataLength + dataSlice", () => {
  it("computes byte length", () => {
    expect(dataLength("0xdeadbeef")).toBe(4);
  });
  it("slices in byte units", () => {
    expect(dataSlice("0xdeadbeef", 1, 3)).toBe("0xadbe");
  });
});
