/**
 * Devnet lifecycle helper for integration tests.
 *
 * Spawns `otigen devnet` with deterministic genesis pre-fund, waits
 * for the JSON-RPC endpoint to be responsive, hands the URL to the
 * test, and tears the process down on cleanup.
 *
 * Pre-existing devnet: set `PYDE_DEVNET_URL` to skip the spawn and
 * run against an already-running node (useful when iterating locally
 * via `otigen devnet --rpc-listen 127.0.0.1:9933` in another shell).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { Provider } from "../../src/provider";

const DEFAULT_PORT = 9933;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;

export interface DevnetHandle {
  /** HTTP RPC URL (e.g. `http://127.0.0.1:9933`). */
  rpcUrl: string;
  /** WebSocket URL — same host:port as HTTP under `otigen devnet`. */
  wsUrl: string;
  /** Provider already connected to the devnet. */
  provider: Provider;
  /** Chain ID the devnet signs against (default 31337). */
  chainId: number;
  /** Stop the devnet (no-op if attached to a pre-existing one). */
  stop(): Promise<void>;
}

/** Spawn a devnet. The returned handle MUST be stopped (call .stop()
 *  in a vitest `afterAll`). */
export async function spawnDevnet(opts?: {
  port?: number;
  prefundCount?: number;
  tickMs?: number;
  chainId?: number;
}): Promise<DevnetHandle> {
  // Attach to a pre-existing devnet when PYDE_DEVNET_URL is set.
  const preExisting = process.env.PYDE_DEVNET_URL;
  if (preExisting) {
    const provider = new Provider(preExisting, { allowInsecureTransport: true });
    await waitForReady(provider);
    return {
      rpcUrl: preExisting,
      wsUrl: preExisting.replace("http", "ws"),
      provider,
      chainId: opts?.chainId ?? 31337,
      stop: async () => {},
    };
  }

  const port = opts?.port ?? DEFAULT_PORT;
  const prefundCount = opts?.prefundCount ?? 10;
  const tickMs = opts?.tickMs ?? 100;
  const chainId = opts?.chainId ?? 31337;

  const proc = spawn(
    "otigen",
    [
      "devnet",
      "--rpc-listen",
      `127.0.0.1:${port}`,
      "--prefund-count",
      String(prefundCount),
      "--tick-ms",
      String(tickMs),
      "--chain-id",
      String(chainId),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  proc.on("error", (e) => {
    // Surface spawn failures via the readiness loop's timeout.
    process.stderr.write(`devnet spawn error: ${e.message}\n`);
  });

  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new Provider(rpcUrl, { allowInsecureTransport: true });
  try {
    await waitForReady(provider);
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }

  return {
    rpcUrl,
    wsUrl: `ws://127.0.0.1:${port}`,
    provider,
    chainId,
    stop: () => stopProc(proc),
  };
}

async function waitForReady(provider: Provider): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await provider.getChainId();
      return;
    } catch (e) {
      lastError = e;
      await delay(READY_POLL_MS);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`devnet not ready within ${READY_TIMEOUT_MS}ms: ${reason}`);
}

function stopProc(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    // Safety net — escalate if SIGTERM doesn't take.
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 3_000);
  });
}
