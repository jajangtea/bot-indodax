import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import querystring from "querystring";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

/* =========================
    SETUP & CONFIG
========================= */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    INDODAX_API_KEY,
    INDODAX_SECRET_KEY
} = process.env;

const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";

const FETCH_MIN = 10000;
const FETCH_MAX = 25000;

const MAX_POSITIONS = 1;

const BASE_TP = 3;
const BASE_SL = 4;
const MIN_VOL_24H = 5_000_000_000; // 5 Miliar (Hanya koin likuid & ramai)

const BUY_ZONE_SCORE = 6.5;


const BLACKLIST = new Set(["btc", "eth", "bnb", "iotx", "usdt", "usdc", "busd", "dai", "wbtc", "weth", "xaut", "paal"]);

const chromeCiphers = [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256'
].join(':');

const axiosInstance = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({
        keepAlive: true,
        ciphers: chromeCiphers,
        honorCipherOrder: true
    }),
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
        "Referer": "https://indodax.com/"
    }
});

/* =========================
    STATE MANAGEMENT
========================= */
const state = {
    price: {},
    volume: {},
    positions: {},
    cooling: false,
    cachedBalance: 0
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

const truncate = (num, fixed) => {
    const re = new RegExp('^-?\\d+(?:\\.\\d{0,' + (fixed || 0) + '})?');
    const match = num.toString().match(re);
    return match ? match[0] : "0";
};

/* =========================
    API FUNCTIONS
========================= */
async function tg(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 *SEROK BOT*:\n${msg}`,
            parse_mode: "Markdown"
        });
    } catch (e) { }
}

async function privateReq(method, params = {}) {
    if (state.cooling) return { success: false };
    try {
        const payload = { method, timestamp: Date.now(), recvWindow: 15000, ...params };
        const postData = querystring.stringify(payload);
        const signature = crypto.createHmac("sha512", INDODAX_SECRET_KEY).update(postData).digest("hex");
        const { data } = await axiosInstance.post(TAPI_URL, postData, {
            headers: { Key: INDODAX_API_KEY, Sign: signature }
        });
        if (data.success === 1) return { success: true, data: data.return };
        return { success: false, error: data.error || "Unknown API Error" };
    } catch (e) {
        if (e.response?.status === 403 || e.response?.status === 429) {
            state.cooling = true;
            setTimeout(() => state.cooling = false, 60000);
        }
        return { success: false, error: e.message };
    }
}

/* =========================
    LOGIC & STRATEGY
========================= */
function getEntryScore(pair, t) {
    const h = state.price[pair];
    if (!h || h.length < 5) return 0;

    const currentPrice = Number(t.last);
    const prevPrice = h.at(-2);
    const firstPrice = h[0];

    const shortChange = (currentPrice - prevPrice) / prevPrice;
    const longChange = (currentPrice - firstPrice) / firstPrice;

    let score = 0;
    if (shortChange > 0.003) score += 3;
    if (longChange > 0.01) score += 3;

    if (!state.volume[pair]) state.volume[pair] = [];
    state.volume[pair].push(Number(t.vol_idr));
    if (state.volume[pair].length > 10) state.volume[pair].shift();

    if (state.volume[pair].length > 2) {
        const lastVol = state.volume[pair].at(-1);
        const avgVol = state.volume[pair].reduce((a, b) => a + b) / state.volume[pair].length;
        if (lastVol > avgVol * 1.5) score += 4;
    }
    return score;
}

const getIndoDate = () => {
    const date = new Date();
    const opsi = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    };
    // Mengubah ke format Indonesia dan menambahkan hashtag di depan hari
    return "#" + date.toLocaleDateString('id-ID', opsi).replace(/ /g, ' ');
};

async function executeBuy(pair, price, score) {
    if (Object.keys(state.positions).length >= MAX_POSITIONS) return;
    if (state.positions[pair]) return;

    const capital = Math.floor(state.cachedBalance * 0.75);
    if (capital < 11000) return;

    const res = await privateReq("trade", {
        pair, type: "buy", price: price, idr: capital
    });

    if (res.success) {
        const tpPrice = price * (1 + BASE_TP / 100);
        const slPrice = price * (1 - BASE_SL / 100);
        const coinName = pair.split("_")[0].toUpperCase();

        state.positions[pair] = {
            buyPrice: price,
            capital: capital,
            tp: tpPrice,
            sl: slPrice,
            coin: pair.split("_")[0],
            isTrailing: false
        };

        // NOTIFIKASI TELEGRAM ENTRY
        const msg = `📥 *BELI* #${coinName}\n` +
            `🪙 *${pair.toUpperCase()}*\n` +
            `---------------------------\n` +
            `📥 Entry  : ${price.toLocaleString()}\n` +
            `🎯 Target : ${Math.floor(tpPrice).toLocaleString()} (TP)\n` +
            `🛡️ Guard  : ${Math.floor(slPrice).toLocaleString()} (SL)\n` +
            `💰 Modal  : Rp ${capital.toLocaleString()}`;
        tg(msg);

        console.log(`\x1b[42m SUCCESS \x1b[0m #${coinName} Berhasil dibeli!`);
        state.cachedBalance -= capital;
    }
}

async function managePositions(pair, currentPrice) {
    const pos = state.positions[pair];
    if (!pos) return;

    const gainPercent = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

    // Trailing Stop Logic
    if (gainPercent > 0.8 && !pos.isTrailing) {
        pos.sl = pos.buyPrice * 1.002;
        pos.isTrailing = true;
    }

    // Cek Kondisi Jual
    if (currentPrice <= pos.sl || currentPrice >= pos.tp) {
        const info = await privateReq("getInfo");
        if (!info.success) return;

        const rawAmt = info.data.balance[pos.coin] || 0;
        const amt = truncate(rawAmt, 8);

        if (Number(amt) <= 0) {
            delete state.positions[pair];
            return;
        }

        const res = await privateReq("trade", {
            pair, type: "sell", price: Math.floor(currentPrice * 0.998), [pos.coin]: amt
        });

        if (res.success) {
            const coinName = pair.split("_")[0].toUpperCase();

            // 1. Gunakan harga eksekusi yang dikirim ke sistem (0.2% di bawah market agar instan)
            const executionPrice = Math.floor(currentPrice * 0.998);

            // 2. Gunakan BigInt atau pastikan presisi desimal terjaga saat hitung hasil kotor
            // Kita hitung kotor: Jumlah Koin * Harga Jual
            const grossSales = Number(amt) * executionPrice;

            // 3. Potong estimasi Fee Indodax (0.51%). Net = 99.49% dari hasil kotor
            const netSales = grossSales * 0.9949;

            // 4. Profit Bersih = Uang Diterima - Modal Awal
            const profitIDR = netSales - pos.capital;

            // 5. Gunakan Math.round agar pembulatan IDR lebih manusiawi (tidak dipaksa ke bawah)
            const displayProfit = Math.round(profitIDR);

            const statusEmoji = profitIDR >= 0 ? "✅ UNTUNG" : "❌ RUGI";
            const icon = profitIDR >= 0 ? "💰" : "📉";
            const tglHashtag = getIndoDate();

            // NOTIFIKASI TELEGRAM
            const msg = `${tglHashtag}\n📤 *JUAL* #${coinName}\n` +
                `---------------------------\n` +
                `ℹ️ Status : *${statusEmoji}*\n` +
                `${icon} P/L Rp : Rp ${displayProfit.toLocaleString('id-ID')}\n` +
                `📈 P/L %  : ${gainPercent.toFixed(2)}%\n` +
                `💵 Exit   : ${executionPrice.toLocaleString('id-ID')}`;

            tg(msg);

            delete state.positions[pair];
            state.cachedBalance = 0; // Trigger refresh saldo asli dari API di scan berikutnya
        }
    }
}

/* =========================
    MAIN SCANNER
========================= */
async function scan() {
    // 1. Update Saldo Terkini
    const info = await privateReq("getInfo");
    if (info.success) {
        state.cachedBalance = Number(info.data.balance.idr);
    }

    if (state.cooling) {
        console.log("🛑 Cooldown... Memeriksa Cloudflare.");
        setTimeout(scan, 30000);
        return;
    }

    try {
        const { data } = await axiosInstance.get(PUBLIC_URL);
        const tickers = data.tickers;
        const currentRanked = [];
        const activePairs = Object.keys(state.positions);

        console.clear();
        console.log(`\x1b[1m\x1b[36m==================================================================\x1b[0m`);
        console.log(`\x1b[1m\x1b[32m 🤖 SEROK BOT PRO V3 \x1b[0m | 🕒 ${new Date().toLocaleTimeString()}`);
        console.log(`\x1b[1m\x1b[36m==================================================================\x1b[0m`);

        // TAMPILAN POSISI AKTIF (PINNED)
        if (activePairs.length > 0) {
            console.log(`\x1b[33m📍 POSISI AKTIF (Monitoring TP/SL):\x1b[0m`);
            console.log(`------------------------------------------------------------------`);
            for (const pair of activePairs) {
                const price = Number(tickers[pair].last);
                const pos = state.positions[pair];
                const pnl = ((price - pos.buyPrice) / pos.buyPrice * 100).toFixed(2);

                // Warna P/L
                const color = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";

                // Format Baris Posisi
                console.log(`🪙  \x1b[1m${pair.toUpperCase().padEnd(10)}\x1b[0m | P/L: ${color}${pnl}%\x1b[0m`);
                console.log(`   📥 Entry : ${pos.buyPrice.toLocaleString()}`);
                console.log(`   🎯 Target: \x1b[32m${Math.floor(pos.tp).toLocaleString()}\x1b[0m (TP)`);
                console.log(`   🛡️ Guard : \x1b[31m${Math.floor(pos.sl).toLocaleString()}\x1b[0m (SL)`);
                console.log(`------------------------------------------------------------------`);

                // Jalankan fungsi jual otomatis jika menyentuh TP/SL
                await managePositions(pair, price);
            }
        }

        const formatVol = (val) => {
            if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "Bn";
            if (val >= 1_000_000) return (val / 1_000_000).toFixed(0) + "Mn";
            return val.toLocaleString();
        };

        for (const pair in tickers) {
            if (!pair.endsWith("_idr") || BLACKLIST.has(pair.split("_")[0])) continue;

            const t = tickers[pair];
            const price = Number(t.last);
            const rawVol = Number(t.vol_idr);

            if (!state.price[pair]) state.price[pair] = [];
            state.price[pair].push(price);
            if (state.price[pair].length > 20) state.price[pair].shift();

            const score = getEntryScore(pair, t);

            if (rawVol > MIN_VOL_24H) {
                currentRanked.push({ pair, score, price, displayVol: formatVol(rawVol) });
            }
        }

        console.log(`\x1b[34m🔍 WATCHLIST (Trend Monitoring):\x1b[0m`);
        // 1. Urutkan: Koin Bn di atas, Koin Mn di bawah. 
        // 2. Di dalam kelompok yang sama, urutkan berdasarkan Skor tertinggi.
        currentRanked.sort((a, b) => {
            const volA = tickers[a.pair].vol_idr;
            const volB = tickers[b.pair].vol_idr;

            // Jika satu koin Bn dan satu lagi Mn, Bn selalu di atas
            if (volB >= 1_000_000_000 && volA < 1_000_000_000) return 1;
            if (volA >= 1_000_000_000 && volB < 1_000_000_000) return -1;

            // Jika sama-sama Bn atau sama-sama Mn, urutkan berdasarkan skor
            return b.score - a.score;
        });
        const topWatch = currentRanked.slice(0, 10);

        if (topWatch.length === 0) {
            console.log(`   😴 Tidak ada koin aktif saat ini.`);
        } else {
            console.log(`${"PAIR".padEnd(12)} | ${"VOL".padStart(7)} | ${"SCORE".padStart(7)} | STATUS`);
            topWatch.forEach(r => {
                let status = "\x1b[90mMonitoring\x1b[0m";
                if (r.score >= 3) status = "\x1b[33m🔥 Panas\x1b[0m";
                if (r.score >= BUY_ZONE_SCORE) status = "\x1b[31m🚀 BUY ZONE\x1b[0m";
                console.log(`${r.pair.toUpperCase().padEnd(12)} | ${r.displayVol.padStart(7)} | ${r.score.toFixed(1).padStart(6)} | ${status}`);
            });
        }

        // Eksekusi jika ada kandidat skor 7+
        const candidates = currentRanked.filter(r => r.score >= BUY_ZONE_SCORE);
        for (const c of candidates.slice(0, 1)) {
            await executeBuy(c.pair, c.price, c.score);
            await sleep(jitter(2000, 5000));
        }

        console.log(`\x1b[36m==================================================================\x1b[0m`);
        console.log(`💰 Saldo IDR: Rp ${Math.floor(state.cachedBalance).toLocaleString()}`);
        console.log(`📡 Next scan: ~${Math.floor(FETCH_MIN / 1000)} detik`);

    } catch (e) {
        console.error("Scan Error:", e.message);
    }
    setTimeout(scan, jitter(FETCH_MIN, FETCH_MAX));
}

/* =========================
    INITIALIZE
========================= */
(async () => {
    console.log("Sedang login ke Indodax...");
    const auth = await privateReq("getInfo");
    if (auth.success) {
        state.cachedBalance = Number(auth.data.balance.idr);
        console.log("Login Berhasil!");
        tg("🟢 *BOT ONLINE* - Memulai pemindaian market...");
        scan();
    } else {
        console.error("Gagal Login! Error:", auth.error);
    }
})();