# Publishing checklist

Pre-flight before `npm publish` for `pyde-ts-sdk@0.1.0`.

## Prerequisites (one-time)

1. **Re-vendor `pyde-crypto-wasm` if needed.** The SDK ships the wasm-pack `bundler`-target output verbatim under `src/vendor/crypto-wasm/`. Re-run the vendor script if the sibling repo has advanced:

   ```bash
   npm run vendor:crypto-wasm
   ```

   That rebuilds `pyde-crypto-wasm` from the sibling `../pyde-crypto-wasm/` checkout, copies the four artefacts (`pyde_crypto_wasm.js`, `pyde_crypto_wasm_bg.js`, `pyde_crypto_wasm_bg.wasm`, `pyde_crypto_wasm.d.ts`) into `src/vendor/crypto-wasm/`, and stamps `VENDOR.txt` with the source git sha + timestamp. Commit the change.

   The vendored files are part of `src/`, get copied into `dist/vendor/crypto-wasm/` by tsup's `onSuccess` hook + the `build` script's `cp ... *.d.ts` line, and ship in the published tarball. There is no runtime `pyde-crypto-wasm` dependency — the published SDK is self-contained.

2. **npm credentials.** `npm whoami` should return a member of the `pyde-net` org (or transitional publisher). 2FA recommended.

3. **Tag matches version.** `package.json` is `"version": "0.1.0"`; the git tag should be `v0.1.0`.

## Local pre-flight

`prepublishOnly` runs all of these automatically — but worth doing manually to catch issues early:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm run test          # vitest run — 227 unit tests
npm run build         # tsup ESM + DTS + vendor copy
npm run audit:prod    # 0 vulnerabilities
```

Optional (slower):

```bash
npm run test:integration   # 89/89 pass against a freshly-spawned otigen devnet
```

## What ships

The `files` array in `package.json` declares what npm packs into the tarball:

- `dist/` — compiled JS + DTS (tsup output) + `dist/vendor/crypto-wasm/` (the vendored wasm artefacts)
- `docs/` — full reference (14 chapters; chapter 06 is intentionally absent — pure-language SDK, no framework adapters)
- `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`

**Excluded:** `src/` source, `tests/`, dev configs (eslint, vitest, tsup, prettier), example fixtures, integration tests.

Sanity-check before publish:

```bash
npm pack --dry-run
```

That prints the exact file list npm would upload — confirm the `dist/vendor/crypto-wasm/` files are present.

## Publish

```bash
npm publish
```

Lands on the `latest` dist-tag. No `--tag beta` flag — this is the stable 0.1.0 cut.

## Post-publish

1. Tag the release:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. Cut a GitHub Release pointing at the tag; paste the `CHANGELOG.md` entry as the body.

3. Bump to the next dev version:

   ```bash
   npm version 0.2.0-beta.0 --no-git-tag-version
   ```

## Yanking (if needed)

```bash
npm deprecate pyde-ts-sdk@0.1.0 "Yanked: <reason>. Use 0.1.1."
# Or for the nuclear option (rare; npm allows within 72 hours):
npm unpublish pyde-ts-sdk@0.1.0
```

Prefer `deprecate` over `unpublish` — keeps the version reservation, just warns installers.
