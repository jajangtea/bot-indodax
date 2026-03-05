import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import querystring from "querystring";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

/* =========================
    SETUP
========================= */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, INDODAX_API_KEY, INDODAX_SECRET_KEY } = process.env;

const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";

const FETCH_MIN = 5000;
const FETCH_MAX = 8000;
const MAX_POSITIONS = 1;

const BASE_TP = 2.5;
const BASE_SL = 1.8;
const MIN_VOL_24H = 1_000_000_000;

const BUY_ZONE_SCORE = 7;

const BLACKLIST = new Set(["btc", "eth", "bnb", "usdt", "usdc", "busd", "dai", "wbtc", "weth", "xaut"]);

const axiosInstance = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
});

/* =========================
    STATE
========================= */
const state = {
    price: {},
    volume: {},
    positions: {},
    cooling: false,
    cachedBalance: 0,
    positionLock: false,
    dailyReport: {
        totalTrades: 0,
        win: 0,
        loss: 0,
        netProfitIDR: 0,
        lastReset: new Date().getDate()
    }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(Math.random() * (b - a + 1) + a);

/* =========================
    API
========================= */
async function tg(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 SEROK BOT\n${msg}`,
            parse_mode: "Markdown"
        });
    } catch { }
}

async function privateReq(method, params = {}) {
    if (state.cooling) return { success: false };
    try {
        const payload = { method, timestamp: Date.now(), recvWindow: 15000, ...params };
        const postData = querystring.stringify(payload);
        const sign = crypto.createHmac("sha512", INDODAX_SECRET_KEY).update(postData).digest("hex");

        const { data } = await axiosInstance.post(TAPI_URL, postData, { headers: { Key: INDODAX_API_KEY, Sign: sign } });
        if (data.success === 1) return { success: true, data: data.return };
        return { success: false, error: data.error };
    } catch (e) {
        if (e.response?.status === 403 || e.response?.status === 429) {
            state.cooling = true;
            setTimeout(() => state.cooling = false, 60000);
        }
        return { success: false, error: e.message };
    }
}

/* =========================
    STRATEGY
========================= */
function getEntryScore(pair, t) {
    const h = state.price[pair];
    if (!h || h.length < 5) return 0;

    const current = Number(t.last);
    const prev = h.at(-2);
    const first = h[0];

    let score = 0;

    const short = (current - prev) / prev;
    const long = (current - first) / first;

    if (short > 0.003) score += 3;
    if (long > 0.01) score += 3;

    if (!state.volume[pair]) state.volume[pair] = [];
    state.volume[pair].push(Number(t.vol_idr));
    if (state.volume[pair].length > 10) state.volume[pair].shift();

    if (state.volume[pair].length > 2) {
        const last = state.volume[pair].at(-1);
        const avg = state.volume[pair].reduce((a, b) => a + b, 0) / state.volume[pair].length;
        if (last > avg * 1.5) score += 4;
    }

    return score;
}

/* =========================
    REVISI STRATEGY & EXECUTION
========================= */

// 1. Perbaikan fungsi executeBuy agar lebih tahan banting
async function executeBuy(pair, price, score) {
    if (state.positionLock || state.cooling) return;
    if (Object.keys(state.positions).length >= MAX_POSITIONS) return;
    if (state.positions[pair]) return;

    state.positionLock = true;

    try {
        // Refresh saldo sebelum beli untuk memastikan modal akurat
        const info = await privateReq("getInfo");
        if (!info.success) throw new Error("Gagal ambil saldo");

        state.cachedBalance = Number(info.data.balance.idr);
        const capital = Math.floor(state.cachedBalance * 0.75);

        if (capital < 11000) {
            console.log("⚠️ Modal Rp", capital, "terlalu kecil (< 11rb)");
            return;
        }

        console.log(`🟡 EXECUTE BUY ${pair.toUpperCase()} | Score ${score.toFixed(1)}`);

        const res = await privateReq("trade", {
            pair,
            type: "buy",
            price: price, // Harga beli (last price)
            idr: capital
        });

        if (res.success) {
            // Indodax Market IDR biasanya tidak menerima desimal (harus Integer)
            const tpPrice = Math.round(price * (1 + BASE_TP / 100));
            const slPrice = Math.round(price * (1 - BASE_SL / 100));
            const coin = pair.split("_")[0];

            state.positions[pair] = {
                buyPrice: price,
                capital: capital,
                tp: tpPrice,
                sl: slPrice,
                coin,
                isTrailing: false,
                isSelling: false, // Tambahkan flag proteksi jual di sini
                entryTime: Date.now(),
                score
            };

            const msg = `📥 *BELI* #${coin.toUpperCase()}\n` +
                `📊 Score: ${score.toFixed(1)}\n` +
                `📥 Entry: ${price.toLocaleString()}\n` +
                `🎯 Target: ${tpPrice.toLocaleString()} (TP)\n` +
                `🛡️ Guard: ${slPrice.toLocaleString()} (SL)\n` +
                `💰 Modal: Rp ${capital.toLocaleString()}`;

            tg(msg); // Hapus 'await' agar bot tidak hang jika Telegram lemot
            console.log(`\x1b[42m SUCCESS \x1b[0m ${pair.toUpperCase()} BUY OK`);
        } else {
            console.log(`❌ BUY FAIL: ${res.error}`);
        }
    } catch (err) {
        console.log(`❌ EXECUTE ERROR: ${err.message}`);
    } finally {
        state.positionLock = false;
    }
}

async function sendDailyReport() {
    // Kunci tanggal SEGERA agar tidak terjadi pengiriman ganda saat async await berjalan
    const currentResetDate = state.dailyReport.lastReset;
    state.dailyReport.lastReset = new Date().getDate();

    const report = state.dailyReport;
    const winRate = report.totalTrades > 0 ? (report.win / report.totalTrades * 100).toFixed(1) : 0;

    const msg = `📊 *LAPORAN PERFORMA HARIAN*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📅 Tanggal : ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n` +
        `✅ Total Trade : ${report.totalTrades}\n` +
        `💰 Net Profit  : *Rp ${Math.round(report.netProfitIDR).toLocaleString('id-ID')}*\n\n` +
        `📈 Win Rate    : ${winRate}%\n` +
        `🟢 Win         : ${report.win}\n` +
        `🔴 Loss        : ${report.loss}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `_Bot telah mereset data untuk hari baru._`;

    await tg(msg);

    // Reset angka tapi tetap pertahankan lastReset yang baru
    state.dailyReport = {
        totalTrades: 0,
        win: 0,
        loss: 0,
        netProfitIDR: 0,
        lastReset: new Date().getDate()
    };
}

// 2. Perbaikan pada managePositions (Mencegah Error desimal amt)
async function managePositions(pair, currentPrice) {
    const pos = state.positions[pair];
    if (!pos || pos.isSelling) return;

    const gainPercent = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

    if (gainPercent > 0.8) {
        // Set SL baru 0.5% di bawah harga saat ini
        const newSL = Math.round(currentPrice * 0.995);

        // Pastikan SL baru lebih tinggi dari SL yang sedang berjalan
        if (newSL > pos.sl) {
            pos.sl = newSL;
            pos.isTrailing = true; // Tandai bahwa trailing sedang bekerja
            console.log(`🚀 Trailing Aktif! SL naik ke: ${pos.sl.toLocaleString()}`);
            tg(`🔄 *TRAILING AKTIF* #${pos.coin.toUpperCase()}\n🛡️ SL Baru: ${pos.sl.toLocaleString()}`);

            // Opsional: Kirim notifikasi ke Telegram (jangan terlalu sering agar tidak spam)
            // tg(`📈 SL Naik: ${pos.sl.toLocaleString()}`); 
        }
    }

    // Exit Condition
    if (currentPrice <= pos.sl || currentPrice >= pos.tp) {
        pos.isSelling = true; // Kunci agar tidak spam request jual

        try {
            const info = await privateReq("getInfo");
            if (!info.success) { pos.isSelling = false; return; }

            const rawAmt = info.data.balance[pos.coin] || 0;
            // Gunakan truncate untuk memastikan tidak ada pembulatan ke atas pada jumlah koin
            const amt = truncate(Number(rawAmt), 8);

            if (amt <= 0) {
                delete state.positions[pair];
                return;
            }

            // Jual 0.2% di bawah harga pasar agar instan (Taker)
            const executionPrice = Math.round(currentPrice * 0.998);

            const res = await privateReq("trade", {
                pair,
                type: "sell",
                price: executionPrice,
                [pos.coin]: amt
            });

            if (res.success) {
                // Kalkulasi Real Profit (Sesuaikan fee dengan gambar PRO Mode: 0.4211% Taker Sell)
                const grossSales = amt * executionPrice;
                const netSales = grossSales * 0.995789;
                const profitIDR = netSales - pos.capital;

                state.dailyReport.totalTrades++;
                state.dailyReport.netProfitIDR += profitIDR;
                if (profitIDR >= 0) {
                    state.dailyReport.win++;
                } else {
                    state.dailyReport.loss++;
                }

                const msg = `📤 *JUAL* #${pos.coin.toUpperCase()}\n` +
                    `---------------------------\n` +
                    `ℹ️ Status: ${profitIDR >= 0 ? "✅ UNTUNG" : "❌ RUGI"}\n` +
                    `💰 P/L Rp: Rp ${Math.round(profitIDR).toLocaleString('id-ID')}\n` +
                    `📈 P/L % : ${gainPercent.toFixed(2)}%\n` +
                    `💵 Exit  : ${executionPrice.toLocaleString()}`;

                tg(msg);
                delete state.positions[pair];
                state.cachedBalance = 0;
            } else {
                pos.isSelling = false; // Buka kunci jika gagal agar bisa dicoba lagi
                console.log(`❌ SELL FAIL: ${res.error}`);
            }
        } catch (e) {
            pos.isSelling = false;
            console.error("Sell Error:", e.message);
        }
    }
}


/* =========================
    SCANNER
========================= */
async function scan() {

    const now = new Date();
    // Gunakan pengecekan tanggal saja, lastReset akan diperbarui di dalam sendDailyReport
    if (now.getDate() !== state.dailyReport.lastReset) {
        await sendDailyReport();
    }

    /* ===============================
       UPDATE BALANCE
    =============================== */
    const info = await privateReq("getInfo");
    if (info.success) {
        state.cachedBalance = Number(info.data.balance.idr);
    }

    /* ===============================
       COOLDOWN MODE
    =============================== */
    if (state.cooling) {
        console.log("🛑 Cooldown Cloudflare aktif...");
        setTimeout(scan, 30000);
        return;
    }

    try {
        const { data } = await axiosInstance.get(PUBLIC_URL);
        const tickers = data.tickers;
        const ranked = [];
        const activePairs = Object.keys(state.positions);

        console.clear();

        /* ===============================
           HEADER
        =============================== */
        console.log("\x1b[1m\x1b[36m==================================================================\x1b[0m");
        console.log(`\x1b[1m\x1b[32m 🤖 SEROK BOT PRO \x1b[0m | 🕒 ${new Date().toLocaleTimeString()}`);
        console.log("\x1b[1m\x1b[36m==================================================================\x1b[0m");

        /* ===============================
           ACTIVE POSITIONS (PINNED)
        =============================== */
        if (activePairs.length > 0) {
            console.log("\x1b[33m📍 POSISI AKTIF:\x1b[0m");
            console.log("------------------------------------------------------------------");

            for (const pair of activePairs) {
                const price = Number(tickers[pair]?.last || 0);
                const pos = state.positions[pair];

                if (!price) continue;

                const pnl = ((price - pos.buyPrice) / pos.buyPrice * 100).toFixed(2);
                const color = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";

                console.log(`🪙  \x1b[1m${pair.toUpperCase().padEnd(10)}\x1b[0m | P/L: ${color}${pnl}%\x1b[0m`);
                console.log(`   📥 Entry : ${pos.buyPrice.toLocaleString()}`);
                console.log(`   🎯 Target: \x1b[32m${Math.floor(pos.tp).toLocaleString()}\x1b[0m`);
                console.log(`   🛡️ Guard : \x1b[31m${Math.floor(pos.sl).toLocaleString()}\x1b[0m`);
                console.log("------------------------------------------------------------------");

                await managePositions(pair, price);
            }
        }

        /* ===============================
           FORMATTER
        =============================== */
        const fmtVol = (val) => {
            if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "Bn";
            if (val >= 1_000_000) return (val / 1_000_000).toFixed(0) + "Mn";
            return val.toLocaleString();
        };

        /* ===============================
           BUILD WATCHLIST DATA
        =============================== */
        for (const pair in tickers) {

            if (!pair.endsWith("_idr")) continue;
            if (BLACKLIST.has(pair.split("_")[0])) continue;

            const t = tickers[pair];
            const price = Number(t.last);
            const vol = Number(t.vol_idr);

            if (!price || !vol) continue;

            if (!state.price[pair]) state.price[pair] = [];
            state.price[pair].push(price);
            if (state.price[pair].length > 20) state.price[pair].shift();

            const score = getEntryScore(pair, t);

            if (vol > MIN_VOL_24H) {
                ranked.push({
                    pair,
                    score,
                    price,
                    vol,
                    displayVol: fmtVol(vol)
                });
            }
        }

        /* ===============================
           WATCHLIST TABLE
        =============================== */
        console.log("\x1b[34m🔍 WATCHLIST:\x1b[0m");

        ranked.sort((a, b) => {
            if (b.vol >= 1e9 && a.vol < 1e9) return 1;
            if (a.vol >= 1e9 && b.vol < 1e9) return -1;
            return b.score - a.score;
        });

        const top = ranked.slice(0, 15);

        if (!top.length) {
            console.log("   😴 Tidak ada koin aktif");
        } else {
            console.log(`${"PAIR".padEnd(12)} | ${"VOL".padStart(7)} | ${"SCORE".padStart(7)} | STATUS`);

            for (const r of top) {

                let status = "\x1b[90mMonitoring\x1b[0m";
                if (r.score >= 3) status = "\x1b[33m🔥 Panas\x1b[0m";
                if (r.score >= BUY_ZONE_SCORE) status = "\x1b[31m🚀 BUY ZONE\x1b[0m";

                console.log(
                    `${r.pair.toUpperCase().padEnd(12)} | ${r.displayVol.padStart(7)} | ${r.score.toFixed(1).padStart(6)} | ${status}`
                );
            }
        }

        /* ===============================
           AUTO BUY EXECUTION
        =============================== */
        const candidates = ranked.filter(r => r.score >= BUY_ZONE_SCORE);

        for (const c of candidates.slice(0, 1)) {
            await executeBuy(c.pair, c.price, c.score);
            await sleep(jitter(2000, 5000));
        }

        /* ===============================
           FOOTER
        =============================== */
        console.log("\x1b[36m==================================================================\x1b[0m");
        console.log(`💰 Saldo IDR: Rp ${Math.floor(state.cachedBalance).toLocaleString()}`);
        console.log(`📡 Next scan: ~${Math.floor(FETCH_MIN / 1000)} detik`);

    } catch (e) {
        console.error("Scan Error:", e.message);
        if (e.response?.status === 403 || e.response?.status === 429) {
            state.cooling = true;
            console.log("🛑 Public API cooldown");
            setTimeout(() => state.cooling = false, 60000);
        }
    }

    setTimeout(scan, jitter(FETCH_MIN, FETCH_MAX));
}

function truncate(num, decimals = 8) {
    const factor = Math.pow(10, decimals);
    return Math.floor(num * factor) / factor;
}

function getIndoDate() {
    const d = new Date();
    return `📅 ${d.toLocaleDateString('id-ID')} ${d.toLocaleTimeString('id-ID')}`;
}

/* =========================
    INIT
========================= */
(async () => {
    console.log("Login...");
    const auth = await privateReq("getInfo");
    if (auth.success) {
        state.cachedBalance = Number(auth.data.balance.idr);
        tg("BOT ONLINE");
        scan();
    } else console.log("Login gagal");
})();