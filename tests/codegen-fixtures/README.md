# Codegen fixtures

Sample output from `pyde-tsgen` running against the canonical otigen example contracts. Useful for:

- Reviewing what generated `.d.ts` looks like before consuming the CLI in a real project
- Sanity-checking changes to `src/codegen.ts` against a real ABI artifact
- Documenting the type mapping decisions (U64 → bigint, Bool → boolean, etc.)

## Contents

| File                      | Source contract                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `storage-stress.gen.d.ts` | `otigen/examples/storage-stress` — exercises every storage type the macro supports (29 functions). |

## Regenerating

```bash
# from pyde-ts-sdk
npm run build
node dist/cli-tsgen.js \
  ../otigen/examples/storage-stress/artifacts/storage-stress.bundle/abi.json \
  tests/codegen-fixtures/storage-stress.gen.d.ts \
  --name StorageStress
```

The smoke test at `src/codegen.smoke.test.ts` runs the generator against the live bundle on every test invocation, so the fixture and the test are always in sync — you only need to regenerate manually for inspection.
