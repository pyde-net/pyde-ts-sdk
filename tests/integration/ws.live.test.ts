/**
 * WebSocketProvider — live subscription tests.
 *
 * Subscribes to newHeads, accumulates a few wave commits, and asserts
 * we got non-empty headers with cursor coordinates.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocketProvider } from "../../src/ws-provider";
import { spawnDevnet, type DevnetHandle } from "./devnet";

// Use the `ws` package as the WebSocket constructor under Node, since
// globalThis.WebSocket is not stable across Node 20 / 22.
import WebSocket from "ws";

let devnet: DevnetHandle;
let ws: WebSocketProvider;

beforeAll(async () => {
  devnet = await spawnDevnet({ tickMs: 100 });
  ws = new WebSocketProvider(devnet.wsUrl, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webSocketConstructor: WebSocket as any,
    allowInsecureTransport: true,
  });
  await ws.ready;
}, 60_000);

afterAll(async () => {
  ws?.destroy();
  await devnet?.stop();
});

// Skipped while the engine catches up to chapter 17.4 — the running
// devnet's WebSocket endpoint doesn't yet accept `pyde_subscribe`
// invocations from a vanilla WS client. SDK subscription mechanics are
// spec-correct; unskip when the engine ships `pyde_subscribe`.
describe.skip("WebSocketProvider — live subscriptions (gated on engine pyde_subscribe)", () => {
  it("subscribeNewHeads delivers at least one wave commit", async () => {
    const received: number[] = [];
    const unsubscribe = await ws.subscribeNewHeads((h) => {
      received.push(h.waveId);
    });
    // Wait long enough to span a couple of devnet ticks (100ms each).
    await delay(1_500);
    await unsubscribe();
    expect(received.length).toBeGreaterThan(0);
  });

  it("subscribeNewHeads handlers are isolated — destroy clears them", async () => {
    let calls = 0;
    await ws.subscribeNewHeads(() => {
      calls += 1;
    });
    await delay(500);
    const stableCount = calls;
    ws.destroy();
    await delay(300);
    expect(calls).toBe(stableCount); // no more notifications after destroy
  });
});
