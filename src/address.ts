/** Address utilities for the Pyde blockchain (32-byte addresses). */

const ZERO = "0x" + "00".repeat(32);
const HEX_REGEX = /^[0-9a-fA-F]{64}$/;
const PK_LEN = (897 + 1281) * 2; // FALCON-512: 897 pk + 1281 sk = 4356 hex chars

export const Address = {
  /** The zero address (32 zero bytes). */
  zero(): string {
    return ZERO;
  },

  /** Check if an address is the zero address. */
  isZero(addr: string): boolean {
    const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
    return hex === "00".repeat(32);
  },

  /** Validate a 32-byte hex address string. Returns true if valid. */
  isValid(addr: string): boolean {
    const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
    return HEX_REGEX.test(hex);
  },

  /** Validate and return the address, or throw if invalid. */
  validate(addr: string): string {
    if (!Address.isValid(addr)) {
      throw new Error(`Invalid address: expected 0x + 64 hex chars, got "${addr.slice(0, 20)}..."`);
    }
    return addr.startsWith("0x") ? addr : "0x" + addr;
  },

  /** Check if two addresses are equal (case-insensitive). */
  equals(a: string, b: string): boolean {
    const ha = (a.startsWith("0x") ? a.slice(2) : a).toLowerCase();
    const hb = (b.startsWith("0x") ? b.slice(2) : b).toLowerCase();
    return ha === hb;
  },

  /** Validate a FALCON-512 private key hex (pk + sk combined, 2178 bytes). */
  isValidPrivateKey(hex: string): boolean {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length !== PK_LEN) return false;
    return /^[0-9a-fA-F]+$/.test(clean);
  },
};
