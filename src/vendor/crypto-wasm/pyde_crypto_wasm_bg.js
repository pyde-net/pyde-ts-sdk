/**
 * Compute FNV-1a function selector (same as Otigen codegen).
 * @param {string} name
 * @returns {number}
 */
export function computeSelector(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.computeSelector(ptr0, len0);
    return ret >>> 0;
}

/**
 * Derive address from a FALCON-512 public key (hex).
 * address = Poseidon2(public_key_bytes)
 * @param {string} pk_hex
 * @returns {string}
 */
export function deriveAddress(pk_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(pk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.deriveAddress(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * drop a retained keypair. The `FalconSecretKey`'s
 * `ZeroizeOnDrop` impl () overwrites the secret bytes in
 * place when removed from the table. Returns `true` if a key was
 * actually removed, `false` if the handle was already dropped.
 * @param {number} handle
 * @returns {boolean}
 */
export function dropKeypair(handle) {
    const ret = wasm.dropKeypair(handle);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Wire-encode a `TransactionType::RegisterPubkey` () tx
 * without signing. The address-derivation check (`from ==
 * Poseidon2(data)`) IS the proof of pubkey ownership for this
 * tx type, so a FALCON sig is neither needed nor accepted.
 * Refuses to encode any other tx type — accidental misuse on a
 * signed-tx path would be a hard-to-debug protocol violation.
 * @param {string} tx_json
 * @returns {string}
 */
export function encodeRegisterPubkeyTx(tx_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(tx_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encodeRegisterPubkeyTx(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a FALCON-512 keypair.
 * Returns JSON: { "publicKey": "0x...", "secretKey": "0x...", "address": "0x..." }
 * **security warning**: this function returns the
 * secret key as a hex string into the JS heap. Once there, it is
 * reachable from:
 *   - browser dev-tools console (`Object.values(walletState)`)
 *   - browser extensions with content-script access to the page
 *   - process crash dumps (the string survives until JS GC)
 *   - accidental logging (`JSON.stringify(walletState)`)
 * For wallet UIs that need to hold the key in-process, prefer
 * `generateKeypairHandle` + `signMessageWithHandle` /
 * `signTransactionWithHandle` / `dropKeypair`. Those keep the SK
 * inside this crate's WASM heap and return only an opaque `u32`
 * handle to JS — the SK bytes never enter the JS heap at all. For
 * wallets that need to encrypt the SK to disk before discarding
 * the in-memory copy (the typical `pyde-ts-sdk` / `otigen`
 * keystore flow), this hex-string return is unavoidable, but
 * callers MUST encrypt the value at the earliest opportunity and
 * must NEVER let it survive across renders or get serialized.
 * @returns {string}
 */
export function generateKeypair() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.generateKeypair();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * opaque-handle variant of `generateKeypair`. Generates
 * a FALCON-512 keypair, retains the secret key inside this crate's
 * WASM heap, and returns JSON with only the `publicKey`, `address`,
 * and an opaque `handle: u32` to JS. The SK bytes never enter the
 * JS heap. Use `signMessageWithHandle` / `signTransactionWithHandle`
 * to sign with the retained key, and `dropKeypair(handle)` when
 * done.
 * Returns JSON: `{ "publicKey": "0x...", "address": "0x...",
 *                  "handle": 1 }`.
 * @returns {string}
 */
export function generateKeypairHandle() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.generateKeypairHandle();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Compute transaction hash from JSON fields.
 * Accepts: { from, to, value, data, gasLimit, nonce, chainId, txType }
 * Returns hash hex.
 * @param {string} tx_json
 * @returns {string}
 */
export function hashTransaction(tx_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(tx_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hashTransaction(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Deterministically derive a FALCON-512 keypair from a 32-byte seed.
 * Returns the same JSON shape as `generateKeypair`. Same security
 * warning applies — the SK is in the JS heap; encrypt + discard ASAP.
 *
 * Same FALCON deterministic-keygen path the engine uses for the
 * devnet prefunded accounts (`devnet_secret(i) =
 * Blake3("pyde-devnet-v1/" || i.to_le_bytes())`), so SDK consumers
 * can re-derive the prefunded accounts locally for integration tests
 * without round-tripping through the `otigen` keystore.
 *
 * `seed_hex` is a `0x`-prefixed (or bare) 64-char hex string.
 * @param {string} seed_hex
 * @returns {string}
 */
export function keypairFromSeed(seed_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(seed_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keypairFromSeed(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compute Poseidon2 hash of arbitrary bytes (hex).
 * @param {string} data_hex
 * @returns {string}
 */
export function poseidon2Hash(data_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(data_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.poseidon2Hash(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign a message with a FALCON-512 secret key. Returns signature hex.
 * @param {string} sk_hex
 * @param {string} message_hex
 * @returns {string}
 */
export function signMessage(sk_hex, message_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(sk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(message_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signMessage(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * sign a message using a key retained by handle. The
 * SK bytes never leave this crate's WASM heap.
 * Returns the signature as a `0x`-prefixed hex string.
 * @param {number} handle
 * @param {string} message_hex
 * @returns {string}
 */
export function signMessageWithHandle(handle, message_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(message_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signMessageWithHandle(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign a transaction. Returns the signed tx bytes as hex (wire format).
 * Accepts JSON tx fields + secretKey hex.
 * @param {string} tx_json
 * @param {string} sk_hex
 * @returns {string}
 */
export function signTransaction(tx_json, sk_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(tx_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(sk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signTransaction(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * sign a transaction (same JSON shape as
 * `signTransaction`) using a key retained by handle. Returns the
 * signed wire bytes as `0x`-prefixed hex.
 * @param {string} tx_json
 * @param {number} handle
 * @returns {string}
 */
export function signTransactionWithHandle(tx_json, handle) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(tx_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signTransactionWithHandle(ptr0, len0, handle);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Verify a FALCON-512 signature.
 * @param {string} pk_hex
 * @param {string} message_hex
 * @param {string} sig_hex
 * @returns {boolean}
 */
export function verifySignature(pk_hex, message_hex, sig_hex) {
    const ptr0 = passStringToWasm0(pk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(message_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(sig_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verifySignature(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
export function __wbg___wbindgen_is_function_5cd60d5cf78b4eef(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_object_b4593df85baada48(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_string_dde0fd9020db4434(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_throw_9c31b086c2b26051(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_call_dfde26266607c996() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_crypto_38df2bab126b63dc(arg0) {
    const ret = arg0.crypto;
    return ret;
}
export function __wbg_getRandomValues_c44a50d8cfdaebeb() { return handleError(function (arg0, arg1) {
    arg0.getRandomValues(arg1);
}, arguments); }
export function __wbg_length_56fcd3e2b7e0299d(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_msCrypto_bd5a034af96bcba6(arg0) {
    const ret = arg0.msCrypto;
    return ret;
}
export function __wbg_new_with_length_99887c91eae4abab(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return ret;
}
export function __wbg_node_84ea875411254db1(arg0) {
    const ret = arg0.node;
    return ret;
}
export function __wbg_process_44c7a14e11e9f69e(arg0) {
    const ret = arg0.process;
    return ret;
}
export function __wbg_prototypesetcall_5f9bdc8d75e07276(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_randomFillSync_6c25eac9869eb53c() { return handleError(function (arg0, arg1) {
    arg0.randomFillSync(arg1);
}, arguments); }
export function __wbg_require_b4edbdcf3e2a1ef0() { return handleError(function () {
    const ret = module.require;
    return ret;
}, arguments); }
export function __wbg_static_accessor_GLOBAL_THIS_02344c9b09eb08a9() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_ac6d4ac874d5cd54() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_9b2406c23aeb2023() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_b34d2126934e16ba() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_subarray_7c6a0da8f3b4a1ba(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
}
export function __wbg_versions_276b2795b1c6a219(arg0) {
    const ret = arg0.versions;
    return ret;
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
