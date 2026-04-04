// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pyde_crypto_wasm");

export interface Keypair {
  publicKey: string;
  secretKey: string;
  address: string;
}

/** Generate a new FALCON-512 keypair with derived address. */
export function generateKeypair(): Keypair {
  return JSON.parse(wasm.generateKeypair());
}

/** Derive address from a FALCON-512 public key hex. */
export function deriveAddress(publicKeyHex: string): string {
  return wasm.deriveAddress(publicKeyHex);
}

/** Sign a message hash with a FALCON-512 secret key. Returns signature hex. */
export function signMessage(secretKeyHex: string, messageHex: string): string {
  return wasm.signMessage(secretKeyHex, messageHex);
}

/** Verify a FALCON-512 signature. */
export function verifySignature(
  publicKeyHex: string,
  messageHex: string,
  signatureHex: string
): boolean {
  return wasm.verifySignature(publicKeyHex, messageHex, signatureHex);
}

/** Compute Poseidon2 hash of arbitrary data (hex). */
export function poseidon2Hash(dataHex: string): string {
  return wasm.poseidon2Hash(dataHex);
}

/** Compute FNV-1a function selector. */
export function computeSelector(methodName: string): number {
  return wasm.computeSelector(methodName);
}

/** Compute transaction hash from fields. */
export function hashTransaction(tx: TxFields): string {
  return wasm.hashTransaction(JSON.stringify(tx));
}

/** Sign a transaction and return wire-encoded signed tx as hex. */
export function signTransaction(tx: TxFields, secretKeyHex: string): string {
  return wasm.signTransaction(JSON.stringify(tx), secretKeyHex);
}

export interface TxFields {
  from: string;
  to: string;
  value: number | string;
  data: string;
  gasLimit: number;
  nonce: number;
  chainId: number;
  txType: number;
}
