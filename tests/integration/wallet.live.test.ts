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
import { Wallet } from "../../src/wallet";

let devnet: DevnetHandle;

beforeAll(async () => {
  devnet = await spawnDevnet({ tickMs: 100 });
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

describe("Wallet — end-to-end live flow", () => {
  it("generate → fund → registerPubkey → transfer → balance check", async () => {
    // Fund a fresh test wallet with 3 PYDE out of devnet-0's generous
    // genesis prefund — enough headroom for the transfer + gas + the
    // post-tx balance check below.
    const sender = await fundedTestWallet(devnet.provider, { amountPyde: 3 });
    // Use a per-run recipient — a fixed address (e.g. 0xaa..aa) would
    // accumulate balance across re-runs that share devnet state and
    // break the exact-equality check below.
    const recipient = Wallet.generate();
    const recipientAddr = recipient.address;

    const balanceBefore = await sender.getBalance();
    expect(balanceBefore > 0n).toBe(true);

    const receipt = await sender.transfer(recipientAddr, parseQuanta("1"));
    expect(receipt.success).toBe(true);
    expect(receipt.txHash.length).toBeGreaterThan(2);

    const recipientBalance = await devnet.provider.getBalance(recipientAddr);
    expect(recipientBalance).toBe(parseQuanta("1"));
    recipient.destroy();

    const balanceAfter = await sender.getBalance();
    expect(balanceAfter < balanceBefore).toBe(true); // paid fee + value

    sender.destroy();
  }, 180_000);
});
