/**
 * Built-dist runner mirror of 03-event-indexer.ts.
 *
 * Run:
 *   npm run build
 *   otigen devnet --rpc-listen 127.0.0.1:9933
 *   node --experimental-wasm-modules examples/03-event-indexer.mjs
 *   # interact with a contract from another shell to see events flow.
 *
 * Exit with Ctrl-C; an SDK-side `WebSocketProvider.destroy()` cleans up.
 */
import { WebSocketProvider } from "../dist/index.js";

const wsUrl = process.env.PYDE_WS_URL ?? "ws://127.0.0.1:9933/ws";
const ws = new WebSocketProvider(wsUrl, {
  allowInsecureTransport: wsUrl.startsWith("ws://"),
});
await ws.ready;

const unsubscribe = await ws.subscribeLogs({}, (log) => {
  console.log(
    `wave=${log.waveId} tx=${log.txIndex} ev=${log.eventIndex} ` +
      `contract=${log.contract.slice(0, 10)}... topics=${log.topics.length}`,
  );
});

console.log("listening at", wsUrl, "— Ctrl-C to exit");

process.on("SIGINT", async () => {
  await unsubscribe();
  ws.destroy();
  process.exit(0);
});

// Keep the process alive.
await new Promise(() => {});
