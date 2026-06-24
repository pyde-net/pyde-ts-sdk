#!/usr/bin/env bash
#
# Re-vendor pyde-crypto-wasm's bundler-target output into the SDK
# tree. Run whenever the upstream crypto changes; commit the result.
#
# Why vendor: pyde-ts-sdk is the sole JS consumer of pyde-crypto-wasm
# today, so we ship its `wasm-pack --target bundler` output as part
# of the SDK source. Downstream `npm i pyde-ts-sdk` gets a fully
# self-contained tarball — no transitive `pyde-crypto-wasm` resolve.
#
# Layout produced:
#   src/vendor/crypto-wasm/
#     pyde_crypto_wasm.js           ← entry; consumers import this
#     pyde_crypto_wasm_bg.js        ← imports the wasm bytes
#     pyde_crypto_wasm_bg.wasm      ← the compiled wasm
#     pyde_crypto_wasm.d.ts         ← TypeScript declarations
#     pyde_crypto_wasm_bg.wasm.d.ts ← wasm-export decls

set -euo pipefail

# Repo layout: pyde-ts-sdk/ and pyde-crypto-wasm/ are siblings.
SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRYPTO_DIR="$SDK_DIR/../pyde-crypto-wasm"
VENDOR_DIR="$SDK_DIR/src/vendor/crypto-wasm"

if [[ ! -d "$CRYPTO_DIR" ]]; then
  echo "error: $CRYPTO_DIR not found — vendor script assumes sibling-repo layout" >&2
  exit 1
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not on PATH. Install: cargo install wasm-pack" >&2
  exit 1
fi

echo "[vendor] building pyde-crypto-wasm (bundler target, release)…"
(
  cd "$CRYPTO_DIR"
  wasm-pack build --target bundler --release
)

echo "[vendor] copying pkg/ → $VENDOR_DIR"
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
# Copy only the build artefacts; skip README.md + package.json (the
# upstream's metadata isn't relevant once vendored).
for f in \
  pyde_crypto_wasm.js \
  pyde_crypto_wasm_bg.js \
  pyde_crypto_wasm_bg.wasm \
  pyde_crypto_wasm.d.ts \
  pyde_crypto_wasm_bg.wasm.d.ts; do
  cp "$CRYPTO_DIR/pkg/$f" "$VENDOR_DIR/$f"
done

# Provenance breadcrumb — what build produced this vendor copy.
{
  echo "# Vendored from sibling pyde-crypto-wasm — DO NOT edit by hand."
  echo "# Re-vendor via: npm run vendor:crypto-wasm"
  echo "# Vendored: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Source git ref:"
  ( cd "$CRYPTO_DIR" && git rev-parse HEAD 2>/dev/null || echo "  (not a git checkout)" )
} > "$VENDOR_DIR/VENDOR.txt"

echo "[vendor] done. Files in $VENDOR_DIR:"
ls -la "$VENDOR_DIR"
