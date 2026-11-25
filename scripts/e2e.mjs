// End-to-end proof run for Tap Blitz (devnet only, throwaway keypairs).
// Usage: node scripts/e2e.mjs [taps]
// Prints every signature + explorer link and writes proofs/run-<ts>.json
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import idl from "../app/src/idl/tap_blitz.json" with { type: "json" };

const BASE_RPC = "https://rpc.magicblock.app/devnet"; // api.devnet.solana.com times out from this VM — MagicBlock RPC is the reliable devnet endpoint here
const MAGIC_RPC = "https://rpc.magicblock.app/devnet";
const ER_DEFAULT = "https://devnet-us.magicblock.app";
const ROUTER_RPC = "https://devnet-router.magicblock.app/";
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const DEVNET_US_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
const NOOP_PROGRAM = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const PROGRAM_ID = new PublicKey(idl.address);
const TAP_COUNT = Number(process.argv[2] ?? 10);

const baseConn = new Connection(BASE_RPC, "confirmed");
const magicConn = new Connection(MAGIC_RPC, "confirmed");
let erConn = new Connection(ER_DEFAULT, "confirmed");
let erEndpoint = ER_DEFAULT;

const proof = { programId: PROGRAM_ID.toBase58(), tapsPlanned: TAP_COUNT, steps: {} };
function log(step, sig, layer, extra = {}) {
  const url =
    layer === "base"
      ? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
      : `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(erEndpoint)}`;
  console.log(`[${layer}] ${step}: ${sig}\n      ${url}`);
  proof.steps[step] = { signature: sig, layer, url, ...extra };
}

async function send(conn, tx, signer, label, layer) {
  const { value: { blockhash, lastValidBlockHeight } } = await conn.getLatestBlockhashAndContext();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.partialSign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: layer === "er" });
  // HTTP polling instead of confirmTransaction: this VM's proxy breaks the
  // wss subscription web3.js relies on, so confirmations never arrive.
  await confirmPoll(conn, sig, label);
  log(label, sig, layer);
  return sig;
}

async function getDelegationStatus(pda) {
  const res = await fetch(ROUTER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [pda.toBase58()] }),
  });
  return (await res.json())?.result ?? {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function confirmPoll(conn, sig, label) {
  const want = "confirmed";
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig);
    const v = st.value;
    if (v && (v.confirmationStatus === want || v.confirmationStatus === "finalized")) {
      if (v.err) throw new Error(`${label} failed on chain: ${JSON.stringify(v.err)}`);
      return;
    }
    if (v && v.err) throw new Error(`${label} failed on chain: ${JSON.stringify(v.err)}`);
    await sleep(500);
  }
  throw new Error(`${label} not confirmed within 90s (sig ${sig})`);
}


async function main() {
  // Player: fresh throwaway keypair, funded from the deployer keypair.
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))),
  );
  const player = Keypair.generate();
  console.log("player:", player.publicKey.toBase58());
  proof.player = player.publicKey.toBase58();
  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: player.publicKey, lamports: 0.5 * LAMPORTS_PER_SOL }),
  );
  await send(baseConn, fundTx, deployer, "fund-player", "base");

  const provider = new AnchorProvider(baseConn, new Wallet(player), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tap-blitz"), player.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  console.log("game PDA:", gamePda.toBase58());
  proof.gamePda = gamePda.toBase58();

  // 1. initialize (base)
  let tx = (await program.methods.initialize().accounts({ game: gamePda, player: player.publicKey }).transaction());
  await send(baseConn, tx, player, "initialize", "base");

  // 2. delegate (base, pin devnet-us)
  tx = (await program.methods
    .delegate()
    .accounts({ payer: player.publicKey, pda: gamePda })
    .remainingAccounts([{ pubkey: DEVNET_US_VALIDATOR, isSigner: false, isWritable: false }])
    .transaction());
  await send(baseConn, tx, player, "delegate", "base");

  // 3. wait for delegation, discover ER endpoint
  let fqdn = null;
  for (let i = 0; i < 20; i++) {
    const status = await getDelegationStatus(gamePda);
    console.log("delegation status:", JSON.stringify(status));
    const m = JSON.stringify(status).match(/https:\/\/[a-z0-9.-]*magicblock\.app/g);
    if (status.isDelegated === true || status.delegated === true) {
      fqdn = m ? m[0] : ER_DEFAULT;
      break;
    }
    const info = await baseConn.getAccountInfo(gamePda);
    if (info?.owner.equals(DELEGATION_PROGRAM)) {
      fqdn = m ? m[0] : ER_DEFAULT;
      break;
    }
    await sleep(2000);
  }
  if (!fqdn) throw new Error("delegation never confirmed");
  erEndpoint = fqdn;
  erConn = new Connection(erEndpoint, "confirmed");
  proof.erEndpoint = erEndpoint;
  console.log("ER endpoint:", erEndpoint);
  try { await erConn.requestAirdrop(gamePda, 1); } catch { /* best effort */ }
  await sleep(2000);

  // 4. start round (ER)
  const erProvider = new AnchorProvider(erConn, new Wallet(player), { commitment: "confirmed" });
  const erProgram = new Program(idl, erProvider);
  tx = (await erProgram.methods.startRound().accounts({ game: gamePda, player: player.publicKey }).transaction());
  await send(erConn, tx, player, "start-round", "er");

  // 5. taps (ER) — time them
  const tapSigs = [];
  const t0 = Date.now();
  for (let i = 0; i < TAP_COUNT; i++) {
    tx = (await erProgram.methods.tap().accounts({ game: gamePda, player: player.publicKey }).transaction());
    tx.add(new TransactionInstruction({ programId: NOOP_PROGRAM, keys: [], data: randomBytes(5) }));
    const sig = await send(erConn, tx, player, `tap-${i + 1}`, "er");
    tapSigs.push(sig);
  }
  const tapMs = Date.now() - t0;
  proof.tapSignatures = tapSigs;
  proof.tapTotalMs = tapMs;
  console.log(`taps: ${TAP_COUNT} in ${tapMs}ms (avg ${(tapMs / TAP_COUNT).toFixed(0)}ms/tap)`);

  // 6. read ER state
  const erGame = await erProgram.account.game.fetch(gamePda);
  console.log("ER game state:", JSON.stringify({ taps: erGame.taps.toString(), best: erGame.best.toString(), roundActive: erGame.roundActive }));
  proof.erStateBeforeFinish = { taps: erGame.taps.toString(), best: erGame.best.toString() };

  // 7. finish round = commit + undelegate (ER)
  tx = (await erProgram.methods.finishRound().accounts({ payer: player.publicKey, game: gamePda }).transaction());
  await send(erConn, tx, player, "finish-round-commit-undelegate", "er");

  // 8. verify on base layer
  let baseGame = null;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const info = await baseConn.getAccountInfo(gamePda);
    if (info && !info.owner.equals(DELEGATION_PROGRAM)) {
      baseGame = await program.account.game.fetch(gamePda);
      break;
    }
  }
  if (!baseGame) throw new Error("game account did not return to base layer");
  console.log("BASE game state:", JSON.stringify({ taps: baseGame.taps.toString(), best: baseGame.best.toString(), roundActive: baseGame.roundActive }));
  proof.baseStateAfterFinish = { taps: baseGame.taps.toString(), best: baseGame.best.toString(), roundActive: baseGame.roundActive };
  proof.success = Number(baseGame.best) === TAP_COUNT && Number(baseGame.taps) === TAP_COUNT;
  console.log(proof.success ? "✅ E2E PASS: best == taps == " + TAP_COUNT : "❌ E2E FAIL: best/taps mismatch");

  const out = `proofs/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log("proof written:", out);
  if (!proof.success) process.exit(1);
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  fs.writeFileSync("proofs/run-FAILED.json", JSON.stringify({ ...proof, error: String(e) }, null, 2));
  process.exit(1);
});
