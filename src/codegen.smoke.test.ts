/**
 * Smoke test: run the codegen against the canonical `storage-stress`
 * contract bundle produced by `otigen build`. Verifies that the
 * generator handles the real-world ABI shape (29 functions, `ty` field
 * names, UpperCamelCase scalar types like `U64` / `U128` / `Bool`)
 * end-to-end.
 *
 * The test reads the bundle straight from the otigen examples
 * directory; if otigen has been rebuilt and re-packaged, the test
 * auto-picks up the new ABI without needing a fixture refresh.
 *
 * If the storage-stress bundle is missing (e.g. when running this
 * suite outside the monorepo) the test self-skips with a clear
 * message rather than failing.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateTypes } from "./codegen";

const BUNDLE_ABI = resolve(
  __dirname,
  "../../otigen/examples/storage-stress/artifacts/storage-stress.bundle/abi.json",
);

describe("codegen — storage-stress smoke", () => {
  if (!existsSync(BUNDLE_ABI)) {
    it.skip("storage-stress bundle missing — run from the pyde-net monorepo", () => {});
    return;
  }

  const abiJson = readFileSync(BUNDLE_ABI, "utf-8");
  const generated = generateTypes(abiJson, "StorageStress");

  it("emits a StorageStressContract interface", () => {
    expect(generated).toContain("export interface StorageStressContract");
  });

  it("includes 29 method signatures (one per ABI function)", () => {
    // Match `  name(...): Promise<...>;` lines (two-space indent + paren).
    const methodLines = generated.match(/^ {2}[a-zA-Z_$][\w$]*\(/gm) ?? [];
    expect(methodLines.length).toBe(29);
  });

  it("maps U64 → bigint", () => {
    // balance_of(u64) → u128 — both bigints.
    expect(generated).toMatch(/balance_of\(arg0: bigint\): Promise<bigint>;/);
  });

  it("maps U32 → number and U8 → number", () => {
    expect(generated).toMatch(/get_u32\(\): Promise<number>;/);
    expect(generated).toMatch(/get_u8\(\): Promise<number>;/);
  });

  it("maps Bool → boolean", () => {
    expect(generated).toMatch(/get_bool\(\): Promise<boolean>;/);
  });

  it("maps Address → string and String → string", () => {
    expect(generated).toMatch(/get_addr\(\): Promise<string>;/);
    expect(generated).toMatch(/get_string\(\): Promise<string>;/);
  });

  it("maps Bytes → Uint8Array", () => {
    expect(generated).toMatch(/get_bytes\(\): Promise<Uint8Array>;/);
  });

  it("falls back to unknown for unmapped types (Bytes32 / Hash / Vec<u64>)", () => {
    expect(generated).toMatch(/get_bytes32\(\): Promise<unknown>;/);
    expect(generated).toMatch(/get_hash\(\): Promise<unknown>;/);
    expect(generated).toMatch(/get_vec_u64\(\): Promise<unknown>;/);
  });

  it("captures a multi-arg method correctly (set_triple takes 4 args)", () => {
    expect(generated).toMatch(
      /set_triple\(arg0: bigint, arg1: bigint, arg2: bigint, arg3: bigint\): Promise<void>;/,
    );
  });
});
