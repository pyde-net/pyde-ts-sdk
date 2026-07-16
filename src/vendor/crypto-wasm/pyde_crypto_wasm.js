/* @ts-self-types="./pyde_crypto_wasm.d.ts" */
import * as wasm from "./pyde_crypto_wasm_bg.wasm";
import { __wbg_set_wasm } from "./pyde_crypto_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    computeSelector, deriveAddress, dropKeypair, encodeRegisterPubkeyTx, generateKeypair, generateKeypairHandle, hashTransaction, keypairFromSeed, poseidon2Hash, signMessage, signMessageWithHandle, signTransaction, signTransactionWithHandle, verifySignature
} from "./pyde_crypto_wasm_bg.js";
