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

// Skipped end-to-end while the engine catches up to chapter 17.4 RPC
// renames — `Wallet.registerPubkey` + `Wallet.transfer` both call
// `getNonceAndChainId` → `getNonce`, and the chain currently exposes
// neither `pyde_getNonce` nor the pre-pivot `pyde_getTransactionCount`.
// SDK code itself is spec-correct; unskip when the engine ships either
// name.
describe.skip("Wallet — end-to-end live flow (gated on engine getNonce)", () => {
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
