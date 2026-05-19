/**
 * pyde-bombard — multi-laptop network stress tester.
 *
 * Connects to a remote Pyde node, auto-provisions sender wallets via
 * the public faucet, deploys (or accepts pre-deployed) the
 * Helper / MegaContract / Spawner suite, then runs a weighted 8-
 * bucket workload exercising the full smart-contract feature surface
 * (transfer, increment AOT hot-path, complex_logic with struct args,
 * change_status enum match, payable deposit, factory pattern via
 * deploy!, cross-contract ping, threshold-encrypted increment).
 *
 * Each laptop runs the script independently; the network sees the
 * aggregate load. Pre-deployed contract addresses can be passed in
 * via --mega/--helper/--spawner so the second laptop skips deploy.
 *
 * Usage:
 * cd suite && pyde-dev build && cd .. # compile contract artifacts
 * npx tsx bombard.ts \
 * --rpc-url http://testnet.example:8545 \
 * --faucet-url http://testnet.example:8080 \
 * --chain-id 7331 \
 * --duration-secs 600 --tps 10 --senders 50
 */

import * as fs from "fs";
import * as path from "path";
import {
  Provider,
  Wallet,
  generateKeypair,
  computeSelector,
  buildRawEncryptedTx,
  ReceiptUtils,
  type TxFields,
  type Keypair,
} from "../../src/index";

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

interface BombardConfig {
  rpcUrl: string;
  faucetUrl: string;
  chainId: number;
  durationSecs: number;
  tps: number;
  senders: number;
  encryptedPct: number;
  megaAddr?: string;
  helperAddr?: string;
  spawnerAddr?: string;
}

function parseArgs(): BombardConfig {
  const argv = process.argv.slice(2);
  const get = (flag: string, defaultVal?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : defaultVal;
  };
  const required = (flag: string): string => {
    const v = get(flag);
    if (!v) {
      console.error(`error: ${flag} is required`);
      process.exit(1);
    }
    return v;
  };

  const rpcUrl = required("--rpc-url");
  const faucetUrl = get("--faucet-url") ?? deriveFaucetUrl(rpcUrl);

  return {
    rpcUrl,
    faucetUrl,
    chainId: parseInt(get("--chain-id", "7331")!, 10),
    durationSecs: parseInt(get("--duration-secs", "600")!, 10),
    tps: parseInt(get("--tps", "10")!, 10),
    senders: parseInt(get("--senders", "50")!, 10),
    encryptedPct: parseInt(get("--encrypted-pct", "30")!, 10),
    megaAddr: get("--mega"),
    helperAddr: get("--helper"),
    spawnerAddr: get("--spawner"),
  };
}

function deriveFaucetUrl(rpcUrl: string): string {
  // Default `pyde faucet --port 8080` runs on the same host as the node.
  try {
    const u = new URL(rpcUrl);
    return `http://${u.hostname}:8080`;
  } catch {
    console.error(
      `error: could not derive faucet URL from --rpc-url=${rpcUrl}; ` +
        `pass --faucet-url explicitly`,
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────
// Workload buckets
// ─────────────────────────────────────────────────────────────────

type CallKind =
  | "transfer"
  | "increment"
  | "complex_logic"
  | "change_status"
  | "deposit"
  | "spawn"
  | "ping"
  | "encrypted_increment";

const DEFAULT_WEIGHTS: ReadonlyArray<readonly [CallKind, number]> = [
  ["transfer", 25],
  ["increment", 25],
  ["complex_logic", 10],
  ["change_status", 5],
  ["deposit", 10],
  ["spawn", 3],
  ["ping", 7],
  ["encrypted_increment", 15],
];

function pickKind(idx: number): CallKind {
  const total = DEFAULT_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = idx % total;
  for (const [k, w] of DEFAULT_WEIGHTS) {
    if (r < w) return k;
    r -= w;
  }
  return DEFAULT_WEIGHTS[0][0];
}

// ─────────────────────────────────────────────────────────────────
// Suite artifact loading
// ─────────────────────────────────────────────────────────────────

interface ContractArtifact {
  contractName: string;
  constructorBytecode: string; // 0x-prefixed hex
  deployedBytecode: string; // 0x-prefixed hex
  selectors: Record<string, string>;
}

function loadArtifact(name: string): ContractArtifact {
  const p = path.join(__dirname, "suite", "out", `${name}.json`);
  if (!fs.existsSync(p)) {
    console.error(
      `error: artifact ${p} not found — run \`cd suite && pyde-dev build\` first`,
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ContractArtifact;
}

/**
 * Build the on-chain deploy data field for a contract:
 * [clen:4 LE][rlen:4 LE][constructor_bytes][runtime_bytes][ctor_args]
 * Wire format matches `pyde_tx::pipeline`'s expected Deploy tx layout.
 */
function buildDeployData(
  artifact: ContractArtifact,
  ctorArgs: Uint8Array = new Uint8Array(0),
): string {
  const ctor = hexToBytes(artifact.constructorBytecode);
  const runtime = hexToBytes(artifact.deployedBytecode);
  const out = new Uint8Array(8 + ctor.length + runtime.length + ctorArgs.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, ctor.length, true /* littleEndian */);
  view.setUint32(4, runtime.length, true);
  out.set(ctor, 8);
  out.set(runtime, 8 + ctor.length);
  out.set(ctorArgs, 8 + ctor.length + runtime.length);
  return "0x" + bytesToHex(out);
}

// ─────────────────────────────────────────────────────────────────
// Hex / byte helpers
// ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Convert a method name to the 4-byte selector layout the PVM
 * dispatch table expects: FNV-1a-32 hashed, big-endian. The SDK
 * exposes `computeSelector` returning a u32; we encode it here.
 */
function selectorBytes(name: string): Uint8Array {
  const u32 = computeSelector(name) >>> 0; // unsigned u32
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, u32, false /* big-endian */);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Faucet HTTP
// ─────────────────────────────────────────────────────────────────

async function requestFaucetDrop(
  faucetUrl: string,
  addressHex: string,
): Promise<void> {
  const resp = await fetch(`${faucetUrl.replace(/\/$/, "")}/api/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: addressHex }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`faucet ${resp.status}: ${txt}`);
  }
}

async function waitForBalance(
  provider: Provider,
  addressHex: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bal = await provider.getBalance(addressHex);
    if (bal > 0n) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for balance on ${addressHex}`);
    }
    await sleep(250);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
// Wallet provisioning
// ─────────────────────────────────────────────────────────────────

interface SenderWallet {
  wallet: Wallet;
  keypair: Keypair; // kept so `buildRawEncryptedTx` can sign with the raw secret key
  nonce: number; // local counter; pre-seeded from chain after RegisterPubkey
}

async function setupWallets(
  provider: Provider,
  cfg: BombardConfig,
): Promise<SenderWallet[]> {
  const out: SenderWallet[] = [];
  // Generate N FALCON wallets locally, hit the faucet for each, wait
  // for the drop to commit, then submit RegisterPubkey. Per-drop
  // commit-wait is necessary because the faucet stamps each tx with
  // the chain-committed nonce; back-to-back faucet hits would all
  // see the same nonce and only the first would land (mempool dedup
  // rejects the rest as `duplicate (sender, nonce)`).
  for (let i = 0; i < cfg.senders; i++) {
    const kp = generateKeypair();
    const wallet = Wallet.fromKeys(kp.publicKey, kp.secretKey).connect(provider);

    process.stdout.write(` [${i + 1}/${cfg.senders}] funding...\r`);
    await requestFaucetDrop(cfg.faucetUrl, wallet.address);
    await waitForBalance(provider, wallet.address, 30_000);
    // Small post-commit pad: `getBalance(recipient) > 0` confirms the
    // funding tx committed, but the faucet's `getTransactionCount`
    // can briefly trail by a slot or two on the read path. Without
    // this delay, the next /api/request fires while the faucet's
    // chain-side nonce is still showing the pre-commit value, and
    // the new tx gets stamped with an already-consumed nonce →
    // `BelowWindow (got N, window [N+1..])`.
    await sleep(800);

    // RegisterPubkey: the SDK's `registerPubkey()` handles the
    // unsigned-tx encoding + /229 bootstrap details.
    await wallet.registerPubkey(provider);

    const nonce = await provider.getNonce(wallet.address);
    out.push({ wallet, keypair: kp, nonce });
  }
  process.stdout.write("\n");
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Contract deployment
// ─────────────────────────────────────────────────────────────────

interface Suite {
  helper: string;
  mega: string;
  spawner: string;
}

async function deploySuite(
  deployer: SenderWallet,
  provider: Provider,
): Promise<Suite> {
  const helperArt = loadArtifact("Helper");
  const megaArt = loadArtifact("MegaContract");
  const spawnerArt = loadArtifact("Spawner");

  console.log(" deploying Helper...");
  const helperReceipt = await deployer.wallet.deploy(
    provider,
    buildDeployData(helperArt),
    { gasLimit: 100_000_000 },
  );
  const helper = ReceiptUtils.contractAddress(helperReceipt);
  if (!helper) throw new Error("Helper deploy: no contract address in receipt");

  // MegaContract::init(initial: u64, helper: Address)
  const ctorArgs = new Uint8Array(8 + 32);
  new DataView(ctorArgs.buffer).setBigUint64(0, 0n, true);
  ctorArgs.set(hexToBytes(helper), 8);

  console.log(" deploying MegaContract...");
  const megaReceipt = await deployer.wallet.deploy(
    provider,
    buildDeployData(megaArt, ctorArgs),
    { gasLimit: 100_000_000 },
  );
  const mega = ReceiptUtils.contractAddress(megaReceipt);
  if (!mega) throw new Error("MegaContract deploy: no contract address");

  console.log(" deploying Spawner...");
  const spawnerReceipt = await deployer.wallet.deploy(
    provider,
    buildDeployData(spawnerArt),
    { gasLimit: 100_000_000 },
  );
  const spawner = ReceiptUtils.contractAddress(spawnerReceipt);
  if (!spawner) throw new Error("Spawner deploy: no contract address");

  // Refresh deployer's nonce — three deploys consumed three nonces.
  deployer.nonce = await provider.getNonce(deployer.wallet.address);

  return { helper, mega, spawner };
}

// ─────────────────────────────────────────────────────────────────
// Workload submit
// ─────────────────────────────────────────────────────────────────

async function submitOne(
  sw: SenderWallet,
  kind: CallKind,
  suite: Suite,
  cfg: BombardConfig,
  thresholdPk: string,
  provider: Provider,
): Promise<string> {
  const nonce = sw.nonce++;
  const addr = sw.wallet.address;
  const ZERO_ADDR = "0x" + "00".repeat(32);

  if (kind === "encrypted_increment") {
    // Threshold-encrypted variant of `increment`. The wire envelope
    // is built by `buildRawEncryptedTx` (encryption + FALCON-sign);
    // submitted via `pyde_sendRawEncryptedTransaction`.
    const data = "0x" + bytesToHex(selectorBytes("increment"));
    const rawHex = buildRawEncryptedTx(
      {
        thresholdPk,
        sender: addr,
        nonce,
        gasLimit: 150_000,
        accessList: [{ address: suite.mega, reads: [], writes: [] }],
        chainId: cfg.chainId,
        to: suite.mega,
        value: "0",
        calldata: data,
      },
      sw.keypair.secretKey,
    );
    const encResp = await provider.sendRawEncryptedTransaction(rawHex);
    return encResp.hash;
  }

  let to = ZERO_ADDR;
  let dataBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let value = "0";
  let gasLimit = 150_000;

  switch (kind) {
    case "transfer":
      to = "0x" + "42".repeat(32); // arbitrary recipient — pure transfer
      value = "1";
      break;
    case "increment":
      to = suite.mega;
      dataBytes = selectorBytes("increment");
      break;
    case "complex_logic": {
      to = suite.mega;
      // complex_logic(data: UserData) — UserData = (u256 amount, u64 score)
      const sel = selectorBytes("complex_logic");
      const amt = new Uint8Array(32);
      new DataView(amt.buffer).setBigUint64(0, 1000n, true);
      const score = new Uint8Array(8);
      new DataView(score.buffer).setBigUint64(0, BigInt(nonce % 100), true);
      dataBytes = concatBytes(sel, amt, score);
      break;
    }
    case "change_status": {
      to = suite.mega;
      const sel = selectorBytes("change_status");
      const tag = new Uint8Array(8);
      new DataView(tag.buffer).setBigUint64(0, BigInt(nonce % 3), true);
      dataBytes = concatBytes(sel, tag);
      break;
    }
    case "deposit":
      to = suite.mega;
      dataBytes = selectorBytes("deposit");
      value = "100"; // payable, send 100 quanta
      break;
    case "spawn":
      to = suite.spawner;
      dataBytes = selectorBytes("spawn");
      gasLimit = 500_000; // deploy! is heavy
      break;
    case "ping":
      to = suite.helper;
      dataBytes = selectorBytes("ping");
      break;
  }

  const accessList =
    to !== ZERO_ADDR && to !== "0x" + "42".repeat(32)
      ? [{ address: to, reads: [], writes: [] }]
      : undefined;

  const tx: TxFields = {
    from: addr,
    to,
    value,
    data: "0x" + bytesToHex(dataBytes),
    gasLimit,
    nonce,
    chainId: cfg.chainId,
    txType: 0, // Standard
    ...(accessList ? { accessList } : {}),
  };
  const signedHex = sw.wallet.signTransaction(tx);
  const resp = await provider.sendRawTransaction(signedHex);
  return resp.hash;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Workload loop
// ─────────────────────────────────────────────────────────────────

interface BucketStats {
  ok: number;
  err: number;
  /** tx hashes from successful submissions — kept so we can later
   * ask the chain which ones actually committed + executed. */
  hashes: string[];
}

async function runWorkload(
  wallets: SenderWallet[],
  suite: Suite,
  cfg: BombardConfig,
  thresholdPk: string,
  provider: Provider,
): Promise<Map<CallKind, BucketStats>> {
  const stats = new Map<CallKind, BucketStats>();
  for (const [k] of DEFAULT_WEIGHTS) stats.set(k, { ok: 0, err: 0, hashes: [] });

  const intervalMs = 1000 / Math.max(cfg.tps, 1);
  const start = Date.now();
  const endAt = start + cfg.durationSecs * 1000;
  let idx = 0;
  let lastLog = start;

  const inFlight: Promise<void>[] = [];

  while (Date.now() < endAt) {
    const kind = pickKind(idx);
    const sw = wallets[idx % wallets.length];

    inFlight.push(
      submitOne(sw, kind, suite, cfg, thresholdPk, provider)
        .then((hash) => {
          const s = stats.get(kind)!;
          s.ok++;
          s.hashes.push(hash);
        })
        .catch(() => {
          stats.get(kind)!.err++;
        }),
    );

    idx++;
    await sleep(intervalMs);

    if (Date.now() - lastLog > 60_000) {
      const elapsedMin = (Date.now() - start) / 60_000;
      let totalOk = 0;
      let totalErr = 0;
      for (const s of stats.values()) {
        totalOk += s.ok;
        totalErr += s.err;
      }
      console.log(
        ` [+${elapsedMin.toFixed(1)} min] submitted: ${totalOk} ok / ${totalErr} err`,
      );
      lastLog = Date.now();
    }
  }

  // Best-effort drain of in-flight requests with a short tail timeout
  // so we don't hang forever if the network is degraded.
  await Promise.race([Promise.allSettled(inFlight), sleep(15_000)]);

  return stats;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

async function fetchThresholdPk(provider: Provider): Promise<string> {
  // The SDK doesn't expose a typed wrapper for
  // `pyde_getThresholdPublicKey`, so call through Provider's
  // generic `rpc` method. Cast through `any` is local + scoped.
  const result = await (provider as unknown as {
    rpc: (m: string, p: unknown[]) => Promise<unknown>;
  }).rpc("pyde_getThresholdPublicKey", []);
  if (typeof result !== "string") {
    throw new Error("threshold-pubkey RPC returned non-string result");
  }
  return result.startsWith("0x") ? result : "0x" + result;
}

async function main() {
  const cfg = parseArgs();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║ Pyde Network Bombard (TS) ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(` RPC: ${cfg.rpcUrl}`);
  console.log(` Faucet: ${cfg.faucetUrl}`);
  console.log(` Chain ID: ${cfg.chainId}`);
  console.log(
    ` Duration: ${cfg.durationSecs}s (${(cfg.durationSecs / 60).toFixed(1)} min)`,
  );
  console.log(` Target TPS: ${cfg.tps}`);
  console.log(` Senders: ${cfg.senders}`);
  console.log(` Encrypted %: ${cfg.encryptedPct}`);
  const preDeployed = !!(cfg.megaAddr && cfg.helperAddr && cfg.spawnerAddr);
  console.log(
    ` Deploy: ${preDeployed ? "skipped (pre-deployed)" : "Helper + MegaContract + Spawner"}`,
  );
  console.log("╚══════════════════════════════════════════════════════════╝");

  const provider = new Provider(cfg.rpcUrl);

  // Verify chain_id matches what the operator expects. Bail loud
  // rather than spend minutes funding wallets on the wrong network.
  const reported = await provider.getChainId();
  if (reported !== cfg.chainId) {
    console.error(
      `error: chain_id mismatch — --chain-id=${cfg.chainId} but node at ${cfg.rpcUrl} reports ${reported}`,
    );
    process.exit(1);
  }
  console.log(`\n[1/4] RPC reachable, chain_id=${reported} matches.`);

  console.log(
    `\n[2/4] Provisioning ${cfg.senders} sender wallets via faucet...`,
  );
  const wallets = await setupWallets(provider, cfg);
  console.log(` ${wallets.length} wallets funded + registered.`);

  let suite: Suite;
  if (preDeployed) {
    suite = {
      helper: cfg.helperAddr!,
      mega: cfg.megaAddr!,
      spawner: cfg.spawnerAddr!,
    };
  } else {
    console.log("\n[3/4] Deploying contract suite...");
    suite = await deploySuite(wallets[0], provider);
  }
  console.log(` Helper: ${suite.helper}`);
  console.log(` MegaContract: ${suite.mega}`);
  console.log(` Spawner: ${suite.spawner}`);

  // Re-seed nonces — deploys consumed wallet[0]'s; encrypted-tx path
  // also needs the threshold pubkey.
  for (const sw of wallets) {
    sw.nonce = await provider.getNonce(sw.wallet.address);
  }
  const thresholdPk = await fetchThresholdPk(provider);

  console.log(
    `\n[4/4] Running workload: ${cfg.tps} TPS for ${cfg.durationSecs}s (${(cfg.durationSecs / 60).toFixed(1)} min)...`,
  );
  const t0 = Date.now();
  const stats = await runWorkload(wallets, suite, cfg, thresholdPk, provider);
  const elapsed = (Date.now() - t0) / 1000;

  let totalOk = 0;
  let totalErr = 0;
  for (const s of stats.values()) {
    totalOk += s.ok;
    totalErr += s.err;
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ RESULTS ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(
    ` Total submitted: ${totalOk} (${(totalOk / elapsed).toFixed(0)} TPS over ${(elapsed / 60).toFixed(1)} min)`,
  );
  console.log(` Submit errors: ${totalErr}`);
  console.log();
  console.log(" Per-bucket totals (submission-side):");
  for (const [kind] of DEFAULT_WEIGHTS) {
    const s = stats.get(kind)!;
    console.log(
      ` ${kind.padStart(22)}: ok=${String(s.ok).padEnd(7)} err=${s.err}`,
    );
  }
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ── Execution-side verification ────────────────────────────────
  //
  // `ok` above only proves the txs were ACCEPTED at ingress. It says
  // nothing about whether the dispatch found the right method, the
  // call executed without revert, or the state actually changed.
  // Read the corresponding view methods and compare against expected
  // counts derived from the submission stats.
  //
  // Polling rather than a fixed-duration sleep: encrypted-tx
  // submissions go through threshold-share collection + decryption
  // before they reach execution, which takes several slots; plain
  // txs commit faster. We watch the three view-method counters until
  // they all match the expected submission totals OR we hit a 120s
  // deadline. If the chain is healthy and every accepted tx ran,
  // we get a clean ✓ in well under the deadline.
  console.log("\n Polling chain state for execution match (≤120s)...");

  const expectedCounter =
    BigInt(stats.get("increment")!.ok) +
    BigInt(stats.get("encrypted_increment")!.ok);
  const expectedHelper = BigInt(stats.get("ping")!.ok);
  const expectedSpawner = BigInt(stats.get("spawn")!.ok);

  const verifyDeadline = Date.now() + 120_000;
  let counter = 0n;
  let helperCount = 0n;
  let spawnerCount = 0n;
  let matched = false;

  while (Date.now() < verifyDeadline) {
    counter = await callAndDecodeU64(provider, suite.mega, "get_counter");
    helperCount = await callAndDecodeU64(provider, suite.helper, "get_count");
    spawnerCount = await callAndDecodeU64(provider, suite.spawner, "get_count");
    if (
      counter === expectedCounter &&
      helperCount === expectedHelper &&
      spawnerCount === expectedSpawner
    ) {
      matched = true;
      break;
    }
    await sleep(3000);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ EXECUTION VERIFICATION ║");
  console.log("╠══════════════════════════════════════════════════════════╣");

  const rowOk = (label: string, expected: bigint, actual: bigint): boolean => {
    const ok = expected === actual;
    const status = ok ? "✓" : "✗";
    console.log(
      ` ${status} ${label.padEnd(40)} expected=${expected} actual=${actual}`,
    );
    return ok;
  };

  let allMatched = true;
  allMatched =
    rowOk("MegaContract.get_counter()", expectedCounter, counter) && allMatched;
  allMatched =
    rowOk("Helper.get_count()", expectedHelper, helperCount) && allMatched;
  allMatched =
    rowOk("Spawner.get_count()", expectedSpawner, spawnerCount) && allMatched;

  console.log("╚══════════════════════════════════════════════════════════╝");

  if (allMatched) {
    console.log(
      "\n ✓ EXECUTION VERIFIED — every accepted tx actually executed on chain.",
    );
  } else {
    console.log(
      "\n ✗ EXECUTION MISMATCH (after 120s polling) — some accepted txs did not commit / dispatched to the wrong method / reverted.",
    );
    console.log(
      " The submission-side `ok` count is therefore an UPPER BOUND on real chain throughput.",
    );
    process.exitCode = 2;
  }
  if (!matched) {
    // Only meaningful when the loop exited via deadline — preserves
    // the diagnostic above.
  }

  // ── Per-tx outcome classification ──────────────────────────────
  //
  // The view-method totals tell us how many state-changing calls
  // landed but say nothing about the SHAPE of the gap. Walk every
  // submitted tx hash and ask the chain for its receipt:
  //
  // - Receipt with success=true → committed and executed cleanly
  // - Receipt with success=false → committed but reverted
  // (out-of-gas, internal assert)
  // - No receipt (404) → never made it into a block
  // (mempool eviction, decryption
  // failure, nonce-gap orphan, etc.)
  //
  // The breakdown narrows the next investigation: a heavy "no
  // receipt" weight points at the mempool / encrypted-tx pipeline;
  // heavy reverts point at gas / contract logic.
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║ PER-TX OUTCOME CLASSIFICATION ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(
    ` ${"bucket".padEnd(22)} submit exec revert dropped`,
  );
  console.log(" ──────────────────────────────────────────────────────────");

  type Outcome = "exec" | "revert" | "dropped";
  const classify = async (hash: string): Promise<Outcome> => {
    try {
      const r: unknown = await (provider as unknown as {
        rpc: (m: string, p: unknown[]) => Promise<unknown>;
      }).rpc("pyde_getTransactionReceipt", [hash]);
      if (!r || typeof r !== "object") return "dropped";
      const receipt = r as { success?: boolean };
      if (receipt.success === true) return "exec";
      if (receipt.success === false) return "revert";
      return "dropped";
    } catch {
      return "dropped";
    }
  };

  let totalExec = 0;
  let totalRevert = 0;
  let totalDropped = 0;
  for (const [kind] of DEFAULT_WEIGHTS) {
    const s = stats.get(kind)!;
    let exec = 0;
    let revert = 0;
    let dropped = 0;
    // Cap concurrent receipt queries so we don't slam the RPC.
    const batch = 8;
    for (let i = 0; i < s.hashes.length; i += batch) {
      const slice = s.hashes.slice(i, i + batch);
      const outcomes = await Promise.all(slice.map(classify));
      for (const o of outcomes) {
        if (o === "exec") exec++;
        else if (o === "revert") revert++;
        else dropped++;
      }
    }
    totalExec += exec;
    totalRevert += revert;
    totalDropped += dropped;
    console.log(
      ` ${kind.padEnd(22)} ${String(s.ok).padEnd(6)} ${String(exec).padEnd(4)} ${String(revert).padEnd(6)} ${dropped}`,
    );
  }
  console.log(" ──────────────────────────────────────────────────────────");
  console.log(
    ` ${"TOTAL".padEnd(22)} ${String(totalOk).padEnd(6)} ${String(totalExec).padEnd(4)} ${String(totalRevert).padEnd(6)} ${totalDropped}`,
  );
  console.log("╚══════════════════════════════════════════════════════════╝");
}

/**
 * Call a no-arg view method via `pyde_call` and decode the first 8
 * bytes of the return as u64 (LE — matches the otic codegen ABI for
 * primitive returns).
 */
async function callAndDecodeU64(
  provider: Provider,
  to: string,
  methodName: string,
): Promise<bigint> {
  const data = "0x" + bytesToHex(selectorBytes(methodName));
  const ret = await provider.call(to, data);
  const buf = hexToBytes(ret);
  if (buf.length < 8) return 0n;
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(
    0,
    true,
  );
}

main().catch((err) => {
  console.error("bombard error:", err.message ?? err);
  process.exit(1);
});
