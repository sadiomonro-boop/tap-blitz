import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction, } from "@solana/web3.js";
import { Buffer } from "buffer";
window.Buffer = Buffer;
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import idl from "./idl/tap_blitz.json";
// ---------------------------------------------------------------------------
// Endpoints (all devnet — no real money anywhere in this app)
// ---------------------------------------------------------------------------
const BASE_RPC = "https://api.devnet.solana.com";
const BASE_RPC_FALLBACK = "https://rpc.magicblock.app/devnet";
const ER_DEFAULT = "https://devnet-us.magicblock.app";
const ROUTER_RPC = "https://devnet-router.magicblock.app/";
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
// devnet-us validator (v2.0) — pinning the region keeps the ER endpoint stable.
const DEVNET_US_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
const NOOP_PROGRAM = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const ROUND_SECONDS = 30;
const PROGRAM_ID = new PublicKey(idl.address);
// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
    walletLine: $("wallet-line"),
    walletAddr: $("wallet-addr"),
    walletBalance: $("wallet-balance"),
    score: $("score"),
    timeLeft: $("time-left"),
    tps: $("tps"),
    best: $("best"),
    timeBar: $("time-bar"),
    roundStatus: $("round-status"),
    kvProgram: $("kv-program"),
    kvPda: $("kv-pda"),
    kvDelegated: $("kv-delegated"),
    kvEr: $("kv-er"),
    txLog: $("tx-log"),
    btnDemo: $("btn-demo-wallet"),
    btnPhantom: $("btn-phantom"),
    btnInit: $("btn-init"),
    btnDelegate: $("btn-delegate"),
    btnStart: $("btn-start"),
    btnFinish: $("btn-finish"),
    btnTap: $("btn-tap"),
};
function logTx(label, sig, layer, erEndpoint) {
    const url = layer === "base"
        ? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
        : `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(erEndpoint ?? ER_DEFAULT)}`;
    const li = document.createElement("li");
    li.innerHTML = `<b>${label}</b> <span class="dim">[${layer === "base" ? "Solana devnet" : "Ephemeral Rollup"}]</span><br/><a class="mono" href="${url}" target="_blank" rel="noopener">${sig.slice(0, 24)}…${sig.slice(-8)}</a> ↗`;
    const placeholder = el.txLog.querySelector(".dim");
    if (placeholder && el.txLog.children.length === 1)
        el.txLog.innerHTML = "";
    el.txLog.prepend(li);
    return url;
}
function setStatus(msg) {
    el.roundStatus.textContent = msg;
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const baseConn = new Connection(BASE_RPC, "confirmed");
const baseConnFallback = new Connection(BASE_RPC_FALLBACK, "confirmed");
let erConn = new Connection(ER_DEFAULT, "confirmed");
let erEndpoint = ER_DEFAULT;
let signer = null; // demo keypair (in-browser throwaway)
let phantom = null; // injected wallet, if connected
let playerPubkey = null;
let program = null;
let gamePda = null;
let delegated = false;
let roundActive = false;
let roundEndsAt = 0; // ms epoch (local clock, synced to chain start)
let tapsOptimistic = 0;
let tapTimes = [];
let inFlight = 0;
let pollTimer;
let countdownTimer;
function gamePdaFor(player) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("tap-blitz"), player.toBuffer()], PROGRAM_ID);
    return pda;
}
function makeProvider(conn) {
    const wallet = {
        publicKey: playerPubkey,
        signTransaction: async (tx) => {
            if (signer) {
                tx.partialSign(signer);
                return tx;
            }
            return phantom.signTransaction(tx);
        },
        signAllTransactions: async (txs) => {
            const out = [];
            for (const tx of txs)
                out.push(await wallet.signTransaction(tx));
            return out;
        },
    };
    return new AnchorProvider(conn, wallet, { commitment: "confirmed" });
}
function refreshProgram() {
    program = new Program(idl, makeProvider(baseConn));
}
async function refreshBalance() {
    if (!playerPubkey)
        return;
    try {
        const lamports = await baseConn.getBalance(playerPubkey);
        el.walletBalance.textContent = `Balance: ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (devnet)`;
    }
    catch {
        el.walletBalance.textContent = "Balance: ? (RPC hiccup — retry in a moment)";
    }
}
// ---------------------------------------------------------------------------
// Wallet: demo keypair (throwaway, localStorage) or Phantom/Solflare
// ---------------------------------------------------------------------------
function loadOrCreateDemoKeypair() {
    const stored = localStorage.getItem("tapblitz-demo-secret");
    if (stored) {
        try {
            return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
        }
        catch {
            /* fall through and create a fresh one */
        }
    }
    const kp = Keypair.generate();
    localStorage.setItem("tapblitz-demo-secret", JSON.stringify(Array.from(kp.secretKey)));
    return kp;
}
async function usePlayer(pubkey) {
    playerPubkey = pubkey;
    gamePda = gamePdaFor(pubkey);
    refreshProgram();
    el.walletAddr.textContent = `Player: ${pubkey.toBase58()}`;
    el.kvProgram.textContent = PROGRAM_ID.toBase58();
    el.kvPda.textContent = gamePda.toBase58();
    el.btnInit.disabled = false;
    await refreshBalance();
    await refreshGameState();
}
el.btnDemo.addEventListener("click", async () => {
    el.btnDemo.disabled = true;
    try {
        signer = loadOrCreateDemoKeypair();
        phantom = null;
        await usePlayer(signer.publicKey);
        el.walletLine.textContent =
            "Demo wallet ready (throwaway keypair stored only in this browser). Funding from the devnet faucet…";
        // Airdrop 1 SOL — try the public devnet RPC first, MagicBlock RPC as fallback.
        let funded = false;
        for (const conn of [baseConn, baseConnFallback]) {
            try {
                const sig = await conn.requestAirdrop(signer.publicKey, LAMPORTS_PER_SOL);
                await conn.confirmTransaction(sig, "confirmed");
                funded = true;
                break;
            }
            catch (e) {
                console.warn("airdrop failed on", conn.rpcEndpoint, e);
            }
        }
        if (funded) {
            el.walletLine.textContent = "Demo wallet funded with 1 devnet SOL (free faucet).";
            await refreshBalance();
        }
        else {
            el.walletLine.textContent =
                "Demo wallet created, but the faucet is rate-limiting right now — wait a minute and press the button again (the same keypair is reused).";
        }
    }
    catch (e) {
        el.walletLine.textContent = `Demo wallet failed: ${e?.message ?? e}`;
    }
    finally {
        el.btnDemo.disabled = false;
    }
});
el.btnPhantom.addEventListener("click", async () => {
    const sol = window.solana;
    if (!sol || !sol.isPhantom) {
        el.walletLine.textContent =
            "No Phantom/Solflare wallet found in this browser. Use the demo wallet instead (one click, no install).";
        return;
    }
    try {
        const resp = await sol.connect();
        phantom = sol;
        signer = null;
        await usePlayer(new PublicKey(resp.publicKey.toString()));
        el.walletLine.textContent = "Wallet connected. Devnet SOL is needed for the base-layer steps (initialize + delegate).";
    }
    catch (e) {
        el.walletLine.textContent = `Wallet connect failed: ${e?.message ?? e}`;
    }
});
// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
async function confirmPoll(conn, sig, label) {
    // HTTP polling instead of confirmTransaction: the wss subscription web3.js
    // relies on can break behind proxies, so confirmations never arrive.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        const st = await conn.getSignatureStatus(sig);
        const v = st.value;
        if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
            if (v.err)
                throw new Error(`${label} failed on chain: ${JSON.stringify(v.err)}`);
            return;
        }
        if (v && v.err)
            throw new Error(`${label} failed on chain: ${JSON.stringify(v.err)}`);
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} not confirmed within 90s (sig ${sig})`);
}
async function sendBase(tx, label) {
    const { value: { blockhash, lastValidBlockHeight } } = await baseConn.getLatestBlockhashAndContext();
    tx.recentBlockhash = blockhash;
    tx.feePayer = playerPubkey;
    const signed = await makeProvider(baseConn).wallet.signTransaction(tx);
    const sig = await baseConn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
    });
    await confirmPoll(baseConn, sig, label);
    logTx(label, sig, "base");
    return sig;
}
async function sendEr(tx, label) {
    const { value: { blockhash, lastValidBlockHeight } } = await erConn.getLatestBlockhashAndContext();
    tx.recentBlockhash = blockhash;
    tx.feePayer = playerPubkey;
    const signed = await makeProvider(erConn).wallet.signTransaction(tx);
    // On the ER preflight is not a simulation — skip it and check the result.
    const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    await confirmPoll(erConn, sig, label);
    logTx(label, sig, "er", erEndpoint);
    return sig;
}
function uniqueNoop() {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    return new TransactionInstruction({
        programId: NOOP_PROGRAM,
        keys: [],
        data: Buffer.from(bytes),
    });
}
// ---------------------------------------------------------------------------
// Game state polling (reads the game account from the ER while delegated,
// otherwise from the base layer)
// ---------------------------------------------------------------------------
async function refreshGameState() {
    if (!program || !gamePda || !playerPubkey)
        return;
    const conn = delegated ? erConn : baseConn;
    try {
        const info = await conn.getAccountInfo(gamePda);
        if (!info) {
            el.best.textContent = "—";
            el.kvDelegated.textContent = "No (game not initialized yet)";
            return;
        }
        const g = await program.account.game.fetch(gamePda).catch(() => null);
        if (!g)
            return;
        el.best.textContent = String(g.best);
        const isDel = info.owner.equals(DELEGATION_PROGRAM);
        delegated = isDel;
        el.kvDelegated.textContent = isDel ? "YES — playing on the Ephemeral Rollup ⚡" : "No (on Solana base layer)";
        if (!roundActive) {
            el.score.textContent = String(g.taps);
            tapsOptimistic = Number(g.taps);
        }
    }
    catch (e) {
        console.warn("refreshGameState", e);
    }
}
// ---------------------------------------------------------------------------
// Router: ask where the account is delegated, get the ER endpoint (fqdn)
// ---------------------------------------------------------------------------
async function pollDelegationStatus(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(ROUTER_RPC, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getDelegationStatus",
                    params: [gamePda.toBase58()],
                }),
            });
            const json = await res.json();
            const result = json?.result ?? {};
            const text = JSON.stringify(result);
            const m = text.match(/https:\/\/[a-z0-9.-]*magicblock\.app/g);
            if (result.isDelegated === true || result.delegated === true) {
                return m ? m[0] : ER_DEFAULT;
            }
            // Fallback signal: base-layer owner flipped to the Delegation Program.
            const info = await baseConn.getAccountInfo(gamePda);
            if (info?.owner.equals(DELEGATION_PROGRAM))
                return m ? m[0] : ER_DEFAULT;
        }
        catch (e) {
            console.warn("delegation status poll", e);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
}
// ---------------------------------------------------------------------------
// Buttons: initialize / delegate / start / tap / finish
// ---------------------------------------------------------------------------
el.btnInit.addEventListener("click", async () => {
    if (!program || !gamePda || !playerPubkey)
        return;
    el.btnInit.disabled = true;
    setStatus("Initializing game on Solana devnet…");
    try {
        const tx = (await program.methods
            .initialize()
            .accounts({ game: gamePda, player: playerPubkey })
            .transaction());
        await sendBase(tx, "Initialize game");
        setStatus("Game initialized on Solana devnet. Now delegate it to the Ephemeral Rollup.");
        el.btnDelegate.disabled = false;
        await refreshGameState();
    }
    catch (e) {
        setStatus(`Initialize failed: ${e?.message ?? e}`);
        el.btnInit.disabled = false;
    }
});
el.btnDelegate.addEventListener("click", async () => {
    if (!program || !gamePda || !playerPubkey)
        return;
    el.btnDelegate.disabled = true;
    setStatus("Delegating to the Ephemeral Rollup (devnet-us)…");
    try {
        const tx = (await program.methods
            .delegate()
            .accounts({ payer: playerPubkey, pda: gamePda })
            .remainingAccounts([
            { pubkey: DEVNET_US_VALIDATOR, isSigner: false, isWritable: false },
        ])
            .transaction());
        await sendBase(tx, "Delegate to ER");
        setStatus("Delegation sent — waiting for the ER to pick up the account…");
        const fqdn = await pollDelegationStatus();
        if (fqdn) {
            erEndpoint = fqdn;
            erConn = new Connection(erEndpoint, "confirmed");
            el.kvEr.textContent = erEndpoint;
            delegated = true;
            setStatus("Delegated ⚡ — the game now lives on the Ephemeral Rollup. Press “Start round”.");
            el.btnStart.disabled = false;
            // Kick the ER so it loads the cloned account (tiny airdrop to the PDA).
            try {
                await erConn.requestAirdrop(gamePda, 1);
            }
            catch {
                /* best-effort only */
            }
            await refreshGameState();
        }
        else {
            setStatus("Delegation sent but the ER has not picked it up yet — wait 30s and press Delegate again to re-check.");
            el.btnDelegate.disabled = false;
        }
    }
    catch (e) {
        setStatus(`Delegate failed: ${e?.message ?? e}`);
        el.btnDelegate.disabled = false;
    }
});
el.btnStart.addEventListener("click", async () => {
    if (!program || !gamePda || !playerPubkey)
        return;
    el.btnStart.disabled = true;
    setStatus("Starting round on the Ephemeral Rollup…");
    try {
        const tx = (await program.methods
            .startRound()
            .accounts({ game: gamePda, player: playerPubkey })
            .transaction());
        await sendEr(tx, "Start round");
        roundActive = true;
        tapsOptimistic = 0;
        tapTimes = [];
        roundEndsAt = Date.now() + ROUND_SECONDS * 1000;
        el.score.textContent = "0";
        el.btnTap.disabled = false;
        el.btnFinish.disabled = false;
        setStatus("ROUND LIVE — tap as fast as you can! Each tap is a gasless ER transaction.");
        startCountdown();
        pollTimer = window.setInterval(refreshGameState, 500);
    }
    catch (e) {
        setStatus(`Start round failed: ${e?.message ?? e}`);
        el.btnStart.disabled = false;
    }
});
el.btnTap.addEventListener("click", async () => {
    if (!roundActive || !program || !gamePda || !playerPubkey)
        return;
    if (Date.now() >= roundEndsAt)
        return;
    // Optimistic UI — the chain poll corrects the number within ~0.5s.
    tapsOptimistic += 1;
    tapTimes.push(Date.now());
    el.score.textContent = String(tapsOptimistic);
    if (inFlight >= 8)
        return; // backpressure: don't flood the ER
    inFlight += 1;
    try {
        const tx = (await program.methods
            .tap()
            .accounts({ game: gamePda, player: playerPubkey })
            .transaction());
        tx.add(uniqueNoop());
        await sendEr(tx, "Tap");
    }
    catch (e) {
        console.warn("tap failed", e);
    }
    finally {
        inFlight -= 1;
    }
});
el.btnFinish.addEventListener("click", async () => {
    if (!program || !gamePda || !playerPubkey)
        return;
    el.btnFinish.disabled = true;
    el.btnTap.disabled = true;
    roundActive = false;
    stopTimers();
    setStatus("Finishing round — committing the final score back to Solana…");
    try {
        const tx = (await program.methods
            .finishRound()
            .accounts({ payer: playerPubkey, game: gamePda })
            .transaction());
        await sendEr(tx, "Finish round (commit + undelegate)");
        delegated = false;
        // Wait for the base layer to show the committed account again.
        for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const info = await baseConn.getAccountInfo(gamePda);
            if (info && !info.owner.equals(DELEGATION_PROGRAM))
                break;
        }
        await refreshGameState();
        const best = el.best.textContent;
        setStatus(`Round over! Final score ${tapsOptimistic} taps — best on Solana devnet: ${best}. The commit transaction above is the proof. Play again: press “Delegate to ER”.`);
        el.btnDelegate.disabled = false;
        el.btnStart.disabled = true;
    }
    catch (e) {
        setStatus(`Finish failed: ${e?.message ?? e} — the round may still be delegated; press “Delegate” to re-check, or Finish again.`);
        el.btnFinish.disabled = false;
    }
});
// ---------------------------------------------------------------------------
// Countdown + taps/sec
// ---------------------------------------------------------------------------
function startCountdown() {
    stopTimers();
    countdownTimer = window.setInterval(() => {
        const left = Math.max(0, roundEndsAt - Date.now());
        el.timeLeft.textContent = `${(left / 1000).toFixed(1)}s`;
        el.timeBar.style.width = `${(left / (ROUND_SECONDS * 1000)) * 100}%`;
        const now = Date.now();
        tapTimes = tapTimes.filter((t) => now - t < 1000);
        el.tps.textContent = tapTimes.length.toFixed(1);
        if (left <= 0) {
            el.btnTap.disabled = true;
            setStatus("Time! Press “Finish & commit to Solana” to settle your score on-chain.");
        }
    }, 100);
}
function stopTimers() {
    if (countdownTimer)
        clearInterval(countdownTimer);
    if (pollTimer)
        clearInterval(pollTimer);
    countdownTimer = undefined;
    pollTimer = undefined;
}
// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
el.kvProgram.textContent = PROGRAM_ID.toBase58();
el.kvEr.textContent = ER_DEFAULT;
if (window.solana?.isPhantom) {
    el.btnPhantom.textContent = "Connect Phantom";
}
