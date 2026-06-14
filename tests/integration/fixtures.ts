/**
 * Test fixtures — funded wallet provisioning.
 *
 * Funding path: re-derive the devnet's i-th prefunded account
 * locally via the same seed the engine uses
 * (`Blake3("pyde-devnet-v1/" || i.to_le_bytes())`), then transfer
 * PYDE from it to the SDK-generated test wallet via a plain signed
 * `Standard` tx.
 *
 * No otigen CLI in the path — `keypairFromSeed` + the SDK's signing
 * surface is enough. Makes the live test self-contained.
 */

import { blake3 } from "@noble/hashes/blake3";

import { Wallet } from "../../src/wallet";
import { keypairFromSeed } from "../../src/crypto";
import { Provider } from "../../src/provider";

/** Devnet-i secret derivation. Matches engine's `devnet_secret(i)`
 *  in `engine/crates/node/src/devnet/runner.rs`. */
function devnetSeed(index: number): Uint8Array {
  const prefix = new TextEncoder().encode("pyde-devnet-v1/");
  const idx = new Uint8Array(8); // u64 LE
  new DataView(idx.buffer).setBigUint64(0, BigInt(index), true);
  const input = new Uint8Array(prefix.length + idx.length);
  input.set(prefix, 0);
  input.set(idx, prefix.length);
  return blake3(input);
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Build a hex-backed Wallet matching `devnet-i` — same keypair the
 *  engine pre-funds at genesis. */
export function devnetWallet(index: number, provider: Provider): Wallet {
  const seed = devnetSeed(index);
  const kp = keypairFromSeed(bytesToHex(seed));
  const w = Wallet.fromKeys(kp.publicKey, kp.secretKey);
  w.connect(provider);
  return w;
}

/**
 * Generate a fresh handle-backed SDK wallet + fund it from devnet-i.
 * Returns the wallet bound to the provided provider.
 */
export async function fundedTestWallet(
  provider: Provider,
  options?: { amountPyde?: number; senderIndex?: number },
): Promise<Wallet> {
  const sender = devnetWallet(options?.senderIndex ?? 0, provider);

  const wallet = Wallet.generate();
  wallet.connect(provider);

  // Devnet prefunded accounts boot with `auth_keys: Single(fpk)` per
  // `apply_prefund` in the engine's devnet runner — so the sender can
  // send Standard txs immediately and calling `registerPubkey` on it
  // would revert (AuthKeys::None is required by the handler).

  // Pre-fund the SDK wallet so it can pay gas for its own
  // registerPubkey. Use Standard tx to push value to the unfunded EOA.
  const amount = String((options?.amountPyde ?? 100) * 1_000_000_000);
  // Step 1 — fund the SDK address.
  let fundReceipt;
  try {
    fundReceipt = await sender.transfer(wallet.address, BigInt(amount));
  } catch (e) {
    throw new Error(
      `fundedTestWallet: transfer threw — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!fundReceipt.success) {
    throw new Error(`fundedTestWallet: pre-fund transfer failed: ${fundReceipt.txHash}`);
  }

  // Wait briefly so the fund-tx commit fully settles before we try
  // to read the funded recipient's state in the next tx's handler.
  await new Promise((r) => setTimeout(r, 500));

  // Step 2 — register the SDK wallet's pubkey on-chain so its signed txs verify.
  let regReceipt;
  try {
    regReceipt = await wallet.registerPubkey();
  } catch (e) {
    throw new Error(
      `fundedTestWallet: registerPubkey threw — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!regReceipt.success) {
    throw new Error(`fundedTestWallet: registerPubkey failed: ${regReceipt.txHash}`);
  }

  // Sender's hex SK lives in this process — wipe before returning.
  sender.destroy();
  return wallet;
}
