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

const FETCH_MIN = 4000; 
const FETCH_MAX = 6000;
const MAX_POSITIONS = 1;

const BASE_TP = 2.8; 
const BASE_SL = 1.8; 
const MIN_VOL_24H = 3_000_000_000; 
const BUY_ZONE_SCORE = 8;

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
    marketStats: {
        upCount: 0,
        avgVol: 0,
        sentiment: "NEUTRAL"
    },
    cachedBalance: 0,
    positionLock: false,
    dailyReport: { totalTrades: 0, win: 0, loss: 0, netProfitIDR: 0, lastReset: new Date().getDate() }
};

const truncate = (n, d) => Math.floor(n * Math.pow(10, d)) / Math.pow(10, d);

/* =========================
    API & TELEGRAM
========================= */
async function tg(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: msg,
            parse_mode: "Markdown"
        });
    } catch { }
}

async function privateReq(method, params = {}) {
    try {
        const payload = { method, timestamp: Date.now(), recvWindow: 15000, ...params };
        const postData = querystring.stringify(payload);
        const sign = crypto.createHmac("sha512", INDODAX_SECRET_KEY).update(postData).digest("hex");
        const { data } = await axiosInstance.post(TAPI_URL, postData, { headers: { Key: INDODAX_API_KEY, Sign: sign } });
        return data.success === 1 ? { success: true, data: data.return } : { success: false, error: data.error };
    } catch (e) { return { success: false, error: e.message }; }
}

/* =========================
    ADAPTIVE LOGIC
========================= */
function analyzeMarket(tickers) {
    let totalVol = 0;
    let up = 0;
    let count = 0;

    for (const p in tickers) {
        if (!p.endsWith("_idr")) continue;
        const t = tickers[p];
        const change = ((Number(t.last) - Number(t.low)) / Number(t.low)) * 100;
        if (change > 2) up++;
        totalVol += Number(t.vol_idr);
        count++;
    }

    state.marketStats.avgVol = totalVol / count;
    state.marketStats.upCount = up;
    
    const ratio = up / count;
    if (ratio > 0.6) state.marketStats.sentiment = "BULLISH 🟢";
    else if (ratio < 0.3) state.marketStats.sentiment = "BEARISH 🔴";
    else state.marketStats.sentiment = "SIDEWAYS 🟡";
}

function getEntryScore(pair, t, btcTicker) {
    const current = Number(t.last);
    const high = Number(t.high);
    const vol = Number(t.vol_idr);
    const btcVol = Number(btcTicker?.vol_idr || 1e12);
    
    let score = 0;

    if (current >= high) score += 6;
    else if ((high - current) / high < 0.007) score += 4;

    if (vol > btcVol) score += 5; 
    if (vol > state.marketStats.avgVol * 3) score += 3; 

    if (state.marketStats.sentiment.includes("🔴")) {
        if (current < high) score -= 5; 
    }

    return score;
}

/* =========================
    MONITOR UI
========================= */
function printMonitor(ranked, activePairs) {
    console.clear();
    const c = { cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m", bold: "\x1b[1m" };

    console.log(`${c.cyan}${c.bold}====================================================================${c.reset}`);
    console.log(`${c.bold}🤖 ADAPTIVE BOT PRO${c.reset} | Sentimen: ${c.bold}${state.marketStats.sentiment}${c.reset} | Bal: ${c.green}Rp ${state.cachedBalance.toLocaleString()}${c.reset}`);
    console.log(`${c.cyan}====================================================================${c.reset}\n`);

    if (activePairs.length > 0) {
        console.log(`${c.yellow}${c.bold}📍 POSISI AKTIF${c.reset}`);
        activePairs.forEach(p => {
            const pos = state.positions[p.pair];
            const color = p.pnl >= 0 ? c.green : c.red;
            console.log(`| ${p.pair.toUpperCase().padEnd(10)} | PNL: ${color}${p.pnl}%${c.reset} | Entry: ${pos.buyPrice} | SL: ${pos.sl} |`);
        });
        console.log("");
    }

    console.log(`${c.cyan}${c.bold}🔍 WATCHLIST (Berbasis Volume & Breakout)${c.reset}`);
    console.log(`| PAIR       | SCORE | VOL (Bn) | STATUS          |`);
    ranked.slice(0, 7).forEach(r => {
        let status = "Monitoring";
        let sColor = c.reset;
        if (r.score >= BUY_ZONE_SCORE) { status = "🚀 BUY ZONE"; sColor = c.red; }
        else if (r.score >= 5) { status = "🔥 HOT"; sColor = c.yellow; }
        console.log(`| ${r.pair.toUpperCase().padEnd(10)} | ${r.score.toString().padEnd(5)} | ${(r.vol/1e9).toFixed(1).padEnd(8)} | ${sColor}${status.padEnd(15)}${c.reset} |`);
    });
}

/* =========================
    CORE ENGINE
======================== */
async function scan() {
    try {
        const { data } = await axiosInstance.get(PUBLIC_URL);
        const tickers = data.tickers;
        analyzeMarket(tickers);

        const ranked = [];
        const activePairsData = [];

        for (const pair in state.positions) {
            const price = Number(tickers[pair]?.last || 0);
            const pnl = Number(((price - state.positions[pair].buyPrice) / state.positions[pair].buyPrice * 100).toFixed(2));
            activePairsData.push({ pair, pnl });
            await managePositions(pair, price);
        }

        for (const pair in tickers) {
            if (!pair.endsWith("_idr") || BLACKLIST.has(pair.split("_")[0])) continue;
            const t = tickers[pair];
            if (Number(t.vol_idr) < MIN_VOL_24H) continue;

            const score = getEntryScore(pair, t, tickers['btc_idr']);
            ranked.push({ pair, score, vol: Number(t.vol_idr), price: Number(t.last) });
        }

        ranked.sort((a, b) => b.score - a.score);
        printMonitor(ranked, activePairsData);

        if (Object.keys(state.positions).length < MAX_POSITIONS) {
            const best = ranked.find(r => r.score >= BUY_ZONE_SCORE);
            if (best) await executeBuy(best.pair, best.price, best.score);
        }

    } catch (e) { console.log("Scan Error:", e.message); }
    setTimeout(scan, 4000 + Math.random() * 2000);
}

async function executeBuy(pair, price, score) {
    if (state.positionLock) return;
    state.positionLock = true;
    try {
        const info = await privateReq("getInfo");
        if (!info.success) return;
        state.cachedBalance = Number(info.data.balance.idr);
        const capital = Math.floor(state.cachedBalance * 0.9);

        if (capital < 11000) return;

        const res = await privateReq("trade", { pair, type: "buy", price, idr: capital });
        if (res.success) {
            const coinName = pair.split("_")[0].toUpperCase();
            state.positions[pair] = {
                buyPrice: price, 
                coin: coinName.toLowerCase(), 
                capital: capital,
                tp: Math.round(price * (1 + BASE_TP/100)),
                sl: Math.round(price * (1 - BASE_SL/100)),
                isSelling: false,
                entryTime: new Date().toLocaleTimeString()
            };
            
            tg(`📥 *NOTIFIKASI BELI*\n\n` +
               `*Asset:* #${coinName}\n` +
               `*Harga:* Rp ${price.toLocaleString()}\n` +
               `*Modal:* Rp ${capital.toLocaleString()}\n` +
               `*Score:* ${score}\n` +
               `*Waktu:* ${state.positions[pair].entryTime}`);
        }
    } finally { state.positionLock = false; }
}

async function managePositions(pair, currentPrice) {
    const pos = state.positions[pair];
    if (!pos || pos.isSelling) return;

    const gainPercent = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
    
    // Trailing SL
    if (gainPercent > 0.7) {
        const newSL = Math.round(currentPrice * 0.994);
        if (newSL > pos.sl) pos.sl = newSL;
    }

    if (currentPrice <= pos.sl || currentPrice >= pos.tp) {
        pos.isSelling = true;
        try {
            const info = await privateReq("getInfo");
            if (!info.success) { pos.isSelling = false; return; }
            
            const amt = truncate(Number(info.data.balance[pos.coin] || 0), 8);
            if (amt <= 0) { delete state.positions[pair]; return; }

            const res = await privateReq("trade", { pair, type: "sell", price: Math.round(currentPrice * 0.998), [pos.coin]: amt });
            
            if (res.success) {
                // Perhitungan Untung Rugi
                const grossSales = amt * currentPrice;
                const netSales = grossSales * 0.995; // Estimasi potong fee jual 0.5%
                const profitIDR = netSales - pos.capital;
                const finalGain = (profitIDR / pos.capital) * 100;
                
                const statusEmoji = profitIDR >= 0 ? "✅ UNTUNG" : "❌ RUGI";
                const coinName = pos.coin.toUpperCase();

                tg(`📤 *NOTIFIKASI JUAL*\n\n` +
                   `*Asset:* #${coinName}\n` +
                   `*Status:* ${statusEmoji}\n` +
                   `*P/L (%):* ${finalGain.toFixed(2)}%\n` +
                   `*P/L (IDR):* Rp ${Math.round(profitIDR).toLocaleString()}\n\n` +
                   `*Harga Beli:* Rp ${pos.buyPrice.toLocaleString()}\n` +
                   `*Harga Jual:* Rp ${currentPrice.toLocaleString()}\n` +
                   `*Waktu Jual:* ${new Date().toLocaleTimeString()}`);
                
                delete state.positions[pair];
            } else {
                pos.isSelling = false;
            }
        } catch (e) {
            pos.isSelling = false;
        }
    }
}

(async () => {
    const auth = await privateReq("getInfo");
    if (auth.success) {
        state.cachedBalance = Number(auth.data.balance.idr);
        tg("🤖 *BOT ADAPTIVE ONLINE*\nMonitoring pasar telah dimulai...");
        scan();
    } else {
        console.log("Gagal Login! Periksa API Key / Secret Anda.");
    }
})();