import dotenv from "dotenv";
import crypto from "crypto";
import querystring from "querystring";
import https from "https";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ======================================================
   CONFIG & INITIALIZATION
====================================================== */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, INDODAX_API_KEY, INDODAX_SECRET_KEY } = process.env;
const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";
const STATE_FILE = path.join(__dirname, "bot_state.json");

const CONFIG = {
    MAX_POSITIONS: 2,
    MIN_VOL_24H: 500_000_000,
    MAX_SPREAD: 0.3,
    MAX_PUMP_PERCENT: 15,
    RSI_MIN: 50,
    RSI_MAX: 100,
    MEM_LIMIT: 20,
    COOLDOWN_MIN: 20,
    BUY_PERCENT: 0.90, // Menggunakan 95% dari sisa saldo IDR
    TP_PERCENT: 1.8, // Tambahkan ini
    SL_PERCENT: 4,  // Tambahkan ini
    TRAILING_GAP: 0.5,
};

const BLACKLIST = new Set(["btc", "eth", "bnb", "usdt", "usdc", "busd", "dai", "wbtc", "weth", "xaut"]);


let state = {
    positions: {},
    cooldown: {},
    priceMemory: {},
    volMemory: {},
    equityNow: 0,
    sentiment: "NEUTRAL"
};

let isBuying = false; // Pengunci transaksi

/* ======================================================
   STATE MANAGEMENT
====================================================== */
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE));
    } catch (e) { console.log("State Corrupt."); }
}

const saveState = () => {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        if (e.code === 'EACCES') {
            console.log("❌ ERROR PERMISSION: Jalankan 'sudo chmod 777 bot_state.json'");
        }
    }
};

const formatIDR = (n) => new Intl.NumberFormat("id-ID").format(Math.floor(n || 0));

/* ======================================================
   NETWORKING & API
====================================================== */
function makeRequest(url, options, postData = null) {
    return new Promise((resolve, reject) => {
        options.rejectUnauthorized = false;
        const req = https.request(url, options, (res) => {
            let body = "";
            res.on("data", (chunk) => body += chunk);
            res.on("end", () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { resolve({ success: 0, error: "JSON Error" }); }
            });
        });
        req.on("error", (e) => reject(e));
        if (postData) req.write(postData);
        req.end();
    });
}

async function tg(msg) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const data = querystring.stringify({
            chat_id: TELEGRAM_CHAT_ID.trim(),
            text: msg,
            parse_mode: "HTML"
        });
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }, data);
    } catch (e) { console.log("TG Error:", e.message); }
}

async function privateReq(method, params = {}) {
    try {
        // Ganti baris nonce lama dengan ini:
        // Kita gunakan milidetik dikali 1000 untuk mensimulasikan mikrodetik
        const nonce = Date.now() * 1000;

        const payload = { method, nonce, ...params };
        const postData = querystring.stringify(payload);

        if (!INDODAX_SECRET_KEY) throw new Error("Secret Key Kosong di .env");

        const sign = crypto.createHmac("sha512", INDODAX_SECRET_KEY).update(postData).digest("hex");
        const options = {
            method: "POST",
            headers: {
                "Key": INDODAX_API_KEY,
                "Sign": sign,
                "Content-Type": "application/x-www-form-urlencoded"
            }
        };

        const res = await makeRequest(TAPI_URL, options, postData);

        if (res.success !== 1) {
            console.log(`⚠️ Indodax Reject [${method}]: ${res.error}`);
            // Jika masih kurang besar, tambahkan log untuk melihat angka pastinya
        }

        return res.success === 1 ? { success: true, data: res.return } : { success: false, error: res.error };
    } catch (e) {
        console.log("❌ Request Error:", e.message);
        return { success: false, error: e.message };
    }
}

async function refreshBalance() {
    const auth = await privateReq("getInfo");
    if (auth.success) {
        state.equityNow = Number(auth.data.balance.idr || 0);
        return true;
    }
    return false;
}

/* ======================================================
   INDICATORS & EVALUATION
====================================================== */
const rsi14 = (prices) => {
    if (!prices || prices.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - 14; i < prices.length; i++) {
        const diff = prices[i] - (prices[i - 1] || prices[i]);
        if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / 14) / (losses / 14);
    return 100 - (100 / (1 + rs));
};

function evaluate(pair, t) {
    const price = Number(t.last || 0);
    const vol = Number(t.vol_idr || 0);
    const buyP = Number(t.buy || 0);
    const sellP = Number(t.sell || 0);
    const lowP = Number(t.low || 1);
    const spread = buyP > 0 ? ((sellP - buyP) / buyP) * 100 : 0;
    const pump = ((price - lowP) / lowP) * 100;
    const mem = state.priceMemory[pair] || [];
    const rsi = rsi14(mem);
    const lastPrice = mem[mem.length - 1];
    const prevPrice = mem[mem.length - 2];

    if (lastPrice < prevPrice) return { score: 0, rsi, reason: "Price Dropping" };
    if (vol < CONFIG.MIN_VOL_24H) return { score: 0, rsi, reason: "Vol Low" };
    if (spread > CONFIG.MAX_SPREAD) return { score: 0, rsi, reason: "Spread" };
    if (pump > CONFIG.MAX_PUMP_PERCENT) return { score: 0, rsi, reason: "Pumped" };
    if (mem.length < CONFIG.MEM_LIMIT) return { score: 0, rsi, reason: `Wait(${mem.length})` };
    if (rsi < CONFIG.RSI_MIN || rsi > CONFIG.RSI_MAX) return { score: 0, rsi, reason: "RSI Out" };

    let score = 5;
    if (rsi >= 50 && rsi <= 60) score += 3;
    if (state.sentiment === "BEARISH") score -= 7;
    return { score, rsi, reason: "READY" };
}

/* ======================================================
   EXECUTION ENGINE
====================================================== */
async function executeBuy(pair, price) {
    // 1. CEK PENGUNCI (Mencegah Race Condition/Pembelian Ganda)
    if (isBuying) return;
    isBuying = true; // Pasang kunci

    try {
        // 2. REFRESH SALDO TERBARU
        await refreshBalance();

        // 3. HITUNG ALOKASI DANA
        // Menghitung slot yang tersedia (MAX_POSITIONS - posisi_saat_ini)
        const openSlots = CONFIG.MAX_POSITIONS - Object.keys(state.positions).length;

        if (openSlots <= 0) {
            console.log(`[SKIP] Slot penuh, tidak bisa membeli ${pair}`);
            return;
        }

        // Bagi sisa saldo dengan jumlah slot yang tersedia, lalu ambil 95% (BUY_PERCENT)
        const availableIDR = state.equityNow / openSlots;
        const spend = Math.floor(availableIDR * CONFIG.BUY_PERCENT);

        // 4. KIRIM PERINTAH BELI KE INDODAX
        const buyPrice = Math.ceil(price * 1.005);
        const res = await privateReq("trade", {
            pair,
            type: "buy",
            price: buyPrice, // Gunakan harga yang sudah dinaikkan sedikit
            idr: spend
        });

        // 5. JIKA BERHASIL, SIMPAN KE STATE & KIRIM TELEGRAM
        if (res.success) {
            // 1. Hitung Harga Target Riil (TP & SL)
            const targetPrice = price * (1 + CONFIG.TP_PERCENT / 100);
            const stopPrice = price * (1 - CONFIG.SL_PERCENT / 100);

            // 2. Hitung Estimasi Untung/Rugi Bersih (Asumsi Fee Indodax ~1.02% bolak-balik)
            const estimatedFee = 1.02;
            const netProfitPercent = (CONFIG.TP_PERCENT - estimatedFee).toFixed(2);
            const netLossPercent = (CONFIG.SL_PERCENT + estimatedFee).toFixed(2);

            // 3. Hitung Nominal Rupiah Bersih (Modal x Persen Bersih)
            const potensiUntung = Math.floor(spend * (netProfitPercent / 100));
            const potensiRugi = Math.floor(spend * (netLossPercent / 100));

            // 3. Simpan ke State
            state.positions[pair] = {
                entry: price,
                high: price,
                target: targetPrice,
                stop: stopPrice,
                coin: pair.split("_")[0],
                time: new Date().toLocaleString("id-ID")
            };

            saveState();
            await refreshBalance();

            // 4. Kirim Notifikasi Telegram yang Informatif
            const msg = `🚀 <b>BUY EXECUTED</b>\n` +
                `--------------------------\n` +
                `<b>Pair</b>      : ${pair.toUpperCase()}\n` +
                `<b>Price</b>     : ${formatIDR(price)}\n` +
                `--------------------------\n` +
                `<b>Target TP</b> : ${formatIDR(targetPrice)}\n` +
                `<b>Estimasi</b>  : <pre>+Rp ${formatIDR(potensiUntung)}</pre> (<b>+${netProfitPercent}% Net</b>)\n` +
                `--------------------------\n` +
                `<b>Stop Loss</b> : ${formatIDR(stopPrice)}\n` +
                `<b>Estimasi</b>  : <pre>-Rp ${formatIDR(potensiRugi)}</pre> (<b>-${netLossPercent}% Net</b>)\n` +
                `--------------------------\n` +
                `<b>Modal Beli</b> : Rp ${formatIDR(spend)}\n` +
                `<b>Sisa IDR</b>   : Rp ${formatIDR(state.equityNow)}\n` +
                `--------------------------`;
            await tg(msg);

            console.log(`\x1b[32m[SUCCESS] Berhasil membeli ${pair} di harga ${price}\x1b[0m`);
        } else {
            console.log(`\x1b[31m[FAILED] Gagal membeli ${pair}: ${res.error}\x1b[0m`);
        }

    } catch (e) {
        console.log("❌ ERROR di executeBuy:", e.message);
    } finally {
        // 6. BUKA KUNCI (Apapun hasilnya, kunci harus dibuka agar bot bisa membeli koin lain nanti)
        isBuying = false;
    }
}

async function executeSell(pair, price, reason) {
    const pos = state.positions[pair];
    const auth = await privateReq("getInfo");
    if (!auth.success) return;
    const amount = auth.data.balance[pos.coin] || 0;
    if (Number(amount) <= 0) { delete state.positions[pair]; saveState(); return; }

    const res = await privateReq("trade", {
        pair,
        type: "sell",
        price: Math.floor(price * 0.997),
        [pos.coin]: amount
    });

    if (res.success) {
        const pnlPercent = ((price - pos.entry) / pos.entry * 100).toFixed(2);

        // Menghitung keuntungan/kerugian bersih dalam Rupiah (setelah dipotong fee jual)
        // Rumus sederhana: (Harga Jual * Jumlah Koin) - Modal Beli
        const totalTerima = Math.floor(price * amount * 0.9979);
        const modalAwal = Math.floor(pos.entry * amount * 1.0051);
        const untungRugiBersih = totalTerima - modalAwal;

        const pnlIcon = untungRugiBersih >= 0 ? "💰" : "📉";
        const sign = untungRugiBersih >= 0 ? "+" : "";

        delete state.positions[pair];
        state.cooldown[pair] = Date.now();
        saveState();
        await refreshBalance();

        const msg = `${pnlIcon} <b>SELL EXECUTED (${reason})</b>\n` +
            `--------------------------\n` +
            `<b>Pair</b>    : ${pair.toUpperCase()}\n` +
            `<b>Price</b>   : ${formatIDR(price)}\n` +
            `<b>Result</b>  : <pre>${sign}Rp ${formatIDR(untungRugiBersih)}</pre> (<b>${pnlPercent}%</b>)\n` +
            `--------------------------\n` +
            `<b>Saldo IDR</b> : Rp ${formatIDR(state.equityNow)}\n` +
            `--------------------------`;
        await tg(msg);
    }
}

/* ======================================================
   MAIN SCANNER LOOP
====================================================== */
/* ======================================================
    OPTIMIZED SCANNER LOOP WITH EFFICIENT AUTO-SYNC
====================================================== */
async function scan() {
    try {
        // 1. Ambil data saldo LENGKAP di awal (Sekali saja per scan)
        const auth = await privateReq("getInfo");
        if (auth.success) {
            state.equityNow = Number(auth.data.balance.idr || 0);
        }

        // 2. Ambil data market
        const response = await axios.get(PUBLIC_URL, { timeout: 10000 });
        if (!response.data || !response.data.tickers) {
            setTimeout(scan, 8000);
            return;
        }

        const tickers = response.data.tickers;
        let upCount = 0;
        let totalPair = 0;
        const ranked = [];

        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;
            const base = pair.split("_")[0];

            const price = Number(t.last || 0);
            if (!price) continue;

            // Selalu simpan history harga untuk RSI, sebelum filter apa pun
            state.priceMemory[pair] = [...(state.priceMemory[pair] || []), price].slice(-40);

            // ======================================================
            // 1. LOGIKA PINNED POSITION & AUTO-SYNC (PRIORITAS)
            // ======================================================
            // Diletakkan SEBELUM filter blacklist agar auto-sync tetap jalan
            if (state.positions[pair]) {
                const pos = state.positions[pair];

                // A. Cek saldo koin (Sync jika sudah terjual manual)
                const actualCoinBalance = auth.success ? Number(auth.data.balance[pos.coin] || 0) : -1;

                if (auth.success && actualCoinBalance <= 0) {
                    console.log(`\x1b[33m[AUTO-SYNC] ${pair.toUpperCase()} sudah terjual manual. Menghapus PIN...\x1b[0m`);
                    delete state.positions[pair];
                    saveState();
                    continue; // Pindah ke koin berikutnya
                }

                // B. Update Harga Tertinggi (Trailing High)
                if (price > (pos.high || pos.entry)) {
                    state.positions[pair].high = price;
                    saveState();
                }

                // C. Hitung Batas Stop (Dynamic)
                const trailingStop = (state.positions[pair].high || pos.entry) * (1 - CONFIG.TRAILING_GAP / 100);
                const initialStop = pos.entry * (1 - CONFIG.SL_PERCENT / 100);
                const finalStop = Math.max(initialStop, trailingStop);
                const maxTarget = pos.entry * (1 + CONFIG.TP_PERCENT / 100);

                // D. Eksekusi Jual Otomatis
                if (price >= maxTarget) {
                    await executeSell(pair, price, `MAX TAKE PROFIT (${CONFIG.TP_PERCENT}%)`);
                    continue;
                }
                else if (price <= finalStop) {
                    const pnlReal = ((price - pos.entry) / pos.entry * 100).toFixed(2);
                    const reason = price > pos.entry ? `TRAILING STOP (${pnlReal}%)` : `STOP LOSS (${pnlReal}%)`;
                    await executeSell(pair, price, reason);
                    continue;
                }
            }

            // ======================================================
            // 2. FILTER BLACKLIST & SCANNING BELI
            // ======================================================
            // Baru di sini kita filter koin blacklist agar tidak dibeli lagi
            if (BLACKLIST.has(base)) continue;

            const result = evaluate(pair, t);
            ranked.push({ pair, ...result });

            // Hitung statistik sentimen pasar
            if ((price - Number(t.low || 0)) / Number(t.low || 1) > 0.04) upCount++;
            totalPair++;
        }

        // 4. SENTIMEN & SORTING
        const ratio = upCount / totalPair;
        state.sentiment = ratio > 0.45 ? "BULLISH" : ratio < 0.35 ? "BEARISH" : "SIDEWAYS";
        ranked.sort((a, b) => b.score - a.score);

        // 5. MONITOR TAMPILAN
        console.clear();
        console.log(`\x1b[36m=== ULTRA STABLE FUND BOT v3.6 ===\x1b[0m`);
        console.log(`Sentimen : ${state.sentiment} (${(ratio * 100).toFixed(0)}% Up)`);
        console.log(`Saldo    : Rp ${formatIDR(state.equityNow)}`);
        console.log(`Posisi   : ${Object.keys(state.positions).length} / ${CONFIG.MAX_POSITIONS}`);
        console.log(`-------------------------------------------`);

        ranked.slice(0, 5).forEach(r => {
            const color = r.score >= 7 ? "\x1b[32m" : "\x1b[0m";
            console.log(`${color}${r.pair.padEnd(12)} Score: ${r.score.toString().padEnd(3)} RSI: ${r.rsi.toFixed(0).padEnd(3)} Status: ${r.reason}\x1b[0m`);
        });

        if (Object.keys(state.positions).length > 0) {
            console.log(`\n\x1b[33m📌 PINNED POSITIONS (AKTIF):\x1b[0m`);
            for (const p in state.positions) {
                const pos = state.positions[p];
                const curPrice = Number(tickers[p]?.last || 0);
                const pnl = ((curPrice - pos.entry) / pos.entry * 100).toFixed(2);
                const colorPnL = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
                console.log(` > ${p.toUpperCase().padEnd(10)} | ${colorPnL}${pnl}% \x1b[0m| Target: ${formatIDR(pos.target)}`);
            }
        }

        // 6. LOGIKA BELI SMART
        const topPick = ranked.find(r =>
            r.score >= 8 &&
            !state.positions[r.pair] &&
            !isBuying && // JANGAN BELI jika bot sedang memproses pembelian lain
            (Date.now() - (state.cooldown[r.pair] || 0) > CONFIG.COOLDOWN_MIN * 60000)
        );

        if (topPick && Object.keys(state.positions).length < CONFIG.MAX_POSITIONS && state.sentiment !== "BEARISH") {
            await executeBuy(topPick.pair, Number(tickers[topPick.pair].last));
        }

        saveState();
    } catch (err) {
        console.log("Scan Error:", err.message);
    }
    setTimeout(scan, 8000);
}

/* ======================================================
   START BOT
====================================================== */
(async () => {
    console.log("Menginisialisasi Bot...");
    const success = await refreshBalance();
    if (success) {
        console.log("Koneksi API Berhasil. Saldo Terdeteksi.");
        await tg(`🤖 <b>Bot Started Successfully</b>\nSaldo: Rp ${formatIDR(state.equityNow)}`);
        scan();
    } else {
        console.log("Gagal mengambil saldo. Periksa API KEY!");
    }
})();