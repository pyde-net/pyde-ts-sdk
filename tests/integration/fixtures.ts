/**
 * Test fixtures — funded wallet provisioning + canonical contract paths.
 *
 * The devnet's pre-funded accounts are derived deterministically from
 * `Blake3("pyde-devnet-v1/" || i.to_le_bytes())`. Their addresses are
 * stable across runs but their FALCON signing keys live inside the
 * devnet process's keystore. To exercise the SDK's sign path we go via
 * the `otigen wallet --from-devnet` import flow + a CLI-driven transfer
 * to an SDK-generated test wallet:
 *
 *   1. (Once per session) `otigen wallet import --from-devnet` — adds
 *      `devnet-0`...`devnet-(N-1)` to `~/.pyde/keystore.json`.
 *   2. Generate a fresh SDK wallet (handle-based).
 *   3. Use `otigen` to send PYDE from `devnet-0` to the SDK wallet.
 *   4. Hand the funded SDK wallet to the test.
 *
 * The SDK keystore + otigen keystore use different AEADs (chacha vs
 * AES-GCM) so we can't load otigen's exported keystore directly. The
 * indirection through a real transfer mirrors how a dapp user would
 * acquire funds — closer to a real flow than direct keystore loading.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { Wallet } from "../../src/wallet";
import type { Provider } from "../../src/provider";

const exec = promisify(execFile);

const DEFAULT_PASSWORD = "integration-test-password";
const PYDE_NET_ROOT = resolve(__dirname, "../../..");

/**
 * Path to the canonical storage-stress contract bundle in the otigen
 * repo. Built via `otigen build` if absent.
 */
export const STORAGE_STRESS_BUNDLE = resolve(
  PYDE_NET_ROOT,
  "otigen/examples/storage-stress/artifacts/storage-stress.bundle",
);

export const STORAGE_STRESS_ABI_JSON = resolve(
  STORAGE_STRESS_BUNDLE,
  "storage-stress.abi.json",
);

/**
 * Bootstrap the otigen keystore with the devnet prefunded accounts.
 * Idempotent — subsequent calls are no-ops.
 */
export async function importDevnetWallets(): Promise<void> {
  try {
    await exec(
      "otigen",
      ["wallet", "import", "--from-devnet", "--password-stdin"],
      { input: DEFAULT_PASSWORD },
    );
  } catch (e) {
    // Already imported is fine; the otigen CLI is idempotent under the
    // hood but logs a warning. Surface anything else.
    const stderr = (e as { stderr?: string }).stderr ?? "";
    if (!/already/i.test(stderr)) {
      throw new Error(`otigen wallet import --from-devnet failed: ${stderr}`);
    }
  }
}

/**
 * Generate a fresh handle-backed SDK wallet + fund it from devnet-0.
 * Returns the wallet bound to the provided provider.
 */
export async function fundedTestWallet(
  provider: Provider,
  options?: { amountPyde?: number; senderKeystoreName?: string },
): Promise<Wallet> {
  const wallet = Wallet.generate();
  wallet.connect(provider);

  // First-time pubkey registration needs balance > 0; fund first.
  await importDevnetWallets();
  const amount = String((options?.amountPyde ?? 1000) * 1_000_000_000);
  const sender = options?.senderKeystoreName ?? "devnet-0";
  await exec(
    "otigen",
    [
      "wallet",
      "transfer",
      "--from",
      sender,
      "--to",
      wallet.address,
      "--amount",
      amount,
      "--password-stdin",
      "--network",
      "devnet",
    ],
    { input: DEFAULT_PASSWORD },
  ).catch(async () => {
    // `otigen wallet transfer` may not exist on all builds; fall back
    // to the explicit `otigen call` send-PYDE pattern.
    await exec(
      "otigen",
      [
        "call",
        "--contract",
        "0x" + "00".repeat(32), // value transfer target = zero address (Standard tx)
        "--function",
        "_transfer",
        "--from",
        sender,
        "--value",
        amount,
        "--password-stdin",
        "--network",
        "devnet",
      ],
      { input: DEFAULT_PASSWORD },
    ).catch(() => {
      // If both paths fail, surface a clear message — the test will
      // skip with this error.
      throw new Error(
        "could not fund test wallet via otigen CLI. Either `otigen wallet transfer` " +
          "or `otigen call --contract 0x000... --function _transfer` is expected to exist; " +
          "fall back to pre-funding via state injection.",
      );
    });
  });

  // Register the SDK wallet's pubkey on-chain so it can sign + send.
  await wallet.registerPubkey();
  return wallet;
}

/** Canonical devnet prefunded addresses (first 3). Useful as `to` in
 *  read-only assertions where we just need a known-funded account. */
export const PREFUNDED_ADDRESSES_HINT = [
  // Derived from Blake3("pyde-devnet-v1/" || u64_le(i)); read at runtime
  // via `provider.getAccount(banner_address)` if you need to verify the
  // exact bytes — they're stable across runs.
];
