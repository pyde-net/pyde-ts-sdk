/**
 * Example 02: generate a wallet, register its pubkey, and send a transfer.
 *
 * Assumes a local devnet is running and the wallet has been funded (e.g.,
 * by a faucet call out-of-band) before `registerPubkey` succeeds — see
 * Chapter 11 §11.8 RegisterPubkey: balance > 0 is required.
 *
 * Run:
 *   pyde devnet                                  # terminal 1
 *   # (fund the printed address from a prefunded account)
 *   npx tsx examples/02-send-transfer.ts         # terminal 2
 */

import { Provider, Wallet, parseQuanta, formatQuanta } from "../src/index";

async function main(): Promise<void> {
  const rpc = process.env.PYDE_RPC_URL ?? "http://127.0.0.1:8545";
  const provider = new Provider(rpc, { allowInsecureTransport: rpc.startsWith("http://") });

  // Hex-SK so we can persist later. For production, prefer Wallet.generate()
  // (handle-backed) and the keystore-encryption flow.
  const wallet = Wallet.generateUnsafe();
  wallet.connect(provider);

  console.log("generated address:", wallet.address);
  console.log("balance before:   ", formatQuanta(await wallet.getBalance()), "PYDE");
  console.log("→ fund this address from a prefunded devnet account, then press <enter>");
  await waitForKeypress();

  await wallet.registerPubkey();
  console.log("✓ pubkey registered");

  const recipient = process.env.RECIPIENT_ADDRESS ?? "0x" + "11".repeat(32);
  const amount = parseQuanta("0.1"); // 0.1 PYDE = 100,000,000 quanta

  const receipt = await wallet.transfer(recipient, amount);
  console.log("tx:    ", receipt.txHash);
  console.log("status:", receipt.success ? "success" : "reverted");
  console.log("gas:   ", parseInt(receipt.gasUsed.replace(/^0x/, ""), 16));
  console.log("balance after:    ", formatQuanta(await wallet.getBalance()), "PYDE");
}

function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
