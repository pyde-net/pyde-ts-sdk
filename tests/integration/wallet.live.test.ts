/**
 * Wallet — end-to-end live test.
 *
 * Funds an SDK-generated handle-backed wallet via the otigen CLI,
 * registers the pubkey on-chain, sends a native transfer, and verifies
 * receipt + post-tx balance. Exercises the canonical sign + send flow
 * for the recommended `Wallet.generate()` path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnDevnet, type DevnetHandle } from "./devnet";
import { fundedTestWallet } from "./fixtures";
import { parseQuanta } from "../../src/units";

let devnet: DevnetHandle;

beforeAll(async () => {
  devnet = await spawnDevnet({ tickMs: 100 });
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

// Blocked on funding-path tooling, NOT on the SDK code:
//   - `otigen wallet transfer` doesn't exist; `otigen call` requires a
//     deployed contract target and rejects the zero-address.
//   - `pyde-crypto-wasm` exposes no `keypairFromSeed` so the SDK can't
//     re-derive the devnet prefunded keys locally either.
// The SDK code itself (registerPubkey, sign, sendRawTransaction) is
// spec-correct against the engine's current RPC surface. Un-skip when
// either of those two surfaces lands.
describe.skip("Wallet — end-to-end live flow (gated on funding path)", () => {
  it("generate → fund → registerPubkey → transfer → balance check", async () => {
    const sender = await fundedTestWallet(devnet.provider, { amountPyde: 100 });
    const recipient = "0x" + "aa".repeat(32);

    const balanceBefore = await sender.getBalance();
    expect(balanceBefore > 0n).toBe(true);

    const receipt = await sender.transfer(recipient, parseQuanta("1"));
    expect(receipt.success).toBe(true);
    expect(receipt.txHash.length).toBeGreaterThan(2);

    const recipientBalance = await devnet.provider.getBalance(recipient);
    expect(recipientBalance).toBe(parseQuanta("1"));

    const balanceAfter = await sender.getBalance();
    expect(balanceAfter < balanceBefore).toBe(true); // paid fee + value
  }, 120_000);
});
