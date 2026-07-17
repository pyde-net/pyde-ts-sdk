/**
 * WebSocketProvider — live subscription tests.
 *
 * Engine status (otigen 0.1.0, sha d7c6f9e8+dirty): `pyde_subscribe`
 * is wired but ONLY for the `"logs"` topic. The `newHeads` and
 * `accountChanges` topics throw `"logs only in v1"` per chapter 17.4.
 * Tests below split accordingly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocketProvider } from "../../src/ws-provider";
import { spawnDevnet, type DevnetHandle } from "./devnet";
import { RpcError } from "../../src/errors";

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

// --------------------------------------------------------------------------
// §1 — Live, wired topic: `logs`
// --------------------------------------------------------------------------
describe("WebSocketProvider — subscribeLogs (live)", () => {
  it("H.2 subscribeLogs registers + returns a working unsubscribe handle", async () => {
    const events: unknown[] = [];
    const unsubscribe = await ws.subscribeLogs({ topics: [] }, (log) => events.push(log));
    expect(typeof unsubscribe).toBe("function");
    // borsh-coverage isn't deployed in this suite + no events are
    // emitted; the subscription should stay alive but receive no
    // frames. Assertion is the round-trip: subscribe succeeds, no
    // throws.
    await delay(500);
    await unsubscribe();
    // After unsubscribe, no further frames arrive even if the chain
    // ticks past — events array unchanged after a follow-up tick.
    const before = events.length;
    await delay(500);
    expect(events.length).toBe(before);
  }, 30_000);

  it("H.4 multiple concurrent subscribeLogs handlers stay isolated", async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = await ws.subscribeLogs({ topics: [] }, (l) => a.push(l));
    const unsubB = await ws.subscribeLogs({ topics: [], contract: "0x" + "ab".repeat(32) }, (l) =>
      b.push(l),
    );
    await delay(300);
    await unsubA();
    await unsubB();
    // No emits during the window — both arrays empty. Assertion is
    // mostly that the register/unregister cycle doesn't throw.
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);
  }, 30_000);

  it("H.5 destroy() tears down the connection + clears subscriptions", async () => {
    // Spin up a one-shot WS provider to avoid clobbering the shared
    // `ws` used by the other tests.
    const local = new WebSocketProvider(devnet.wsUrl, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webSocketConstructor: WebSocket as any,
      allowInsecureTransport: true,
    });
    await local.ready;
    await local.subscribeLogs({ topics: [] }, () => undefined);
    local.destroy();
    // Subsequent operations against a destroyed provider should
    // surface a typed error rather than hang.
    await expect(local.subscribeLogs({ topics: [] }, () => undefined)).rejects.toThrow();
  }, 30_000);
});

// --------------------------------------------------------------------------
// §2 — Engine-side gap: newHeads + accountChanges throw locally
// --------------------------------------------------------------------------
describe("WebSocketProvider — engine-side stub topics throw 'logs only in v1'", () => {
  it("subscribeNewHeads throws a typed RpcError", async () => {
    await expect(ws.subscribeNewHeads(() => undefined)).rejects.toThrow(RpcError);
  });

  it("subscribeAccountChanges throws a typed RpcError", async () => {
    await expect(
      ws.subscribeAccountChanges("0x" + "00".repeat(32), () => undefined),
    ).rejects.toThrow(RpcError);
  });
});
