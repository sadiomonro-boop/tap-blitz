# ⚡ Tap Blitz

**A 30-second tap race on a MagicBlock Ephemeral Rollup — built for Solana Blitz v10 (MagicBlock).**

Tap as fast as you can for 30 seconds. Your game account is delegated to a
MagicBlock Ephemeral Rollup (ER) so every tap is a **gasless, ~10 ms**
transaction — then the final score is **committed back to Solana devnet** and
the account is undelegated. The whole round is provable on-chain.

- **Live demo:** https://sadiomonro-boop.github.io/tap-blitz/
- **Program (devnet):** `CAKp5hPGXYZVd3Hws51VtmvDHXeH2NpU1a12dMspCTrs`
- **Deploy tx:** https://explorer.solana.com/tx/WPjScwWJy6Rvuc6dwdiMaDijFYMDfnPRLYksDw5emi5bfXbn6TTnz1rbxH7xdxMm5mhXWygmiHWizui43gmUTqg?cluster=devnet
- **Hackathon:** Solana Blitz v10, theme "Entertainment Finance" (skill games).
  One requirement: integrate Ephemeral Rollups — this entry does exactly that.
  Devnet only, $0 real money, no mainnet, no real wallet needed.

## How to play (30 seconds)

1. **Create demo wallet + fund** — a throwaway devnet keypair is generated in
   your browser and funded free from the devnet faucet. (Or connect Phantom /
   Solflare instead.)
2. **Initialize game** — creates your game PDA on Solana devnet.
3. **Delegate to ER** — locks the PDA in the MagicBlock Delegation Program
   (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) and clones it into the
   devnet-us Ephemeral Rollup (`https://devnet-us.magicblock.app`).
4. **Start round** — 30-second timer starts on the ER.
5. **TAP!** — each tap is a gasless ER transaction. Live score, taps/sec and
   countdown are shown.
6. **Finish & commit to Solana** — records your best score, commits the
   account back to devnet and undelegates. The commit transaction is linked
   in the proof log as evidence.

Every step links to Solana Explorer (devnet for base-layer txs, custom ER
endpoint for rollup txs).

## How it works

```
Solana devnet                          Ephemeral Rollup (devnet-us)
┌──────────────────┐  delegate        ┌──────────────────────────┐
│ Game PDA         │ ───────────────► │ Game PDA (cloned)      │
│ taps / best /    │                  │ start_round, tap × N   │
│ round state      │  ◄─────────────── │ ~10 ms blocks, gasless │
└──────────────────┘  finish_round   └──────────────────────────┘
  (commit + undelegate)          commit + undelegate in one ER tx
```

- **Program:** Anchor 1.0.2 + `ephemeral-rollups-sdk` 0.18.0 (`anchor` feature).
  Instructions: `initialize`, `start_round`, `tap`, `finish_round`
  (finalizes best score, then `commit_and_undelegate` via
  `MagicIntentBundleBuilder`), `delegate`, `undelegate`.
  The program uses the `#[ephemeral]` macro so the Delegation Program can
  call back into it on undelegation.
- **Game account:** PDA `["tap-blitz", player]` holding `player`, `taps`,
  `best`, `round_start`, `round_active`.
- **Timing is enforced on-chain:** `tap` requires the round to be active and
  `now < round_start + 30s` (Solana `Clock` sysvar).
- **Frontend:** Vite + vanilla TypeScript (`app/`), `@solana/web3.js` +
  `@coral-xyz/anchor`. No build-time secrets; the demo keypair lives only in
  the visitor's `localStorage`.
- **Confirmation:** the app polls `getSignatureStatus` over HTTP instead of
  relying on websocket subscriptions (robust behind proxies).

## Proof — end-to-end run (10 taps, 25 Nov 2026)

Script: `scripts/e2e.mjs` (run: `cd app && node ../scripts/e2e.mjs 10` —
see `proofs/run-2026-11-25T02-44-15-636Z.json` for the full JSON).

| Step | Layer | Signature (short) |
| --- | --- | --- |
| fund player | devnet | `5U2oiHLL…` |
| initialize | devnet | `3tkafQU6…` |
| delegate | devnet | `5YJZ2pCm…` |
| start round | ER devnet-us | `4FcF4Cw2…` |
| taps ×10 | ER devnet-us | `5rpv9p4a…` … `3mUcm4cW…` (avg 252 ms/tap incl. HTTP confirmation) |
| finish (commit + undelegate) | ER devnet-us | `2dXXhdA7…` |
| **Result on base layer** | devnet | `taps: 10, best: 10, round_active: false` ✅ |

Router `getDelegationStatus` confirmed `isDelegated: true` with
`fqdn: https://devnet-us.magicblock.app/` and validator
`MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` (devnet-us).

## Run it yourself

### Program

```bash
# Rust 1.89.0, Solana CLI 3.1.9, Anchor 1.0.2
anchor build
anchor deploy --provider.cluster devnet
```

### Frontend

```bash
cd app
npm install
npm run build   # -> dist/
npm run dev     # local dev server
```

### End-to-end proof (needs devnet SOL on the deployer keypair)

```bash
cd app
node ../scripts/e2e.mjs 10
```

## Project layout

```
programs/tap-blitz/src/lib.rs   Anchor program
app/                            Vite frontend (GitHub Pages)
app/src/idl/tap_blitz.json      Program IDL (copied from target/idl/)
scripts/e2e.mjs                 Headless end-to-end proof run
proofs/                         Proof JSON from the e2e run
```

## Notes / limitations

- **No VRF bonus roll (yet):** the stretch goal (random multiplier at round
  end via MagicBlock VRF) was not built — the core ER game was prioritized
  and the entry is complete without it.
- Devnet only. The demo faucet can rate-limit; if funding fails, wait a
  minute and press the button again (the same demo keypair is reused).
- `api.devnet.solana.com` was unreliable from the build VM (timeouts, failed
  airdrops), so the app uses the MagicBlock devnet RPC
  (`https://rpc.magicblock.app/devnet`) as its primary base-layer endpoint,
  with `api.devnet.solana.com` as fallback.
- Wallet connect uses the injected Phantom/Solflare provider; it has not
  been tested with a real wallet — the demo keypair path is the tested one.

## License

MIT — see [LICENSE](LICENSE).
