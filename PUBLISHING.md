# Publishing checklist

Pre-flight before `npm publish` for `pyde-ts-sdk@0.1.0-beta.1`.

## Prerequisites (one-time)

1. **`pyde-crypto-wasm` must be on npm first.** The SDK currently depends on it via `file:../pyde-crypto-wasm/pkg`. That doesn't survive a publish — npm rejects file dependencies on the registry side.
   - Publish `pyde-crypto-wasm@0.1.0` from its repo: `wasm-pack publish` or `npm publish` from `pkg/`.
   - Then in this repo, swap the dependency:
     ```diff
     - "pyde-crypto-wasm": "file:../pyde-crypto-wasm/pkg"
     + "pyde-crypto-wasm": "^0.1.0"
     ```
   - Re-run `npm install` to verify the registry resolution works.

2. **npm credentials.** `npm whoami` should return a member of the `pyde-net` org (or transitional publisher). 2FA recommended.

3. **Tag matches version.** `package.json` is `"version": "0.1.0-beta.1"`; the git tag should be `v0.1.0-beta.1`.

## Local pre-flight

`prepublishOnly` runs all of these automatically — but worth doing manually to catch issues early:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm run test          # vitest run — 114 tests
npm run build         # tsup ESM + DTS
npm run audit:prod    # 0 vulnerabilities
```

Optional (slower):

```bash
npm run test:integration   # 11/17 pass against a live otigen devnet
```

## What ships

The `files` array in `package.json` declares what npm packs into the tarball:

- `dist/` — compiled JS + DTS (tsup output)
- `docs/` — full reference (15 chapters)
- `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`

**Excluded:** `src/`, `tests/`, dev configs (eslint, vitest, tsup, prettier), example/ABI fixtures, integration tests.

Sanity-check before publish:

```bash
npm pack --dry-run
```

That prints the exact file list npm would upload.

## Publish

```bash
# Beta tag — `npm install pyde-ts-sdk` won't pick this up by default.
# Users opt in via `npm install pyde-ts-sdk@beta`.
npm publish --tag beta
```

For the final 0.1.0 (stable), drop `--tag beta` so it lands on `latest`.

## Post-publish

1. Tag the release:
   ```bash
   git tag v0.1.0-beta.1
   git push origin v0.1.0-beta.1
   ```

2. Cut a GitHub Release pointing at the tag; paste the `CHANGELOG.md` entry as the body.

3. Update the README install line to remove the "publish in progress" caveat.

4. Bump to the next dev version:
   ```bash
   npm version 0.2.0-beta.0 --no-git-tag-version
   ```

## Yanking (if needed)

```bash
npm deprecate pyde-ts-sdk@0.1.0-beta.1 "Yanked: <reason>. Use 0.1.0-beta.2."
# Or for the nuclear option (rare; npm allows within 72 hours):
npm unpublish pyde-ts-sdk@0.1.0-beta.1
```

Prefer `deprecate` over `unpublish` — keeps the version reservation, just warns installers.
