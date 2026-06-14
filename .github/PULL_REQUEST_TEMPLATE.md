<!--
Thanks for the PR. A few asks before maintainers review:

1. Keep the PR scoped to one logical change. Mixing refactors with fixes
   slows review.
2. Run the full local gate before pushing:
     npm run typecheck
     npm run lint
     npm run test
     npm run build
     npm run audit:prod
3. If the change touches the Provider, Wallet, Contract, or WebSocket
   surface, add an integration test under tests/integration/*.live.test.ts
   (or update the rationale on the skipped suite).
4. If the change touches a wire-format-sensitive path (TxFields, borsh
   codec, RPC method names), fill in the "Wire-format impact" section
   below. Otherwise delete it.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Test plan

<!-- Bulleted checklist of what you verified, with exit status. -->

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` no new errors
- [ ] `npm run test` (N/N pass)
- [ ] `npm run build` ESM + DTS green
- [ ] `npm run audit:prod` 0 vulnerabilities
- [ ] (if applicable) `npm run test:integration` against `otigen devnet`

## Breaking changes

<!-- "None" if no public-API behavior changes. Otherwise:
     - What breaks?
     - Migration path for consumers
     - Updated docs/13-migration.md?
-->

None.

## Wire-format impact

<!-- DELETE THIS SECTION if you didn't touch:
       - TxFields / Tx wire serialization
       - Borsh codec
       - RPC method names or parameter shapes
       - Receipt / WaveHeader / Account / Log decoding

     If you did, document:
       - What bytes change vs the chain's reference impl?
       - Cross-checked against pyde-rust-sdk?
       - Live-verified against an actual otigen devnet build?
-->

Not applicable.

## Spec citations

<!-- If a change tracks a Pyde Book chapter, link it. -->

## Checklist

- [ ] Followed the conventional-commit style of the existing log
- [ ] Updated `docs/` if a public surface changed
- [ ] Updated `CHANGELOG.md` entry under "Unreleased" if user-visible
- [ ] No `console.log` left behind
- [ ] No hardcoded secrets / keys / mainnet endpoints in test fixtures
