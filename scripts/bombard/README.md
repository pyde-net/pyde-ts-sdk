# pyde-bombard

Multi-laptop network stress tester for Pyde testnets. Each laptop runs the
script independently against the same RPC; the network sees the aggregate
load.

## Workload

8-bucket weighted mix exercising the smart-contract feature surface:

| Bucket | Weight | What it exercises |
|---|---|---|
| transfer | 25% | plaintext token transfer |
| increment (AOT) | 25% | hot-path `MegaContract.increment` — warms the AOT cache |
| complex_logic | 10% | struct arg + u256 return + event emit |
| change_status | 5% | enum match + per-arm event |
| deposit | 10% | payable + indexed Deposit event |
| spawn | 3% | `Spawner.spawn()` factory pattern via `deploy!(Helper)` |
| ping | 7% | cross-contract call MegaContract → Helper |
| encrypted_increment | 15% | threshold-encrypted variant of increment |

(The `checked_signed` bucket from earlier soak versions was dropped — see
/404 in the chain repo's `AUDIT_FINDINGS_2.md`. Re-introduce
post signed-int PVM ISA support.)

## One-time setup

1. Build the contract artifacts (requires `pyde-dev` from the chain repo):
   ```bash
   cd suite
   pyde-dev build
   # → out/Helper.json, out/MegaContract.json, out/Spawner.json
   cd ..
   ```

2. Build the SDK so `bombard.ts` can import from `../../src`:
   ```bash
   cd ../.. # into pyde-ts-sdk/
   npm install
   npm run build
   cd scripts/bombard
   ```

## Run

First laptop deploys the contracts and prints their addresses:

```bash
npx tsx bombard.ts \
  --rpc-url http://testnet.example:8545 \
  --faucet-url http://testnet.example:8080 \
  --chain-id 7331 \
  --duration-secs 600 \
  --tps 10 \
  --senders 50
```

Output ends with:
```
       Helper: 0xab12...
       MegaContract: 0xcd34...
       Spawner: 0xef56...
```

Subsequent laptops skip the deploy phase by passing those addresses:

```bash
npx tsx bombard.ts \
  --rpc-url http://testnet.example:8545 \
  --helper 0xab12... \
  --mega 0xcd34... \
  --spawner 0xef56...
```

## CLI flags

| Flag | Default | Notes |
|---|---|---|
| `--rpc-url` | (required) | JSON-RPC URL of any node |
| `--faucet-url` | derived from `<rpc-host>:8080` | Public faucet endpoint |
| `--chain-id` | `7331` | Canonical public testnet ID |
| `--duration-secs` | `600` (10 min) | Measurement window |
| `--tps` | `10` | Aggregate target submit rate |
| `--senders` | `50` | Wallets provisioned via faucet |
| `--encrypted-pct` | `30` | Reserved (workload weights are static) |
| `--mega` | (none) | Pre-deployed `MegaContract` address |
| `--helper` | (none) | Pre-deployed `Helper` address |
| `--spawner` | (none) | Pre-deployed `Spawner` address |

Pass all three of `--mega/--helper/--spawner` to skip deploy.

## What the script actually does

1. **Verify chain_id**. Probes `pyde_chainId` and refuses to proceed if the
   node reports a different ID than `--chain-id`. Cheap insurance against
   pointing at the wrong network.

2. **Generate sender wallets** locally (FALCON-512 keypairs). One round-trip
   per wallet to the faucet's `POST /api/request`, then poll until the drop
   commits before requesting the next. Per-drop commit-wait is required —
   the faucet stamps each tx with the chain-committed nonce, so back-to-back
   hits would all see the same nonce and only the first would land.

3. **Register pubkeys**. After each wallet is funded, submits an unsigned
   `RegisterPubkey` tx (/229 bootstrap — the address-derivation
   check `from == Poseidon2(data)` IS the proof of pubkey ownership for
   this tx type). Polls until `getTransactionCount >= 1`.

4. **Deploy contracts** (or accept pre-deployed addresses). Reads
   `suite/out/*.json` artifacts produced by `pyde-dev build`, assembles the
   on-chain Deploy data field
   (`[clen:4][rlen:4][constructor_bytes][runtime_bytes][ctor_args]`), signs
   via the SDK's `Wallet.deploy()`, polls for the receipt, parses the
   contract address.

5. **Run workload**. Each tx is dispatched on a per-sender round-robin so
   per-sender nonce-window saturation is uniform. Encrypted-tx submissions
   use `buildRawEncryptedTx` from the SDK (threshold-encrypts `(to,value,
   calldata)`, FALCON-signs the envelope, submits via
   `pyde_sendRawEncryptedTransaction`).

6. **Print per-bucket totals** at the end.

## Diagnosing common failures

- **`chain_id mismatch`** — `--rpc-url` and `--chain-id` don't match. The
  node knows what it's running; trust it.
- **`faucet 429: ip rate limited`** — faucet's per-IP cooldown is too tight
  for `--senders`. Either lower `--senders`, or have the operator restart
  the faucet with a lower `--cooldown` for testing.
- **`faucet 503: queue saturated`** — queue cap fired (16
  concurrent waiters). The script serializes faucet hits, so this should
  only appear if multiple laptops hit the same faucet simultaneously
  during their setup phase. Stagger laptop starts by ~30s each.
- **`AboveWindow`** errors during workload — per-sender nonce window
  saturation. Test-side artifact: the per-sender submit rate (`tps /
  senders`) exceeds chain inclusion drain rate. Lower `--tps` or raise
  `--senders`.
