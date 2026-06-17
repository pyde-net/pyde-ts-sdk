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

// Still engine-blocked as of 2026-06-17 against otigen `66db1755+dirty`:
// `RegisterPubkey` on a freshly-funded EOA reverts with full-gas-burn
// (`status=Reverted, gas_used=200000`) on devnet. The wave-application
// dispatcher recognises the tx kind (log: `kind=RegisterPubkey status=Reverted`),
// so the original "uncovered tx_type" framing is stale, but the actual
// production handler still rejects. Fund tx (Standard transfer) commits
// cleanly; only first-time pubkey installation is gated. Re-enable when
// either the devnet's RegisterPubkey handler accepts AuthKeys::None →
// AuthKeys::Single(fpk) transitions, or a multi-validator endpoint is
// available with the production handler reachable.
describe.skip("Wallet — end-to-end live flow (registerPubkey reverts on devnet)", () => {
  it("generate → fund → registerPubkey → transfer → balance check", async () => {
    // devnet prefund is 10 PYDE per account; ask for 3 so we have
    // headroom for the transfer + gas + post-tx balance check.
    const sender = await fundedTestWallet(devnet.provider, { amountPyde: 3 });
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

    sender.destroy();
  }, 180_000);
});
