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
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Provider } from "../../src/provider";

// Pinned to 9933 because `otigen deploy` resolves its network URL from
// `otigen.toml`'s `[network.devnet]` which the example fixtures all
// pin to `http://localhost:9933`. Random-port would break the deploy
// path used by `contract.live` + `state-and-emit.live`. If a parallel
// `pyde validator` / `otigen devnet` is already on 9933, spawnDevnet
// will silently attach to it — kill the contender before running.
const DEFAULT_PORT = 9933;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
// otigen's HTTP server warms up its rate-limiter aggressively against
// burst clients — give it a moment before the first readiness probe.
const READY_INITIAL_DELAY_MS = 2_000;

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
      // otigen exposes the WS endpoint at /ws; bare host[:port] gets a
      // 405 (HTTP RPC POST endpoint). Append the path if not already
      // present.
      wsUrl: preExisting.replace("http", "ws").replace(/\/?$/, "/ws"),
      provider,
      chainId: opts?.chainId ?? 31337,
      stop: async () => {},
    };
  }

  const port = opts?.port ?? DEFAULT_PORT;
  const prefundCount = opts?.prefundCount ?? 10;
  const tickMs = opts?.tickMs ?? 100;
  const chainId = opts?.chainId ?? 31337;

  // otigen persists chain state under ~/.pyde/{blocks,data,state}.
  // Wipe it before spawning so deploys + name-registry land in a
  // clean state — without this, "name already registered" errors
  // cascade across test files because borsh-coverage stays on-chain
  // from previous runs. Leave `keystore.json` + `wallets/` alone;
  // those hold the otigen wallet keystore that `contract.live.test`
  // imports via `otigen wallet import --from-devnet`.
  const pydeRoot = join(homedir(), ".pyde");
  for (const dir of ["blocks", "data", "state", "explorer"]) {
    rmSync(join(pydeRoot, dir), { recursive: true, force: true });
  }

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
      "--quiet", // we don't read the banner; --quiet stops the wave-committer log spam
    ],
    // `ignore` rather than `pipe` so the child's stdio writes go straight
    // to /dev/null. Unread piped stdout/stderr fill the kernel buffer at
    // ~64 KB and then BLOCK the engine's logger, which manifests as the
    // devnet hanging mid-test.
    { stdio: ["ignore", "ignore", "ignore"] },
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
    // otigen exposes the WS endpoint at /ws.
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    provider,
    chainId,
    stop: () => stopProc(proc),
  };
}

async function waitForReady(provider: Provider): Promise<void> {
  // Initial settling delay: don't hammer otigen's HTTP server before
  // it's bound the port + warmed its rate-limiter. Burst probes get
  // 429-throttled and stretch readiness past the deadline; a single
  // 2s wait up front is cheaper.
  await delay(READY_INITIAL_DELAY_MS);
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
