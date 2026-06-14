/**
 * Example 03: live event indexer using the WebSocket provider.
 *
 * Subscribes to all events matching a topic filter and prints each event
 * as it arrives. Demonstrates the at-least-once delivery + cursor-based
 * resume that HOST_FN_ABI §15.5 guarantees.
 *
 * Run:
 *   pyde devnet                          # terminal 1
 *   npx tsx examples/03-event-indexer.ts # terminal 2
 *   # interact with a contract from another shell to see events flow.
 */

import { WebSocketProvider } from "../src/index";

async function main(): Promise<void> {
  const wsUrl = process.env.PYDE_WS_URL ?? "ws://127.0.0.1:8546";
  const ws = new WebSocketProvider(wsUrl, {
    allowInsecureTransport: wsUrl.startsWith("ws://"),
  });
  await ws.ready;

  // Match every event by leaving topics empty. In production indexers,
  // narrow the filter (positional 4-slot topics + optional contract).
  const unsubscribe = await ws.subscribeLogs({}, (log) => {
    console.log(
      `wave=${log.waveId} tx=${log.txIndex} ev=${log.eventIndex} ` +
        `contract=${log.contract.slice(0, 10)}... topics=${log.topics.length}`,
    );
  });

  console.log("listening — Ctrl-C to exit");
  process.on("SIGINT", async () => {
    await unsubscribe();
    ws.destroy();
    process.exit(0);
  });

  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
