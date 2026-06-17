/**
 * Wallet + encrypted keystore.
 *
 * Spec sources:
 *   - Chapter 8.2   — FALCON-512 signatures
 *   - Chapter 11    — account model, tx types, RegisterPubkey flow
 *   - Chapter 17    — `pyde keys generate` keystore format
 *                     (Argon2id KDF + ChaCha20-Poly1305 AEAD)
 *
 * Default signing path: handle-based. `Wallet.generate()` retains the
 * FALCON-512 secret key inside `pyde-crypto-wasm`'s WASM heap; the SK
 * bytes never enter the JS heap. Use `Wallet.generateUnsafe()` only
 * when you need the hex SK transiently to encrypt to a keystore.
 *
 * Crypto delegated to `pyde-crypto-wasm` (signing, address derivation)
 * and `@noble/hashes` + `@noble/ciphers` (keystore KDF + AEAD —
 * pure-JS, audited, isomorphic browser+Node).
 *
 * File I/O is opt-in via a dynamic Node `fs` import. The Wallet itself
 * is isomorphic; browser callers can use `fromEncrypted` / `toKeystore`
 * with their own storage layer.
 */

import { argon2id } from "@noble/hashes/argon2";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { utf8ToBytes } from "@noble/hashes/utils";

import { Provider } from "./provider";
import { AbstractSigner } from "./signer";
import * as crypto from "./crypto";
import type { AccessEntry, Receipt, TxFields } from "./types";
import { TxType } from "./types";
import { SigningError, WalletDestroyedError } from "./errors";

// ============================================================================
// Keystore format (matches `pyde keys generate`, per Chapter 17)
// ============================================================================

/** On-disk encrypted-keystore JSON shape.
 *  KDF: Argon2id. AEAD: ChaCha20-Poly1305. */
export interface Keystore {
  /** 32-byte address hex. */
  address: string;
  /** FALCON-512 public key hex (897 bytes). */
  publicKey: string;
  /** KDF identifier — `"argon2id"` in v1. */
  kdf: "argon2id";
  kdfParams: {
    /** Memory cost in KB (default 65,536 = 64 MiB). */
    m: number;
    /** Iterations (default 3). */
    t: number;
    /** Parallelism (default 4). */
    p: number;
    /** Salt hex (16 bytes). */
    salt: string;
  };
  /** Cipher identifier — `"chacha20-poly1305"` in v1. */
  cipher: "chacha20-poly1305";
  /** Cipher nonce hex (12 bytes). */
  nonce: string;
  /** Encrypted secret-key bytes (hex). Tag is appended; AEAD shape. */
  ciphertext: string;
  /** Schema version. */
  version: 1;
}

/** Default Argon2id parameters — ~250 ms on a modern laptop CPU
 *  (Chapter 17 `pyde keys generate` reference). */
const KDF_DEFAULTS = { m: 65_536, t: 3, p: 4 } as const;

const KDF_KEY_LEN = 32; // 256-bit key for ChaCha20-Poly1305
const SALT_LEN = 16;
const NONCE_LEN = 12;

// ============================================================================
// Wallet
// ============================================================================

/** Internal key-material discriminator — either a WASM-retained handle,
 *  an in-JS hex secret, or destroyed (post-destroy(); signing throws). */
type KeyMaterial = { handle: number } | { hex: string } | { destroyed: true };

/**
 * FALCON-512 wallet. Implements `AbstractSigner` so it can be passed
 * anywhere a signer is expected.
 *
 * Lifecycle:
 *   - `Wallet.generate()` (recommended) — handle-backed, SK in WASM heap.
 *   - `Wallet.generateUnsafe()` — hex SK in JS heap. Encrypt + drop.
 *   - `Wallet.fromKeys(pk, sk)` — restore from hex.
 *   - `Wallet.fromEncrypted(keystore, password)` — restore from keystore.
 *   - `Wallet.destroy()` — wipe + drop the WASM handle (for handle wallets).
 *
 * Provider:
 *   - `wallet.connect(provider)` — bind; downstream `transfer` / `sendCall`
 *     pull nonce + chainId from this provider.
 *   - `wallet.provider` accessor — throws if not bound.
 */
export class Wallet extends AbstractSigner {
  readonly address: string;
  readonly publicKey: string;
  private key: KeyMaterial;

  private constructor(address: string, publicKey: string, key: KeyMaterial) {
    super();
    this.address = address;
    this.publicKey = publicKey;
    this.key = key;
  }

  // ==========================================================================
  // Constructors
  // ==========================================================================

  /** Generate a new keypair, SK retained in the WASM heap. Recommended. */
  static generate(): Wallet {
    const kp = crypto.generateKeypairHandle();
    return new Wallet(kp.address, kp.publicKey, { handle: kp.handle });
  }

  /** Generate a new keypair with hex SK in the JS heap.
   *  ⚠️ Encrypt and discard the hex SK at the earliest opportunity. */
  static generateUnsafe(): Wallet {
    const kp = crypto.generateKeypair();
    return new Wallet(kp.address, kp.publicKey, { hex: kp.secretKey });
  }

  /** Restore from a hex public + hex secret key. */
  static fromKeys(publicKey: string, secretKey: string): Wallet {
    const address = crypto.deriveAddress(publicKey);
    return new Wallet(address, publicKey, { hex: secretKey });
  }

  /** Restore from an encrypted Keystore + password. The decrypted SK
   *  lives in the JS heap until `destroy()` is called. */
  static async fromEncrypted(keystore: Keystore, password: string): Promise<Wallet> {
    validateKeystore(keystore);
    const secret = await decryptKeystore(keystore, password);
    return new Wallet(keystore.address, keystore.publicKey, { hex: secret });
  }

  /** Node-only convenience: read a keystore JSON file from disk and decrypt. */
  static async fromKeystoreFile(path: string, password: string): Promise<Wallet> {
    const fs = await loadFsOrThrow("fromKeystoreFile");
    const content = fs.readFileSync(path, "utf-8");
    const keystore = JSON.parse(content) as Keystore;
    return Wallet.fromEncrypted(keystore, password);
  }

  // ==========================================================================
  // Keystore export
  // ==========================================================================

  /** Encrypt the wallet's SK with `password` and return the keystore.
   *  Throws on handle-only wallets (no hex SK to encrypt). */
  async toKeystore(password: string, params?: Partial<typeof KDF_DEFAULTS>): Promise<Keystore> {
    if ("destroyed" in this.key) throw new WalletDestroyedError();
    if (!("hex" in this.key)) {
      throw new SigningError(
        "Cannot export keystore from a handle-only wallet. Use Wallet.generateUnsafe() if you need a hex SK.",
      );
    }
    return encryptKeystore(this.address, this.publicKey, this.key.hex, password, params);
  }

  /** Node-only convenience: encrypt + write to disk with mode 0600. */
  async saveKeystoreFile(
    path: string,
    password: string,
    params?: Partial<typeof KDF_DEFAULTS>,
  ): Promise<void> {
    const fs = await loadFsOrThrow("saveKeystoreFile");
    const keystore = await this.toKeystore(password, params);
    fs.mkdirSync(dirnameOf(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(keystore, null, 2));
    try {
      fs.chmodSync(path, 0o600);
    } catch {
      // chmod fails on non-POSIX filesystems; ignore.
    }
  }

  // ==========================================================================
  // Signing — implements AbstractSigner
  // ==========================================================================

  /** Sign a transaction. Returns wire-encoded signed tx hex. */
  signTransaction(tx: TxFields): string {
    if ("destroyed" in this.key) throw new WalletDestroyedError();
    return "handle" in this.key
      ? crypto.signTransactionWithHandle(tx, this.key.handle)
      : crypto.signTransaction(tx, this.key.hex);
  }

  /** Sign an arbitrary message. Returns signature hex. */
  sign(messageHex: string): string {
    if ("destroyed" in this.key) throw new WalletDestroyedError();
    return "handle" in this.key
      ? crypto.signMessageWithHandle(this.key.handle, messageHex)
      : crypto.signMessage(this.key.hex, messageHex);
  }

  /** Compute tx hash without signing. */
  hashTransaction(tx: TxFields): string {
    return crypto.hashTransaction(tx);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Wipe + drop the WASM handle (handle wallets). Idempotent.
   *  For hex wallets, drops the SK reference so GC can reclaim — V8
   *  strings are immutable so the bytes themselves are not actively
   *  zeroized in JS heap. Production callers holding sensitive SK
   *  material should consider running in environments where the JS
   *  heap is isolated (worker / iframe). */
  destroy(): void {
    if ("handle" in this.key) {
      crypto.dropKeypair(this.key.handle);
    }
    // Mark destroyed — every signing method below checks this branch
    // first and throws WalletDestroyedError with a clear message.
    this.key = { destroyed: true };
  }

  // ==========================================================================
  // Provider-bound conveniences
  // ==========================================================================

  /** Register the FALCON pubkey on-chain. Required ONCE per address
   *  before any signed tx is accepted. Spec: Chapter 11 §11.8 RegisterPubkey. */
  async registerPubkey(provider?: Provider): Promise<Receipt> {
    const p = this.resolveProvider(provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const tx: TxFields = {
      from: this.address,
      to: ZERO_ADDR,
      value: "0",
      data: this.publicKey,
      // Engine floor is 21,000 (structural minimum). Pubkey
      // installation reads + writes the auth_keys slot + has per-byte
      // cost on the 897-byte FALCON pubkey carried in `data`. 200k
      // covers both with headroom on every reasonable base-fee.
      gasLimit: 200_000,
      nonce,
      chainId,
      txType: TxType.RegisterPubkey,
    };
    // RegisterPubkey carries no signature — pubkey ownership is proven
    // by the chain's `from == Poseidon2(data)` check.
    const wire = crypto.encodeRegisterPubkeyTx(tx);
    return p.sendAndWait(wire);
  }

  /** Build, sign, send a native PYDE transfer. v1 engine has no
   *  `pyde_estimateGas`; gas defaults to 100,000 (`data === "0x"`) or
   *  5,000,000 (calldata-bearing) — Tier-2 will route this through
   *  `pyde_simulateTransaction` with a `gasMultiplier` safety margin.
   *  Override with `opts.gasLimit` for tighter bounds today. */
  async transfer(
    to: string,
    amount: bigint | number,
    optsOrProvider?: Provider | { provider?: Provider; gasLimit?: number; gasMultiplier?: number },
  ): Promise<Receipt> {
    // Backward-compat: callers may pass `Provider` positionally.
    const opts =
      optsOrProvider instanceof Object && "getChainId" in optsOrProvider
        ? { provider: optsOrProvider as Provider }
        : ((optsOrProvider as
            | { provider?: Provider; gasLimit?: number; gasMultiplier?: number }
            | undefined) ?? {});
    const p = this.resolveProvider(opts.provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const gasLimit =
      opts.gasLimit ?? (await this.estimateGasFor(p, to, "0x", amount, opts.gasMultiplier));
    const tx: TxFields = {
      from: this.address,
      to,
      value: amount.toString(),
      data: "0x",
      gasLimit,
      nonce,
      chainId,
      // Standard (id 0) covers both transfers and contract calls per
      // Chapter 11 §11.8 — the chain dispatches on `to` + `data` shape.
      txType: TxType.Standard,
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  private async estimateGasFor(
    _p: Provider,
    _to: string,
    data: string,
    _value: bigint | number | string,
    _multiplier?: number,
  ): Promise<number> {
    // v1 engine has no dedicated `pyde_estimateGas`; gas inference is
    // queued behind a `pyde_simulateTransaction` wrapper (Tier-2
    // catalog alignment). Until then fall back to the same fixed
    // defaults the previous estimate-then-fallback path used: 100k
    // for plain transfers, 5M for calldata-bearing calls.
    return data === "0x" ? 100_000 : 5_000_000;
  }

  /** Build, sign, send a contract call. Auto-fetches an access list via
   *  `Provider.estimateAccess()`. Spec: Chapter 11 §11.8 (Standard). */
  async sendCall(
    to: string,
    data: string,
    opts?: {
      gasLimit?: number;
      gasMultiplier?: number;
      value?: bigint | number | string;
      accessList?: AccessEntry[];
      provider?: Provider;
    },
  ): Promise<Receipt> {
    const p = this.resolveProvider(opts?.provider);
    const value = opts?.value ?? 0;
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);

    // Sim-first when no explicit gasLimit + accessList — engine RPC
    // catalog v0.1 §12 surfaces gas + access-list together via
    // `pyde_simulateTransaction`. Fall back to fixed defaults on
    // simulate failure so the dapp still goes through (the chain
    // serialises against missing access lists, costing parallel
    // throughput but not correctness).
    let gasLimit = opts?.gasLimit;
    let accessList = opts?.accessList;
    if (gasLimit === undefined || accessList === undefined) {
      const simResult = await this.runSimulate(p, {
        from: this.address,
        to,
        value: value.toString(),
        data,
        gasLimit: 5_000_000,
        nonce,
        chainId,
        txType: TxType.Standard,
      });
      if (gasLimit === undefined) {
        gasLimit = simResult.gasLimit ?? 5_000_000;
        if (simResult.gasLimit !== undefined) {
          gasLimit = Math.ceil(gasLimit * (opts?.gasMultiplier ?? 1.2));
        }
      }
      if (accessList === undefined && simResult.accessList.length > 0) {
        accessList = simResult.accessList;
      }
    }

    const tx: TxFields = {
      from: this.address,
      to,
      value: value.toString(),
      data,
      gasLimit,
      nonce,
      chainId,
      txType: TxType.Standard,
      ...(accessList ? { accessList } : {}),
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  /** Sign a probe tx + ask the chain to simulate it. Returns the
   *  chain-reported gas + access list when the simulate succeeds; the
   *  callee uses fixed defaults on failure. */
  private async runSimulate(
    p: Provider,
    tx: TxFields,
  ): Promise<{ gasLimit: number | undefined; accessList: AccessEntry[] }> {
    try {
      const wire = this.signTransaction(tx);
      const sim = await p.simulateTransaction(wire);
      // The engine's simulator returns flat slot keys; bucket them into
      // the canonical engine shape: one AccessEntry per (address,
      // accessType). Slots only read → `read` entry; slots written
      // (or both read and written) → `readWrite` entry, so the admit
      // scheduler treats them as write-conflicting.
      const writeSet = new Set(sim.writes);
      const readOnly = sim.reads.filter((r) => !writeSet.has(r.slot)).map((r) => r.slot);
      const writes = sim.writes;
      const accessEntries: AccessEntry[] = [];
      if (readOnly.length > 0) {
        accessEntries.push({ address: tx.to, storageKeys: readOnly, accessType: "read" });
      }
      if (writes.length > 0) {
        accessEntries.push({ address: tx.to, storageKeys: writes, accessType: "readWrite" });
      }
      return {
        gasLimit: sim.receipt ? Number(sim.receipt.gasUsed) : undefined,
        accessList: accessEntries,
      };
    } catch {
      // Engine missing the method, returned an error, or sim throws on
      // its own — degrade silently to defaults.
      return { gasLimit: undefined, accessList: [] };
    }
  }

  /** Build, sign, send a contract deploy. Spec: Chapter 11 §11.8 (Deploy). */
  async deploy(
    deployData: string,
    opts?: { gasLimit?: number; value?: bigint | number | string; provider?: Provider },
  ): Promise<Receipt> {
    const p = this.resolveProvider(opts?.provider);
    const gasLimit = opts?.gasLimit ?? 100_000_000;
    const value = opts?.value ?? 0;
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const tx: TxFields = {
      from: this.address,
      to: ZERO_ADDR,
      value: value.toString(),
      data: deployData,
      gasLimit,
      nonce,
      chainId,
      txType: TxType.Deploy,
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  // ==========================================================================
  // MEV-protected (encrypted) submission — Chapter 8.5 + Chapter 9
  // ==========================================================================

  /**
   * Build, encrypt, sign, and submit a transaction through the
   * MEV-protected encrypted mempool. The recipient + value + calldata
   * are threshold-encrypted with the committee pubkey so no validator
   * or RPC operator can read them before the order is locked at wave
   * commit time.
   *
   * Spec: Chapter 8.5 + Chapter 9.
   *
   * Handle-backed (Wallet.generate()) and hex-SK (Wallet.generateUnsafe(),
   * Wallet.fromEncrypted()) wallets both work — the implementation
   * dispatches on the internal key material and uses either
   * `buildRawEncryptedTxWithHandle` (handle) or `buildRawEncryptedTx`
   * (hex). Either way, the SK that signs the EncryptedTx::hash is the
   * same FALCON-512 key bound to `this.address`.
   *
   * Privacy note: `opts.estimateAccess` defaults to **false**.
   * `estimateAccess` calls the RPC with the plaintext (to, data,
   * value) — a curious node could see the call before it ever gets
   * encrypted. Set to true only against a trusted RPC, or pass a
   * pre-computed `opts.accessList` from a local simulator (Phase 14).
   * The chain still parallelises without an access list; the cost is
   * conservative serialisation, not correctness.
   *
   * Returns the **envelope hash** the engine echoed back from
   * `pyde_sendRawEncryptedTransaction` — NOT a receipt. Per engine RPC
   * catalog v0.1 §8, receipts after wave commit are keyed by the
   * **plaintext** tx hash the chain reconstructs post-decryption, not
   * the envelope hash. Polling `provider.waitForReceipt(envelopeHash)`
   * will time out. Receipt-polling for encrypted submissions is a
   * gap pending an inner-hash exposure on the wasm side; until then
   * treat a successful return as "admitted to encrypted mempool".
   */
  async sendEncrypted(
    to: string,
    data: string,
    opts?: {
      gasLimit?: number;
      value?: bigint | number | string;
      deadline?: number;
      accessList?: AccessEntry[];
      estimateAccess?: boolean;
      provider?: Provider;
    },
  ): Promise<{ envelopeHash: string }> {
    const p = this.resolveProvider(opts?.provider);
    const [threshold, [nonce, chainId]] = await Promise.all([
      p.getThresholdPublicKey(),
      p.getNonceAndChainId(this.address),
    ]);
    if (threshold === null) {
      throw new SigningError(
        "pyde_getThresholdPublicKey returned null — chain has no DKG state yet. " +
          "Fall back to plaintext `transfer` / `sendCall` until the chain bootstraps.",
      );
    }
    // Accept any Kyber-768 variant — engine reports the parameter set
    // as e.g. "kyber-768" or "kyber-768-goldilocks" (Goldilocks-prime
    // accelerated). Warn only on the legacy "mock" fallback which
    // means no real DKG has run yet.
    if (!threshold.scheme.startsWith("kyber-768")) {
      // v1 boot ships a deterministic mock pubkey for path coverage. The
      // chain admits the envelope but doesn't run decryption (no real
      // DKG to combine shares), so the encrypted tx will sit forever.
      // Per catalog §20 guidance: treat as "encrypted path not yet
      // ready", surface the gap to the caller.
      // eslint-disable-next-line no-console
      console.warn(
        `[pyde-ts-sdk] threshold-pubkey scheme is "${threshold.scheme}" (not a kyber-768 variant); ` +
          "encrypted tx will be admitted but not decrypted until real Kyber-768 DKG lands. " +
          "For real MEV protection, fall back to plaintext send.",
      );
    }
    const thresholdPk = threshold.publicKey;

    const accessList = opts?.accessList;
    // `opts.estimateAccess` is reserved for the Tier-2 catalog pass —
    // engine has no dedicated `pyde_estimateAccess` today. Until then
    // callers either supply `opts.accessList` themselves or skip it;
    // setting `estimateAccess: true` is a no-op (was previously a
    // privacy-leak path against the encrypted mempool, see chapter 9).
    void opts?.estimateAccess;

    const params: import("./crypto").EncryptedTxParams = {
      thresholdPk,
      sender: this.address,
      nonce,
      gasLimit: opts?.gasLimit ?? 100_000_000,
      chainId,
      to,
      value: (opts?.value ?? 0).toString(),
      calldata: data,
      ...(accessList ? { accessList } : {}),
      ...(opts?.deadline !== undefined ? { deadline: opts.deadline } : {}),
    };

    if ("destroyed" in this.key) throw new WalletDestroyedError();
    const wire =
      "handle" in this.key
        ? crypto.buildRawEncryptedTxWithHandle(params, this.key.handle)
        : crypto.buildRawEncryptedTx(params, this.key.hex);
    const tx = await p.sendRawEncryptedTransaction(wire);
    return { envelopeHash: tx.hash };
  }

  /** Encrypted variant of `transfer` — value-only send through the
   *  MEV-protected mempool. Same hex-SK constraint as `sendEncrypted`,
   *  same envelope-hash semantics (see `sendEncrypted` JSDoc). */
  async transferEncrypted(
    to: string,
    amount: bigint | number,
    opts?: { deadline?: number; provider?: Provider },
  ): Promise<{ envelopeHash: string }> {
    return this.sendEncrypted(to, "0x", {
      value: amount,
      gasLimit: 21_000,
      ...(opts?.deadline !== undefined ? { deadline: opts.deadline } : {}),
      ...(opts?.provider ? { provider: opts.provider } : {}),
    });
  }

  // ==========================================================================
  // Validator / staking operations (Chapter 11 §11.8 + Chapter 14 §14.5)
  // ==========================================================================

  /** Register as a validator (`StakeDeposit`, id 3). Spec: Chapter 11
   *  §11.8 + Chapter 14 §14.5.
   *
   *  - `amount` ≥ 10,000 PYDE (MIN_VALIDATOR_STAKE) — values below are
   *    rejected at chain validation.
   *  - `falconPubkey` (897-byte hex) is the FALCON pubkey the chain
   *    will use to verify this validator's vertex signatures. Often
   *    identical to the wallet's signing key but may differ if the
   *    operator keeps separate hot/cold keys.
   *  - Single-tier registration — any validator meeting the floor is
   *    eligible for uniform-random committee selection. */
  async stakeDeposit(
    falconPubkey: string,
    amount: bigint | number,
    opts?: { gasLimit?: number; provider?: Provider },
  ): Promise<Receipt> {
    const p = this.resolveProvider(opts?.provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const tx: TxFields = {
      from: this.address,
      to: ZERO_ADDR,
      value: amount.toString(),
      data: falconPubkey,
      gasLimit: opts?.gasLimit ?? 100_000,
      nonce,
      chainId,
      txType: TxType.StakeDeposit,
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  /** Begin 30-day unbonding (`StakeWithdraw`, id 4). Spec: Chapter 11 §11.8. */
  async stakeWithdraw(opts?: { provider?: Provider }): Promise<Receipt> {
    const p = this.resolveProvider(opts?.provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const tx: TxFields = {
      from: this.address,
      to: ZERO_ADDR,
      value: "0",
      data: "0x",
      gasLimit: 100_000,
      nonce,
      chainId,
      txType: TxType.StakeWithdraw,
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  /** Claim accrued staking yield (`ClaimReward`, id 6). Spec: Chapter 11 §11.8. */
  async claimReward(opts?: { provider?: Provider }): Promise<Receipt> {
    const p = this.resolveProvider(opts?.provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    const tx: TxFields = {
      from: this.address,
      to: ZERO_ADDR,
      value: "0",
      data: "0x",
      gasLimit: 100_000,
      nonce,
      chainId,
      txType: TxType.ClaimReward,
    };
    return p.sendAndWait(this.signTransaction(tx));
  }

  // ==========================================================================
  // Low-level builders (for tx types not surfaced above)
  // ==========================================================================

  /**
   * Build a `TxFields` with the wallet's `from` / `nonce` / `chainId`
   * auto-populated. Caller fills `to`, `value`, `data`, `gasLimit`,
   * `txType`, optional `accessList`, optional `deadline`. Useful for
   * the lower-frequency tx types not surfaced as direct methods
   * (Slash, ClaimAirdrop, MultisigTx, RotateMultisig, EmergencyPause,
   * EmergencyResume).
   */
  async buildTx(
    partial: Omit<TxFields, "from" | "nonce" | "chainId">,
    provider?: Provider,
  ): Promise<TxFields> {
    const p = this.resolveProvider(provider);
    const [nonce, chainId] = await p.getNonceAndChainId(this.address);
    return { from: this.address, nonce, chainId, ...partial };
  }

  /** Get balance via the bound provider. */
  async getBalance(provider?: Provider): Promise<bigint> {
    return this.resolveProvider(provider).getBalance(this.address);
  }

  /** Get nonce via the bound provider (u64 → bigint). */
  async getNonce(provider?: Provider): Promise<bigint> {
    return this.resolveProvider(provider).getNonce(this.address);
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private resolveProvider(provider?: Provider): Provider {
    if (provider) return provider;
    return this.provider; // throws if not bound — see AbstractSigner
  }
}

// ============================================================================
// Keystore helpers
// ============================================================================

const ZERO_ADDR = "0x" + "00".repeat(32);

function validateKeystore(k: Keystore): void {
  if (k.version !== 1) throw new SigningError(`unsupported keystore version: ${k.version}`);
  if (k.kdf !== "argon2id") throw new SigningError(`unsupported KDF: ${k.kdf}`);
  if (k.cipher !== "chacha20-poly1305") throw new SigningError(`unsupported cipher: ${k.cipher}`);
}

async function encryptKeystore(
  address: string,
  publicKey: string,
  secretKeyHex: string,
  password: string,
  params?: Partial<typeof KDF_DEFAULTS>,
): Promise<Keystore> {
  const m = params?.m ?? KDF_DEFAULTS.m;
  const t = params?.t ?? KDF_DEFAULTS.t;
  const p = params?.p ?? KDF_DEFAULTS.p;

  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = argon2id(utf8ToBytes(password), salt, { t, m, p, dkLen: KDF_KEY_LEN });

  const sk = hexToBytes(secretKeyHex);
  const aead = chacha20poly1305(key, nonce);
  const ciphertext = aead.encrypt(sk);

  return {
    address,
    publicKey,
    kdf: "argon2id",
    kdfParams: { m, t, p, salt: bytesToHex(salt) },
    cipher: "chacha20-poly1305",
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
    version: 1,
  };
}

async function decryptKeystore(k: Keystore, password: string): Promise<string> {
  const salt = hexToBytes(k.kdfParams.salt);
  const nonce = hexToBytes(k.nonce);
  const ciphertext = hexToBytes(k.ciphertext);
  const key = argon2id(utf8ToBytes(password), salt, {
    t: k.kdfParams.t,
    m: k.kdfParams.m,
    p: k.kdfParams.p,
    dkLen: KDF_KEY_LEN,
  });
  const aead = chacha20poly1305(key, nonce);
  let plaintext: Uint8Array;
  try {
    plaintext = aead.decrypt(ciphertext);
  } catch {
    throw new SigningError("keystore decryption failed — wrong password or corrupt file");
  }
  return "0x" + bytesToHex(plaintext);
}

// ============================================================================
// Local hex helpers (kept private; avoid coupling to src/hex.ts internals)
// ============================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    if (v === undefined) continue;
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new SigningError(`invalid hex (odd length): ${hex.slice(0, 16)}…`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ============================================================================
// File I/O (Node-only — dynamic import keeps the module isomorphic at parse)
// ============================================================================

interface NodeFs {
  readFileSync(path: string, encoding: "utf-8"): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  chmodSync(path: string, mode: number): void;
}

async function loadFsOrThrow(method: string): Promise<NodeFs> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new SigningError(
      `${method} is Node-only. In a browser, use fromEncrypted() / toKeystore() with your own storage.`,
    );
  }
  return (await import("node:fs")) as unknown as NodeFs;
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? "." : path.slice(0, idx);
}
