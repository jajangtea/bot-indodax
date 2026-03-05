import dotenv from "dotenv";
import crypto from "crypto";
import querystring from "querystring";  // ← TAMBAHKAN INI!
import https from "https";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    INDODAX_API_KEY,
    INDODAX_SECRET_KEY
} = process.env;

// ======================================================
// API ENDPOINTS - BERDASARKAN DOKUMENTASI
// ======================================================
const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";  // ✅ Endpoint utama untuk semua private API
const STATE_FILE = path.join(__dirname, "bot_state.json");
const LOG_FILE = path.join(__dirname, "trading_journal.csv");

// Cache untuk menyimpan history transaksi
let tradeHistoryCache = {
    lastSync: 0,
    trades: [],
    dailyPL: 0
};

/* ======================================================
   PROFESSIONAL TRADING CONFIGURATION
====================================================== */

const CONFIG = {
    // === RISK MANAGEMENT ===
    RISK_PER_TRADE: 1.2,
    MAX_POSITIONS: 2,
    MAX_DAILY_LOSS: 5,
    MAX_DRAWDOWN: 50,
    MIN_EQUITY: 10000,

    // === MARKET FILTERS ===
    MIN_VOL_24H: 500_000_000,
    MAX_SPREAD: 0.25,
    MAX_PUMP_PERCENT: 12,
    MIN_PAIR_AGE: 7,

    // === TECHNICAL INDICATORS ===
    RSI_MIN: 55,
    RSI_MAX: 95,
    RSI_PERIOD: 14,
    EMA_SHORT: 9,
    EMA_LONG: 21,
    BB_PERIOD: 20,
    BB_STD: 2,

    // === TRADE EXECUTION ===
    BUY_PERCENT: 0.90,
    TP_PERCENT: 2.8,
    SL_PERCENT: 4,
    TRAILING_GAP: 0.6,
    TRAILING_ACTIVATION: 1.0,

    // === SYSTEM PARAMETERS ===
    MEM_LIMIT: 30,
    COOLDOWN_MIN: 25,
    SCAN_INTERVAL: 8000,

    // === MARKET REGIME DETECTION ===
    TREND_STRENGTH_THRESHOLD: 0.55,
    VOLATILITY_THRESHOLD: 0.15,

    // === PSYCHOLOGICAL SAFEGUARDS ===
    MAX_TRADES_PER_DAY: 10,
    MIN_TIME_BETWEEN_TRADES: 120000,

    // === API PARAMETERS ===
    TRADE_HISTORY_SYNC_INTERVAL: 60000,
    RECV_WINDOW: 5000,
};

/* ======================================================
   BLACKLIST & WHITELIST MANAGEMENT
====================================================== */

const BLACKLIST = new Set([
    "btc", "eth", "bnb", "usdt", "usdc", "busd", "dai",
    "wbtc", "weth", "xaut", "tusd", "usdp", "usdd", "ust",
    "eurs", "ceur", "idk", "bsc", "matic", "ada", "sol", "xrp"
]);

const WHITELIST = new Set([
    "trx", "xlm", "xem", "vet", "theta", "ftm", "avax",
    "link", "uni", "aave", "snx", "crv", "comp", "yfi",
    "sand", "mana", "axs", "enj", "gala", "flow", "neo"
]);

const USE_WHITELIST = false;

/* ======================================================
   STATE MANAGEMENT
====================================================== */

let state = {
    positions: {},
    cooldown: {},
    priceMemory: {},
    volMemory: {},
    tradeHistory: [],

    equityNow: 0,
    dailyLoss: 0,
    dailyTrades: 0,
    lastTradeTime: 0,
    peakEquity: 0,
    currentDrawdown: 0,

    sentiment: "NEUTRAL",
    marketRegime: "SIDEWAYS",
    volatilityLevel: "NORMAL",

    consecutiveWins: 0,
    consecutiveLosses: 0,
    lastWinLoss: null,
    lastDate: new Date().toDateString()
};

let isBuying = false;
let isTradingEnabled = true;

// Load state dari file
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE));
    } catch (e) {
        console.log("⚠️ State file corrupt, using fresh state");
    }
}

// Save state
const saveState = () => {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), {
            mode: 0o644,
            flag: 'w'
        });
        console.log("✅ State saved directly");
    } catch (e) {
        console.log("❌ Error saving state:", e.message);
    }
};

// Trading Journal
const logTrade = (tradeData) => {
    try {
        const logEntry = `${new Date().toISOString()},${tradeData.pair},${tradeData.type},${tradeData.price},${tradeData.amount},${tradeData.pnl},${tradeData.reason}\n`;

        if (!fs.existsSync(LOG_FILE)) {
            fs.writeFileSync(LOG_FILE, "timestamp,pair,type,price,amount,pnl,reason\n");
        }

        fs.appendFileSync(LOG_FILE, logEntry);
        state.tradeHistory.push({ timestamp: Date.now(), ...tradeData });
    } catch (e) {
        console.log("⚠️ Error logging trade:", e.message);
    }
};

/* ======================================================
   UTILITY FUNCTIONS
====================================================== */

const formatIDR = (n) => new Intl.NumberFormat("id-ID").format(Math.floor(n || 0));
const formatPercent = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* ======================================================
   API REQUEST HANDLER
====================================================== */

async function makeRequest(url, options, postData = null, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            options.rejectUnauthorized = false;

            return await new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = "";
                    res.on("data", (chunk) => body += chunk);
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            resolve({ success: 0, error: "JSON Parse Error" });
                        }
                    });
                });

                req.on("error", (e) => reject(e));
                req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error("Request timeout"));
                });

                if (postData) req.write(postData);
                req.end();
            });
        } catch (e) {
            console.log(`⚠️ Request failed (attempt ${i + 1}/${retries}):`, e.message);
            if (i === retries - 1) throw e;
            await sleep(2000 * (i + 1));
        }
    }
}

/* ======================================================
   TELEGRAM NOTIFICATION
====================================================== */

async function tg(msg, level = "INFO") {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const emoji = {
        "INFO": "ℹ️",
        "SUCCESS": "✅",
        "WARNING": "⚠️",
        "ERROR": "❌",
        "TRADE": "💰",
        "RISK": "🛡️"
    }[level] || "📢";

    try {
        const data = querystring.stringify({
            chat_id: TELEGRAM_CHAT_ID.trim(),
            text: `${emoji} <b>${level}</b>\n${msg}`,
            parse_mode: "HTML"
        });

        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }, data);
    } catch (e) {
        console.log("📱 Telegram Error:", e.message);
    }
}

/* ======================================================
   INDOAX API V2 - PRIVATE REQUEST (POST /tapi)
====================================================== */

async function privateRequest(method, params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Siapkan parameter sesuai dokumentasi
            const timestamp = Date.now();
            const bodyParams = {
                method: method,
                timestamp: timestamp,
                recvWindow: CONFIG.RECV_WINDOW,
                ...params
            };

            // Buat query string untuk signature (sesuai contoh dokumentasi)
            const postBody = Object.keys(bodyParams)
                .map(key => `${key}=${encodeURIComponent(bodyParams[key])}`)
                .join('&');

            // Buat signature HMAC-SHA512
            const sign = crypto
                .createHmac("sha512", INDODAX_SECRET_KEY)
                .update(postBody)
                .digest("hex");

            // Siapkan headers (sesuai dokumentasi)
            const headers = {
                "Key": INDODAX_API_KEY,
                "Sign": sign,
                "Content-Type": "application/x-www-form-urlencoded"
            };

            const options = {
                method: "POST",
                headers: headers
            };

            // Kirim request
            const res = await makeRequest(TAPI_URL, options, postBody, retries);

            // Response sukses: { success: 1, return: {...} }
            if (res.success === 1) {
                return { success: true, data: res.return };
            } else {
                console.log(`⚠️ API Error [${method}]: ${res.error} (Code: ${res.error_code})`);
                return { success: false, error: res.error, code: res.error_code };
            }

        } catch (e) {
            console.log(`❌ Request Error (attempt ${i + 1}):`, e.message);
            if (i === retries - 1) return { success: false, error: e.message };
            await sleep(2000);
        }
    }

    return { success: false, error: "Max retries exceeded" };
}

/* ======================================================
   GET ACCOUNT INFO (getInfo)
====================================================== */

async function getAccountInfo() {
    try {
        const response = await privateRequest('getInfo');

        if (response.success) {
            const balance = response.data.balance || {};
            const idrBalance = Number(balance.idr || 0);

            // Update equity
            state.equityNow = idrBalance;

            // Update peak equity dan drawdown
            if (idrBalance > state.peakEquity) {
                state.peakEquity = idrBalance;
                state.currentDrawdown = 0;
            } else if (state.peakEquity > 0) {
                state.currentDrawdown = ((state.peakEquity - idrBalance) / state.peakEquity) * 100;
            }

            return { success: true, data: response.data };
        }

        return { success: false };

    } catch (e) {
        console.log("❌ Account info error:", e.message);
        return { success: false };
    }
}

/* ======================================================
   TRADE HISTORY (tradeHistory) - UNTUK DAILY LOSS
====================================================== */

async function syncTradeHistory() {
    try {
        // Ambil daftar pair yang aktif dari market
        const activePairs = ['btc_idr', 'eth_idr', 'usdt_idr']; // Bisa dinamis

        let allTrades = [];

        for (const pair of activePairs) {
            const response = await privateRequest('tradeHistory', {
                pair: pair,
                count: 100,
                order: 'desc'
            });

            if (response.success) {
                allTrades = allTrades.concat(response.data.trades || []);
            }

            // Jangan spam API, kasih delay
            await sleep(500);
        }

        // Hitung daily loss
        const today = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        let dailyPL = 0;

        allTrades.forEach(trade => {
            if (trade.trade_time >= today) {
                const tradeValue = Number(trade.price) * Number(trade[Object.keys(trade)[3]]); // Ambil qty
                const fee = Number(trade.fee || 0);
                dailyPL += (trade.type === 'sell' ? tradeValue - fee : -fee);
            }
        });

        state.dailyLoss = Math.abs(dailyPL);
        console.log(`📊 Daily P&L: Rp ${formatIDR(dailyPL)}`);

    } catch (e) {
        console.log("❌ Trade history sync error:", e.message);
    }
}


/* ======================================================
   PLACE ORDER (trade)
====================================================== */

async function placeOrder(pair, type, price, amount, useIdr = true) {
    try {
        const params = {
            pair: pair,
            type: type,
            price: Math.floor(price) // Harga harus integer
        };

        // Untuk buy: gunakan idr, untuk sell: gunakan coin
        if (type === 'buy') {
            params.idr = Math.floor(amount);
        } else {
            const coin = pair.split('_')[0];
            params[coin] = amount.toFixed(8);
        }

        // Tambahkan client_order_id untuk tracking (optional)
        params.client_order_id = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const response = await privateRequest('trade', params);

        if (response.success) {
            console.log(`✅ Order ${type} ${pair} successful:`, response.data);
            return { success: true, data: response.data };
        } else {
            console.log(`❌ Order ${type} ${pair} failed:`, response.error);
            return { success: false, error: response.error };
        }

    } catch (e) {
        console.log("❌ Place order error:", e.message);
        return { success: false, error: e.message };
    }
}

/* ======================================================
   CANCEL ORDER (jika diperlukan)
====================================================== */

async function cancelOrder(pair, orderId, type) {
    try {
        const response = await privateRequest('cancelOrder', {
            pair: pair,
            order_id: orderId,
            type: type
        });

        return response;

    } catch (e) {
        console.log("❌ Cancel order error:", e.message);
        return { success: false, error: e.message };
    }
}

/* ======================================================
   GET OPEN ORDERS
====================================================== */

async function getOpenOrders(pair = null) {
    try {
        const params = {};
        if (pair) params.pair = pair;

        const response = await privateRequest('openOrders', params);
        return response;

    } catch (e) {
        console.log("❌ Get open orders error:", e.message);
        return { success: false, error: e.message };
    }
}

/* ======================================================
   RISK MANAGER
====================================================== */

class RiskManager {
    constructor(state, config) {
        this.state = state;
        this.config = config;
    }

    calculatePositionSize(equity, volatility, confidence) {
        let riskPercent = this.config.RISK_PER_TRADE;

        if (volatility > this.config.VOLATILITY_THRESHOLD) {
            riskPercent *= 0.7;
        }

        if (this.state.marketRegime === "BEARISH") {
            riskPercent *= 0.5;
        }

        if (this.state.consecutiveLosses >= 3) {
            riskPercent *= 0.5;
        } else if (this.state.consecutiveWins >= 3) {
            riskPercent *= 1.2;
        }

        riskPercent *= (confidence / 10);

        const riskAmount = equity * (riskPercent / 100);
        return riskAmount;
    }

    canTrade() {
        // Daily loss limit dari trade history
        const dailyLossPercent = (this.state.dailyLoss / this.state.equityNow) * 100;

        if (dailyLossPercent >= this.config.MAX_DAILY_LOSS) {
            console.log(`⛔ Daily loss limit reached: ${dailyLossPercent.toFixed(2)}%`);
            return false;
        }

        if (this.state.dailyTrades >= this.config.MAX_TRADES_PER_DAY) {
            console.log("⛔ Daily trade limit reached");
            return false;
        }

        if (this.state.equityNow < this.config.MIN_EQUITY) {
            console.log("⛔ Minimum equity not met");
            return false;
        }

        if (this.state.currentDrawdown > this.config.MAX_DRAWDOWN) {
            console.log("⛔ Maximum drawdown exceeded");
            return false;
        }

        if (Date.now() - this.state.lastTradeTime < this.config.MIN_TIME_BETWEEN_TRADES) {
            return false;
        }

        return isTradingEnabled;
    }
}

const riskManager = new RiskManager(state, CONFIG);

/* ======================================================
   TECHNICAL INDICATORS (Sama seperti sebelumnya)
====================================================== */

class TechnicalIndicators {
    static rsi(prices, period = 14) {
        if (!prices || prices.length < period + 1) return 50;

        let gains = 0, losses = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }

        if (losses === 0) return 100;

        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgGain / avgLoss;

        return 100 - (100 / (1 + rs));
    }

    static ema(prices, period) {
        if (!prices || prices.length < period) return prices[prices.length - 1];

        const k = 2 / (period + 1);
        let ema = prices[0];

        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }

        return ema;
    }

    static bb(prices, period = 20, std = 2) {
        if (!prices || prices.length < period) {
            return { upper: null, middle: null, lower: null };
        }

        const recentPrices = prices.slice(-period);
        const sum = recentPrices.reduce((a, b) => a + b, 0);
        const middle = sum / period;

        const squaredDiffs = recentPrices.map(p => Math.pow(p - middle, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const standardDeviation = Math.sqrt(variance);

        return {
            upper: middle + (standardDeviation * std),
            middle: middle,
            lower: middle - (standardDeviation * std)
        };
    }

    static detectMarketStructure(prices) {
        if (!prices || prices.length < 50) return "UNDEFINED";

        const recentPrices = prices.slice(-50);
        const firstHalf = recentPrices.slice(0, 25);
        const secondHalf = recentPrices.slice(25);

        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

        if (secondAvg > firstAvg * 1.05) return "UPTREND";
        if (secondAvg < firstAvg * 0.95) return "DOWNTREND";

        const volatility = Math.sqrt(recentPrices.map(p => Math.pow(p - secondAvg, 2)).reduce((a, b) => a + b, 0) / recentPrices.length);
        if (volatility / secondAvg < 0.03) return "SIDEWAYS";

        return "CHOPPY";
    }
}

/* ======================================================
   MARKET ANALYZER
====================================================== */

class MarketAnalyzer {
    constructor(state, config) {
        this.state = state;
        this.config = config;
    }

    evaluatePair(pair, ticker) {
        const price = Number(ticker.last || 0);
        const vol = Number(ticker.vol_idr || 0);
        const buyPrice = Number(ticker.buy || 0);
        const sellPrice = Number(ticker.sell || 0);
        const low24h = Number(ticker.low || price);

        // Filter likuiditas
        if (vol < this.config.MIN_VOL_24H) {
            return { score: 0, reason: "INSUFFICIENT_VOLUME", rsi: 50 };
        }

        // Filter spread
        const spread = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
        if (spread > this.config.MAX_SPREAD) {
            return { score: 0, reason: "SPREAD_TOO_WIDE", rsi: 50 };
        }

        // Filter pump
        const pumpFromLow = ((price - low24h) / low24h) * 100;
        if (pumpFromLow > this.config.MAX_PUMP_PERCENT) {
            return { score: 0, reason: "PUMPED", rsi: 50 };
        }

        // Price history
        const priceHistory = this.state.priceMemory[pair] || [];
        if (priceHistory.length < this.config.MEM_LIMIT) {
            return { score: 0, reason: `BUILDING_DATA(${priceHistory.length})`, rsi: 50 };
        }

        // Technical analysis
        const rsi = TechnicalIndicators.rsi(priceHistory, this.config.RSI_PERIOD);
        const ema9 = TechnicalIndicators.ema(priceHistory.slice(-20), 9);
        const ema21 = TechnicalIndicators.ema(priceHistory, 21);
        const bb = TechnicalIndicators.bb(priceHistory, this.config.BB_PERIOD, this.config.BB_STD);
        const marketStructure = TechnicalIndicators.detectMarketStructure(priceHistory);

        // RSI filter
        if (rsi < this.config.RSI_MIN || rsi > this.config.RSI_MAX) {
            return { score: 0, reason: "RSI_OUT_OF_RANGE", rsi };
        }

        // Scoring
        let score = 0;
        let confidenceFactors = [];

        if (rsi >= 50 && rsi <= 65) {
            score += 3;
            confidenceFactors.push("RSI_OPTIMAL");
        }

        if (ema9 > ema21) {
            score += 2;
            confidenceFactors.push("EMA_BULLISH");
        }

        if (price <= bb.middle && price >= bb.lower) {
            score += 1.5;
            confidenceFactors.push("BB_SUPPORT");
        }

        const avgVol = this.state.volMemory[pair]
            ? this.state.volMemory[pair].reduce((a, b) => a + b, 0) / this.state.volMemory[pair].length
            : vol;

        if (vol > avgVol * 1.2) {
            score += 1.5;
            confidenceFactors.push("VOLUME_SPIKE");
        }

        if (marketStructure === "UPTREND") {
            score += 2;
            confidenceFactors.push("UPTREND");
        }

        if (this.state.sentiment === "BULLISH") {
            score += 1;
            confidenceFactors.push("BULLISH_SENTIMENT");
        }

        const finalScore = Math.min(10, Math.max(0, score));
        const confidence = finalScore / 10;

        return {
            score: finalScore,
            confidence,
            rsi,
            factors: confidenceFactors,
            reason: "QUALIFIED"
        };
    }

    detectMarketRegime(tickers) {
        let upCount = 0;
        let totalCount = 0;

        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;

            const price = Number(t.last || 0);
            const low = Number(t.low || price);

            if (price > low * 1.02) upCount++;
            totalCount++;
        }

        const ratio = upCount / totalCount;

        if (ratio > CONFIG.TREND_STRENGTH_THRESHOLD) {
            this.state.sentiment = "BULLISH";
            this.state.marketRegime = "HEALTHY_BULL";
        } else if (ratio < (1 - CONFIG.TREND_STRENGTH_THRESHOLD)) {
            this.state.sentiment = "BEARISH";
            this.state.marketRegime = "HEALTHY_BEAR";
        } else {
            this.state.sentiment = "SIDEWAYS";
            this.state.marketRegime = "SIDEWAYS";
        }

        return {
            sentiment: this.state.sentiment,
            regime: this.state.marketRegime
        };
    }
}

const analyzer = new MarketAnalyzer(state, CONFIG);

/* ======================================================
   EXECUTE BUY
====================================================== */

async function executeBuy(pair, price, analysis) {
    if (isBuying) return;
    isBuying = true;

    try {
        await getAccountInfo();

        // ======================================================
        // KONFIGURASI MINIMAL ORDER
        // ======================================================
        const MIN_ORDER_INDODAX = 50000;
        const SAFE_BUFFER = 1.05;

        // Estimasi minimal order berdasarkan pair (bisa diperluas)
        const MIN_ORDER_ESTIMATE = {
            'pepe_idr': 100000,
            'jellyjelly_idr': 75000,
            'fartcoin_idr': 50000,
            'pengu_idr': 50000,
            'pippin_idr': 75000,
            'default': 50000
        };

        // Cek apakah ada cache minimal order dari error sebelumnya
        const cachedMinOrder = state.minOrderCache?.[pair];
        const minOrderForPair = cachedMinOrder || MIN_ORDER_ESTIMATE[pair] || MIN_ORDER_ESTIMATE.default;

        if (cachedMinOrder) {
            console.log(`📦 Menggunakan cached minimal order: Rp ${formatIDR(cachedMinOrder)} untuk ${pair}`);
        }

        // ======================================================
        // HITUNG MODAL TERSEDIA
        // ======================================================
        const tradingBalance = Math.floor(state.equityNow * 0.95);
        const holdBalance = state.equityNow - tradingBalance;
        const openSlots = CONFIG.MAX_POSITIONS - Object.keys(state.positions).length;

        if (openSlots <= 0) {
            console.log(`[SKIP] Slot penuh, tidak bisa membeli ${pair}`);
            return;
        }

        // ======================================================
        // STRATEGI ALOKASI MODAL ADAPTIF
        // ======================================================
        console.log(`\n💰 ANALISIS MODAL:`);
        console.log(`   Total Balance  : Rp ${formatIDR(state.equityNow)}`);
        console.log(`   Trading Balance: Rp ${formatIDR(tradingBalance)}`);
        console.log(`   Slot tersisa   : ${openSlots}`);
        console.log(`   Minimal order  : Rp ${formatIDR(minOrderForPair)} untuk ${pair}`);

        let spend = 0;
        let strategy = "";

        // STRATEGI 1: Bagi rata per slot (jika cukup)
        const spendPerSlot = Math.floor(tradingBalance / CONFIG.MAX_POSITIONS);

        if (spendPerSlot >= minOrderForPair) {
            spend = spendPerSlot;
            strategy = `Bagi rata (${CONFIG.MAX_POSITIONS} slot)`;
        }
        // STRATEGI 2: Gunakan semua trading balance untuk 1 posisi
        else if (tradingBalance >= minOrderForPair * SAFE_BUFFER) {
            spend = Math.floor(tradingBalance);
            strategy = `Konsentrasi 1 posisi (sisa slot ${openSlots - 1} kosong)`;
        }
        // STRATEGI 3: Sesuaikan dengan minimal order
        else if (tradingBalance >= minOrderForPair) {
            spend = minOrderForPair;
            strategy = `Minimal order (sisa untuk fee)`;
        }
        // STRATEGI 4: Tidak cukup
        else {
            console.log(`❌ Saldo trading Rp ${formatIDR(tradingBalance)} tidak cukup untuk minimal order ${pair} (Rp ${formatIDR(minOrderForPair)})`);
            console.log(`💡 Saran: Tambah deposit minimal Rp ${formatIDR(minOrderForPair - tradingBalance)} atau tunggu koin dengan minimal order lebih rendah`);
            return;
        }

        if (spend < MIN_ORDER_INDODAX) {
            console.log(`❌ Modal Rp ${formatIDR(spend)} di bawah minimal order Indodax Rp ${formatIDR(MIN_ORDER_INDODAX)}`);
            return;
        }

        console.log(`\n🔵 STRATEGI: ${strategy}`);
        console.log(`🔵 Mencoba beli ${pair} dengan Rp ${formatIDR(spend)}`);
        console.log(`📊 Sisa saldo setelah beli: Rp ${formatIDR(state.equityNow - spend)}`);

        // ======================================================
        // EKSEKUSI ORDER
        // ======================================================
        const buyPrice = Math.ceil(price * 1.005);
        const res = await placeOrder(pair, 'buy', buyPrice, spend, true);

        if (res.success) {
            const targetPrice = price * (1 + CONFIG.TP_PERCENT / 100);
            const stopPrice = price * (1 - CONFIG.SL_PERCENT / 100);

            state.positions[pair] = {
                entry: price,
                high: price,
                target: targetPrice,
                stop: stopPrice,
                coin: pair.split("_")[0],
                time: new Date().toLocaleString("id-ID"),
                size: spend,
                confidence: analysis.confidence,
                orderId: res.data.order_id,
                strategy: strategy
            };

            saveState();
            await getAccountInfo();

            const msg = `🚀 <b>BUY EXECUTED</b>\n` +
                `Pair: ${pair.toUpperCase()}\n` +
                `Price: Rp ${formatIDR(price)}\n` +
                `Modal: Rp ${formatIDR(spend)}\n` +
                `Strategi: ${strategy}\n` +
                `Target: ${formatIDR(targetPrice)} (${CONFIG.TP_PERCENT}%)\n` +
                `Stop: ${formatIDR(stopPrice)} (${CONFIG.SL_PERCENT}%)\n` +
                `Sisa Saldo: Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, "TRADE");
            console.log(`✅ BERHASIL membeli ${pair} di harga ${price}`);

        } else {
            console.log(`❌ GAGAL membeli ${pair}: ${res.error}`);

            // ======================================================
            // 🔥 TEMPAT MENGGUNAKAN updateMinOrderFromError
            // ======================================================
            if (res.error && res.error.includes("minimum")) {
                await updateMinOrderFromError(pair, res.error);

                // Rekomendasi berdasarkan error
                console.log(`💡 Saran: Coba lagi nanti dengan modal lebih besar atau beli koin lain`);
            }
        }

    } catch (e) {
        console.log("❌ ERROR di executeBuy:", e.message);
    } finally {
        isBuying = false;
    }
}
// Fungsi untuk update minimal order berdasarkan error
async function updateMinOrderFromError(pair, errorMessage) {
    try {
        console.log(`\n🔍 Menganalisis error untuk ${pair}...`);

        // Pattern error dari Indodax
        const patterns = [
            /minimum.*?(\d+(?:\.\d+)?)/i,           // "minimum 100000"
            /under the minimum.*?(\d+(?:\.\d+)?)/i,  // "under the minimum 100000"
            /minimal.*?(\d+(?:\.\d+)?)/i,            // "minimal 100000"
            /total transaction.*?(\d+(?:\.\d+)?)/i,  // "total transaction 100000"
            /(\d+(?:\.\d+)?).*?minimum/i             // "100000 minimum"
        ];

        let suggestedMin = null;

        // Coba semua pattern
        for (const pattern of patterns) {
            const match = errorMessage.match(pattern);
            if (match && match[1]) {
                suggestedMin = parseInt(match[1]);
                break;
            }
        }

        // Jika tidak ketemu, coba extract angka dari seluruh pesan
        if (!suggestedMin) {
            const allNumbers = errorMessage.match(/\d+(?:\.\d+)?/g);
            if (allNumbers && allNumbers.length > 0) {
                // Ambil angka terbesar yang masuk akal (antara 10rb - 10jt)
                const validNumbers = allNumbers
                    .map(Number)
                    .filter(n => n >= 10000 && n <= 10000000);

                if (validNumbers.length > 0) {
                    suggestedMin = Math.max(...validNumbers);
                }
            }
        }

        // Jika berhasil dapat angka
        if (suggestedMin) {
            console.log(`📊 Mendeteksi minimal order ${pair}: Rp ${formatIDR(suggestedMin)}`);

            // Inisialisasi cache jika belum ada
            if (!state.minOrderCache) {
                state.minOrderCache = {};
            }

            // Update cache
            state.minOrderCache[pair] = suggestedMin;

            // Simpan ke state
            saveState();

            console.log(`✅ Minimal order ${pair} telah disimpan untuk penggunaan selanjutnya`);

            // Tampilkan semua cache saat ini
            console.log(`\n📦 Daftar minimal order tersimpan:`);
            for (const [p, min] of Object.entries(state.minOrderCache)) {
                console.log(`   - ${p}: Rp ${formatIDR(min)}`);
            }

        } else {
            console.log(`⚠️ Tidak bisa mendeteksi angka minimal order dari error: ${errorMessage}`);
            console.log(`💡 Saran: Update manual MIN_ORDER_ESTIMATE untuk ${pair}`);
        }

    } catch (e) {
        console.log("❌ Error di updateMinOrderFromError:", e.message);
    }
}
/* ======================================================
   EXECUTE SELL
====================================================== */

async function executeSell(pair, price, reason) {
    const pos = state.positions[pair];
    if (!pos) return;

    try {
        await getAccountInfo();

        const amount = pos.size / pos.entry; // Estimasi jumlah koin

        // Hitung harga jual (dengan buffer -0.2%)
        const sellPrice = Math.floor(price * 0.998);

        const res = await placeOrder(pair, 'sell', sellPrice, amount, false);

        if (res.success) {
            const grossPnlPercent = ((price - pos.entry) / pos.entry) * 100;

            // Update state
            delete state.positions[pair];
            state.cooldown[pair] = Date.now();
            state.lastTradeTime = Date.now();

            if (grossPnlPercent < 0) {
                state.consecutiveLosses++;
                state.consecutiveWins = 0;
            } else {
                state.consecutiveWins++;
                state.consecutiveLosses = 0;
            }

            saveState();
            await getAccountInfo();

            const emoji = grossPnlPercent >= 0 ? "💰" : "📉";
            const msg = `${emoji} <b>POSITION CLOSED</b>\n` +
                `Pair: ${pair.toUpperCase()}\n` +
                `Exit: Rp ${formatIDR(price)}\n` +
                `Result: ${formatPercent(grossPnlPercent)}\n` +
                `Reason: ${reason}\n` +
                `Balance: Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, grossPnlPercent >= 0 ? "SUCCESS" : "WARNING");
            console.log(`[SELL] ${pair} @ ${formatIDR(price)} | P&L: ${formatPercent(grossPnlPercent)}`);
        }

    } catch (e) {
        console.log("❌ ExecuteSell Error:", e.message);
    }
}

/* ======================================================
   MANAGE POSITIONS
====================================================== */

async function managePositions(tickers) {
    for (const [pair, pos] of Object.entries(state.positions)) {
        const ticker = tickers[pair];
        if (!ticker) continue;

        const currentPrice = Number(ticker.last || 0);
        if (!currentPrice) continue;

        // Update high price
        if (currentPrice > (pos.high || pos.entry)) {
            state.positions[pair].high = currentPrice;
            saveState();
        }

        const profitPercent = ((currentPrice - pos.entry) / pos.entry) * 100;
        const targetPrice = pos.entry * (1 + CONFIG.TP_PERCENT / 100);

        // Trailing stop
        let stopPrice = pos.entry * (1 - CONFIG.SL_PERCENT / 100);
        if (profitPercent >= CONFIG.TRAILING_ACTIVATION) {
            const trailingStop = (pos.high || currentPrice) * (1 - CONFIG.TRAILING_GAP / 100);
            stopPrice = Math.max(stopPrice, trailingStop);
        }

        // Execute exit
        if (currentPrice >= targetPrice) {
            await executeSell(pair, currentPrice, "TAKE_PROFIT");
        }
        else if (currentPrice <= stopPrice) {
            const exitReason = profitPercent > 0 ? "TRAILING_STOP" : "STOP_LOSS";
            await executeSell(pair, currentPrice, exitReason);
        }
    }
}

/* ======================================================
   TELEGRAM COMMAND HANDLER
   Menangani perintah dari pengguna via Telegram
====================================================== */

// Cache untuk menyimpan update_id terakhir
let lastUpdateId = 0;

async function handleTelegramCommands() {
    if (!TELEGRAM_BOT_TOKEN) return;

    try {
        // Ambil pesan terbaru (tanpa timeout agar tidak blocking)
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;

        const response = await axios.get(url);

        if (response.data.ok && response.data.result.length > 0) {
            for (const update of response.data.result) {
                lastUpdateId = update.update_id;

                const chatId = update.message?.chat?.id;
                const text = update.message?.text;
                const fromId = update.message?.from?.id;

                // Hanya proses dari chat ID yang terdaftar
                if (chatId != TELEGRAM_CHAT_ID) continue;

                // Proses perintah
                if (text && text.startsWith('/')) {
                    await processTelegramCommand(chatId, text);
                }
            }
        }
    } catch (e) {
        console.log("📱 Telegram command error:", e.message);
    }
}

async function processTelegramCommand(chatId, command) {
    let response = "";
    const cmd = command.toLowerCase().split(' ')[0]; // Ambil command utama, abaikan parameter

    switch (cmd) {
        case '/start':
            response = `🤖 <b>TRADING BOT v5.0</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Bot siap digunakan!\n\n` +
                `<b>Perintah tersedia:</b>\n` +
                `• /status - Tampilkan status terkini\n` +
                `• /positions - Detail posisi aktif\n` +
                `• /balance - Cek saldo IDR\n` +
                `• /help - Tampilkan menu ini\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        case '/help':
            response = `📋 <b>DAFTAR PERINTAH</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `/status - Tampilan dashboard lengkap\n` +
                `/balance - Ringkasan saldo dan drawdown\n` +
                `/positions - Detail posisi aktif\n` +
                `/daily - Info daily loss hari ini\n` +
                `/help - Tampilkan menu ini\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        case '/status':
        case '/dashboard':
            // Ambil data ticker terbaru untuk harga live
            try {
                const marketRes = await axios.get(PUBLIC_URL, { timeout: 5000 });
                const tickers = marketRes.data.tickers || {};

                let positionsText = "Tidak ada posisi aktif";
                if (Object.keys(state.positions).length > 0) {
                    positionsText = "";
                    for (const [pair, pos] of Object.entries(state.positions)) {
                        const currentPrice = Number(tickers[pair]?.last || 0);
                        const pnl = currentPrice ? ((currentPrice - pos.entry) / pos.entry * 100).toFixed(2) : "0.00";
                        const arrow = pnl >= 0 ? "📈" : "📉";
                        positionsText += `\n${arrow} ${pair.toUpperCase()}: ${pnl}% (Live: ${formatIDR(currentPrice)} / Target: ${formatIDR(pos.target)})`;
                    }
                }

                response = `📊 <b>LIVE DASHBOARD</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💰 Balance: Rp ${formatIDR(state.equityNow)}\n` +
                    `📉 Drawdown: ${state.currentDrawdown.toFixed(2)}%\n` +
                    `📊 Daily Loss: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n` +
                    `📈 Market: ${state.sentiment} | ${state.marketRegime}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `<b>POSISI (${Object.keys(state.positions).length}/${CONFIG.MAX_POSITIONS}):</b>${positionsText}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━`;
            } catch (e) {
                response = `❌ Gagal mengambil data market: ${e.message}`;
            }
            break;

        case '/balance':
            response = `💰 <b>INFORMASI SALDO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Balance IDR: Rp ${formatIDR(state.equityNow)}\n` +
                `Peak Equity: Rp ${formatIDR(state.peakEquity)}\n` +
                `Drawdown: ${state.currentDrawdown.toFixed(2)}%\n` +
                `Daily Loss: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        case '/positions':
            if (Object.keys(state.positions).length === 0) {
                response = `📭 <b>POSISI AKTIF</b>\n━━━━━━━━━━━━━━━━━━━━━━\nTidak ada posisi terbuka.`;
            } else {
                let posText = "";
                for (const [pair, pos] of Object.entries(state.positions)) {
                    posText += `\n🔹 <b>${pair.toUpperCase()}</b>\n` +
                        `   Entry: Rp ${formatIDR(pos.entry)}\n` +
                        `   Target: Rp ${formatIDR(pos.target)}\n` +
                        `   Stop: Rp ${formatIDR(pos.stop)}\n`;
                }
                response = `📌 <b>POSISI AKTIF (${Object.keys(state.positions).length})</b>\n━━━━━━━━━━━━━━━━━━━━━━${posText}\n━━━━━━━━━━━━━━━━━━━━━━`;
            }
            break;

        case '/daily':
            response = `📊 <b>DAILY LOSS</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Loss hari ini: Rp ${formatIDR(state.dailyLoss)}\n` +
                `Batas maksimal: ${CONFIG.MAX_DAILY_LOSS}%\n` +
                `Sisa aman: Rp ${formatIDR(CONFIG.MAX_DAILY_LOSS * state.equityNow / 100 - state.dailyLoss)}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        default:
            response = `Perintah tidak dikenal. Ketik /help untuk bantuan.`;
    }

    // Kirim response ke Telegram
    await tg(response, "INFO");
}

// Modifikasi fungsi tg yang sudah ada untuk mendukung command response
// (Fungsi tg Anda sudah ada, tidak perlu diubah)

/* ======================================================
   MAIN SCANNER LOOP
====================================================== */

async function scan() {
    try {
        await handleTelegramCommands();
        // Sync trade history
        const now = Date.now();
        if (now - tradeHistoryCache.lastSync > CONFIG.TRADE_HISTORY_SYNC_INTERVAL) {
            await syncTradeHistory();

            const today = new Date().toDateString();
            if (state.lastDate !== today) {
                console.log("📅 New day detected");
                state.lastDate = today;
            }
        }

        // Get account info
        await getAccountInfo();

        // Fetch market data
        const response = await axios.get(PUBLIC_URL, { timeout: 15000 });
        if (!response.data || !response.data.tickers) {
            setTimeout(scan, CONFIG.SCAN_INTERVAL);
            return;
        }

        const tickers = response.data.tickers;

        // Update price memory
        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;

            const price = Number(t.last || 0);
            const volume = Number(t.vol_idr || 0);

            if (price > 0) {
                state.priceMemory[pair] = [...(state.priceMemory[pair] || []), price].slice(-50);
                state.volMemory[pair] = [...(state.volMemory[pair] || []), volume].slice(-20);
            }
        }

        // Detect market regime
        const marketRegime = analyzer.detectMarketRegime(tickers);

        // Manage positions
        await managePositions(tickers);

        // Scan for opportunities
        const candidates = [];

        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;

            const base = pair.split("_")[0];
            if (BLACKLIST.has(base)) continue;
            if (USE_WHITELIST && !WHITELIST.has(base)) continue;
            if (Date.now() - (state.cooldown[pair] || 0) < CONFIG.COOLDOWN_MIN * 60000) continue;
            if (state.positions[pair]) continue;

            const analysis = analyzer.evaluatePair(pair, t);
            if (analysis.score > 0) {
                candidates.push({ pair, ticker: t, ...analysis });
            }
        }

        candidates.sort((a, b) => b.score - a.score);

        // Display dashboard
        console.clear();
        console.log(`\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m`);
        console.log(`\x1b[36m║        PROFESSIONAL TRADING BOT v5.0 (API V2)           ║\x1b[0m`);
        console.log(`\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m\n`);

        console.log(`📊 MARKET REGIME: ${state.sentiment} | ${state.marketRegime}`);
        console.log(`💰 BALANCE: Rp ${formatIDR(state.equityNow)}`);
        console.log(`📉 DRAWDOWN: ${state.currentDrawdown.toFixed(2)}%`);
        console.log(`📊 DAILY LOSS: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n`);

        console.log(`📈 POSITIONS: ${Object.keys(state.positions).length}/${CONFIG.MAX_POSITIONS}`);
        if (Object.keys(state.positions).length > 0) {
            for (const [pair, pos] of Object.entries(state.positions)) {
                const currentPrice = Number(tickers[pair]?.last || 0);
                const pnl = currentPrice ? ((currentPrice - pos.entry) / pos.entry * 100) : 0;
                const color = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
                // Format harga live
                const livePriceFormatted = formatIDR(currentPrice);
                const targetFormatted = formatIDR(pos.target);

                // Tampilkan dengan harga live
                console.log(`   ${pair.padEnd(10)} | ${color}${pnl.toFixed(2)}%\x1b[0m | Live: ${livePriceFormatted} | Target: ${targetFormatted}`);
            }
        } else {
            console.log(`   No open positions`);
        }

        console.log(`\n🎯 TOP CANDIDATES:`);
        candidates.slice(0, 5).forEach((c, i) => {
            const color = c.score >= 8 ? "\x1b[32m" : c.score >= 6 ? "\x1b[33m" : "\x1b[0m";
            console.log(`   ${i + 1}. ${c.pair.padEnd(10)} ${color}Score: ${c.score.toFixed(1)} RSI: ${c.rsi.toFixed(0)} Conf: ${(c.confidence * 100).toFixed(0)}%\x1b[0m`);
        });

        // Execute trades
        const canTrade = riskManager.canTrade();

        if (canTrade && Object.keys(state.positions).length < CONFIG.MAX_POSITIONS) {
            const qualifiedCandidates = candidates.filter(c => {
                if (marketRegime.regime.includes("BEAR") && c.score < 7) return false;
                return c.score >= 6;
            });

            const topPick = qualifiedCandidates[0];
            if (topPick && !isBuying) {
                await executeBuy(topPick.pair, Number(topPick.ticker.last), topPick);
            }
        }

        saveState();

    } catch (err) {
        console.log("❌ Scan Error:", err.message);
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
            console.log("⚠️ Network error, but bot will continue...");
        }
    }

    setTimeout(scan, CONFIG.SCAN_INTERVAL);
}

/* ======================================================
   PROCESS HANDLERS
====================================================== */

process.on('SIGINT', async () => {
    console.log('\n⚠️ Received SIGINT. Saving state and shutting down...');
    saveState();
    await tg("🛑 Bot dihentikan secara manual", "WARNING");
    process.exit(0);
});

process.on('uncaughtException', async (err) => {
    console.log('❌ Uncaught Exception:', err);
    if (typeof tg === 'function') {
        await tg(`❌ Uncaught Exception: ${err.message}`, "ERROR");
    }
    saveState();
});

/* ======================================================
   BOT INITIALIZATION
====================================================== */

(async () => {
    console.log("🚀 Initializing Professional Trading Bot v5.0 (API V2)...");

    // Test API connection
    const info = await getAccountInfo();

    if (info.success) {
        console.log("✅ API Connection Successful");
        console.log(`💰 Initial Balance: Rp ${formatIDR(state.equityNow)}`);

        // Sync trade history
        console.log("📊 Syncing trade history...");
        await syncTradeHistory();

        if (state.peakEquity === 0) {
            state.peakEquity = state.equityNow;
        }

        await tg(
            `🤖 Bot Started Successfully (API V2)\n` +
            `Balance: Rp ${formatIDR(state.equityNow)}\n` +
            `Daily Loss: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%`,
            "SUCCESS"
        );

        scan();
    } else {
        console.log("❌ Failed to connect to Indodax API");
        console.log("Please check your API keys in .env file");
        await tg("❌ Bot failed to start: API Connection Error", "ERROR");
    }
})();