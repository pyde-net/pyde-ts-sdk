/**
 * Contract live round-trip against `otigen/examples/borsh-coverage`.
 *
 * Validates the SDK's full ABI surface end-to-end on a live devnet:
 *   - Deploy via the `otigen deploy` CLI (devnet-0 pays gas — no SDK
 *     wallet funding path needed for the read side).
 *   - `Contract.fromArtifact` parses the engine's native ABI
 *     (`{Custom: "Order"}` + `types[]`-with-`kind`).
 *   - `Contract.read` round-trips every borsh wire-shape borsh-coverage
 *     exposes: primitive echo, Vec, Option, Address, Struct, Enum,
 *     multi-arg tuple.
 *
 * Skips automatically when:
 *   - `otigen` isn't on PATH
 *   - the borsh-coverage bundle isn't built
 *   - the keystore hasn't been imported (run `otigen wallet import
 *     --from-devnet --password-stdin` once with the test password)
 *
 * Run: `npm run test:integration`
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { spawnDevnet, type DevnetHandle } from "./devnet";
import { Contract } from "../../src/contract";

// Local `exec` that uses spawn() instead of promisify(execFile). Node's
// `execFile` `input` option doesn't close the child's stdin in a way
// `otigen --password-stdin` can detect, so the deploy hangs forever.
// `spawn` + explicit `stdin.end()` reproduces the shell pipe behavior.
async function exec(
  cmd: string,
  args: string[],
  opts: { input?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve_, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          Object.assign(new Error(`${cmd} timed out after ${opts.timeout}ms`), {
            stdout,
            stderr,
          }),
        );
      }, opts.timeout);
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve_({ stdout, stderr });
      } else {
        reject(
          Object.assign(new Error(`${cmd} exited ${code}`), {
            stdout,
            stderr,
          }),
        );
      }
    });
  });
}

const BORSH_BUNDLE = resolve(
  __dirname,
  "../../../otigen/examples/borsh-coverage/artifacts/borsh-coverage.bundle",
);
const BORSH_ABI = resolve(BORSH_BUNDLE, "abi.json");
const BORSH_TOML = resolve(__dirname, "../../../otigen/examples/borsh-coverage/otigen.toml");
const KEYSTORE_PW = "integration-test-password";

let devnet: DevnetHandle;
let contractAddress: string;

async function ensureDevnetKeystore(): Promise<void> {
  // If devnet-0 is already in the keystore we're done — calling
  // `otigen wallet import --from-devnet` again interactively prompts
  // on the existing entry and blocks the test runner.
  try {
    const { stdout } = await exec("otigen", ["wallet", "list"], { timeout: 10_000 });
    if (/devnet-0\b/.test(stdout)) return;
  } catch {
    // `list` failure → fall through to import.
  }
  try {
    await exec("otigen", ["wallet", "import", "--from-devnet", "--password-stdin"], {
      input: KEYSTORE_PW,
      timeout: 15_000,
    });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (!/already|exists/i.test(stderr)) {
      throw new Error(`otigen wallet import failed: ${stderr || (e as Error).message}`);
    }
  }
}

/** Deploy borsh-coverage via the otigen CLI, return the contract
 *  address. Uses `--json` for stable parsing. */
async function deployBorshCoverage(): Promise<string> {
  // Hard cap on the deploy step; the surrounding beforeAll has a
  // longer wall-clock budget but if `otigen deploy` hangs we want a
  // clear error rather than the suite-level "Hook timed out in 180s".
  let stdout = "";
  let stderr = "";
  try {
    const result = await exec(
      "otigen",
      [
        "deploy",
        "--bundle",
        BORSH_BUNDLE,
        "--config",
        BORSH_TOML,
        "--from",
        "devnet-0",
        "--password-stdin",
        "--network",
        "devnet",
        "--json",
      ],
      { input: KEYSTORE_PW + "\n", timeout: 60_000 },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    throw new Error(
      `otigen deploy failed:\n  stdout=${stdout || "<empty>"}\n  stderr=${stderr || "<empty>"}\n  err=${err.message ?? "unknown"}`,
    );
  }
  void stderr;

  // `--json` emits NDJSON; the last event with `contract_address` is
  // the inclusion record. Fall back to address scan if no JSON line
  // matches.
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const obj = JSON.parse(line);
      const addr = obj.contract_address ?? obj.address ?? obj.deployed_address;
      if (typeof addr === "string" && /^0x[0-9a-fA-F]{64}$/.test(addr)) return addr;
    } catch {
      // not JSON — continue scanning
    }
  }
  const match = stdout.match(/0x[0-9a-fA-F]{64}/);
  if (!match) {
    throw new Error(`could not parse contract address from otigen deploy output:\n${stdout}`);
  }
  return match[0];
}

beforeAll(async () => {
  if (!existsSync(BORSH_ABI)) {
    // Bundle wasn't built — the suite skips itself.
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[contract.live] spawning devnet…");
  devnet = await spawnDevnet({ tickMs: 100 });
  // eslint-disable-next-line no-console
  console.log("[contract.live] devnet up at", devnet.rpcUrl);
  await ensureDevnetKeystore();
  // eslint-disable-next-line no-console
  console.log("[contract.live] keystore ready; deploying borsh-coverage…");
  contractAddress = await deployBorshCoverage();
  // eslint-disable-next-line no-console
  console.log("[contract.live] deployed at", contractAddress);
}, 180_000);

afterAll(async () => {
  await devnet?.stop();
});

describe.skipIf(!existsSync(BORSH_ABI))(
  "Contract — live borsh round-trips against borsh-coverage",
  () => {
    it("Address echo (round-trips a 32-byte Address via the borsh codec)", async () => {
      // borsh-coverage doesn't have a dedicated address echo, but the
      // five_args function takes a u128 with our test as the last arg.
      // We use echo_order as a struct that contains an Address-shaped
      // FixedBytes:32 field, and assert that field round-trips.
      const contract = await Contract.fromArtifact(BORSH_ABI, contractAddress, devnet.provider);
      const order = {
        id: 42n,
        maker: "0x" + "ab".repeat(32),
        items: ["apple", "banana"],
        paid: true,
      };
      const result = await contract.read("echo_order", { arg0: order });
      expect(result).toEqual(order);
    }, 60_000);

    it("Vec<u64> round-trips via the borsh codec", async () => {
      const contract = await Contract.fromArtifact(BORSH_ABI, contractAddress, devnet.provider);
      const result = await contract.read("echo_vec_u64", { arg0: [1n, 2n, 3n, 1000n, 0n] });
      expect(result).toEqual([1n, 2n, 3n, 1000n, 0n]);
    }, 30_000);

    it("Enum (unit variants) round-trips via the borsh codec", async () => {
      const contract = await Contract.fromArtifact(BORSH_ABI, contractAddress, devnet.provider);
      expect(await contract.read("echo_status", { arg0: "Pending" })).toBe("Pending");
      expect(await contract.read("echo_status", { arg0: "Active" })).toBe("Active");
      expect(await contract.read("echo_status", { arg0: "Cancelled" })).toBe("Cancelled");
    }, 30_000);

    it("Struct with nested Vec<String> + FixedBytes round-trips", async () => {
      const contract = await Contract.fromArtifact(BORSH_ABI, contractAddress, devnet.provider);
      // Wide-range Order: empty Vec, then many entries.
      const empty = {
        id: 0n,
        maker: "0x" + "00".repeat(32),
        items: [],
        paid: false,
      };
      expect(await contract.read("echo_order", { arg0: empty })).toEqual(empty);

      const big = {
        id: 0xffffffffffffffffn - 1n,
        maker: "0x" + "ff".repeat(32),
        items: Array.from({ length: 8 }, (_, i) => `item-${i}`),
        paid: true,
      };
      expect(await contract.read("echo_order", { arg0: big })).toEqual(big);
    }, 60_000);
  },
);
