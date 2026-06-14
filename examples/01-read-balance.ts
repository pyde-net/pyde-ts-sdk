/**
 * Example 01: read a Pyde address's balance + account record.
 *
 * Run:
 *   npx tsx examples/01-read-balance.ts <address>
 *
 * Or against a local devnet (one of the prefunded accounts):
 *   pyde devnet                                  # in another terminal
 *   npx tsx examples/01-read-balance.ts 0x...    # use a prefunded addr
 */

import { Provider, formatQuanta, AccountType } from "../src/index";

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address) {
    console.error("usage: tsx examples/01-read-balance.ts <address>");
    process.exit(1);
  }

  const rpc = process.env.PYDE_RPC_URL ?? "http://127.0.0.1:8545";
  const provider = new Provider(rpc, { allowInsecureTransport: rpc.startsWith("http://") });

  const [balance, nonce, account] = await Promise.all([
    provider.getBalance(address),
    provider.getNonce(address),
    provider.getAccount(address),
  ]);

  console.log("address:    ", address);
  console.log("balance:    ", balance.toString(), "quanta");
  console.log("           =", formatQuanta(balance), "PYDE");
  console.log("nonce:      ", nonce);
  if (account) {
    const kind =
      account.accountType === AccountType.EOA
        ? "EOA"
        : account.accountType === AccountType.Contract
          ? "Contract"
          : "System";
    console.log("account:    ", kind);
    console.log("code hash:  ", account.codeHash);
    console.log("gas tank:   ", account.gasTank.toString(), "quanta");
  } else {
    console.log("account:     not registered on-chain");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
