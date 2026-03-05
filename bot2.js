import dotenv from "dotenv";
import crypto from "crypto";
import querystring from "querystring";
import https from "https";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import MultiTimeframeAnalyzer from './MultiTimeframeAnalyzer.js';
import { ATR } from "technicalindicators";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    INDODAX_API_KEY,
    INDODAX_SECRET_KEY
} = process.env;

// ======================================================
// API ENDPOINTS
// ======================================================
const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";
const STATE_FILE = path.join(__dirname, "bot_state.json");
const LOG_FILE = path.join(__dirname, "trading_journal.csv");

/* =========================
   RISK CONFIG
========================= */


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

    USE_ATR: true,                     // Aktifkan ATR-based stops
    ATR_PERIOD: 14,                    // Periode ATR (default 14)
    ATR_STOP_MULTIPLIER: 2.0,          // Stop loss = ATR * multiplier
    ATR_TP_MULTIPLIER: 3.0,            // Take profit = ATR * multiplier
    ATR_TRAILING_MULTIPLIER: 1.5,      // Trailing stop = ATR * multiplier

    // === ATR-BASED POSITION SIZING ===
    ATR_RISK_PERCENT: 1.0,              // Risiko per trade berdasarkan ATR
    USE_ATR_POSITION_SIZING: true,      // Gunakan ATR untuk position sizing

    // === LEGACY SETTINGS (untuk fallback jika ATR tidak tersedia) ===
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

    // === MULTI-TIMEFRAME ANALYSIS ===
    TIMEFRAMES: [5, 15, 60],
    TIMEFRAME_WEIGHTS: {
        '5m': 0.2,
        '15m': 0.3,
        '60m': 0.5
    },
    MIN_TF_CONSENSUS: 0.6,
    USE_MULTI_TIMEFRAME: true,

    // === ENHANCED MULTI-TF SETTINGS ===
    TF_BONUS_BULLISH: 2.0,      // Bonus maksimal untuk bullish consensus
    TF_BONUS_SIDEWAYS: 0.5,     // Bonus untuk sideways
    TF_PENALTY_BEARISH: -1.0,    // Penalti untuk bearish
    TF_MIN_STRENGTH: 0.3         // Minimal kekuatan untuk dipertimbangkan


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
    lastDate: new Date().toDateString(),

    ATR_MIN_PERCENT: 1.5,       // Stop Loss tidak boleh lebih kecil dari 1.5% (menghindari noise)
    ATR_MAX_PERCENT: 5.0,       // Stop Loss tidak boleh lebih besar dari 5.0% (menghindari risk berlebih)

    // Stats untuk multi-timeframe
    multiTFStats: {
        totalChecks: 0,
        approved: 0,
        rejected: 0,
        lastUpdate: 0
    }
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
   GET CANDLESTICK DATA FROM PRICE MEMORY
====================================================== */

function getCandlesFromPriceMemory(pair, count = 20) {
    const prices = state.priceMemory[pair] || [];
    if (prices.length < count + 1) return null;

    // Konversi dari array harga menjadi candlestick sederhana
    // Asumsi: setiap 4 harga membentuk 1 candle (open, high, low, close)
    const candles = [];
    const candleSize = 4; // 4 harga per candle (sesuaikan dengan kebutuhan)

    for (let i = 0; i < prices.length - candleSize; i += candleSize) {
        const candlePrices = prices.slice(i, i + candleSize);

        candles.push({
            open: candlePrices[0],
            high: Math.max(...candlePrices),
            low: Math.min(...candlePrices),
            close: candlePrices[candlePrices.length - 1]
        });
    }

    return candles;
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
   INDOAX API V2 - PRIVATE REQUEST
====================================================== */

async function privateRequest(method, params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now();
            const bodyParams = {
                method: method,
                timestamp: timestamp,
                recvWindow: CONFIG.RECV_WINDOW,
                ...params
            };

            const postBody = Object.keys(bodyParams)
                .map(key => `${key}=${encodeURIComponent(bodyParams[key])}`)
                .join('&');

            const sign = crypto
                .createHmac("sha512", INDODAX_SECRET_KEY)
                .update(postBody)
                .digest("hex");

            const headers = {
                "Key": INDODAX_API_KEY,
                "Sign": sign,
                "Content-Type": "application/x-www-form-urlencoded"
            };

            const options = {
                method: "POST",
                headers: headers
            };

            const res = await makeRequest(TAPI_URL, options, postBody, retries);

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
   GET ACCOUNT INFO
====================================================== */

async function getAccountInfo() {
    try {
        const response = await privateRequest('getInfo');

        if (response.success) {
            const balance = response.data.balance || {};
            const idrBalance = Number(balance.idr || 0);

            state.equityNow = idrBalance;

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
   TRADE HISTORY SYNC
====================================================== */

async function syncTradeHistory() {
    try {
        const activePairs = ['btc_idr', 'eth_idr', 'usdt_idr'];

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

            await sleep(500);
        }

        const today = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        let dailyPL = 0;

        allTrades.forEach(trade => {
            if (trade.trade_time >= today) {
                const tradeValue = Number(trade.price) * Number(trade[Object.keys(trade)[3]]);
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
   PLACE ORDER
====================================================== */

/* ======================================================
   PLACE ORDER (FIXED FOR DECIMAL ERROR)
====================================================== */

async function placeOrder(pair, type, price, amount, useIdr = true) {
    try {
        const coin = pair.split('_')[0];
        const params = {
            pair: pair,
            type: type,
            price: Math.floor(price)
        };

        if (type === 'buy') {
            params.idr = Math.floor(amount);
        } else {
            // Daftar koin yang HANYA menerima angka bulat (integer) di Indodax
            const integerCoins = ['pippin', 'pepe', 'jellyjelly', 'fartcoin', 'pengu', 'hype', 'doge', 'shib'];

            if (integerCoins.includes(coin)) {
                // Konversi ke Number lalu floor untuk memastikan tidak ada .00000001
                const finalAmount = Math.floor(Number(amount));
                params[coin] = finalAmount;
                console.log(`💰 [FORMATTING] Menjual koin integer ${coin}: ${finalAmount}`);
            } else {
                // Untuk koin standard (BTC, ETH, dll) gunakan 8 desimal
                params[coin] = Number(Number(amount).toFixed(8));
            }
        }

        params.client_order_id = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        console.log(`📤 Mengirim Order: ${type} ${pair} | Qty/Idr: ${params[coin] || params.idr}`);

        const response = await privateRequest('trade', params);

        if (response.success) {
            console.log(`✅ Order ${type} ${pair} Berhasil!`);
            return { success: true, data: response.data };
        } else {
            console.log(`❌ Order ${type} ${pair} Gagal: ${response.error}`);

            // Jika gagal karena minimal order, panggil fungsi "belajar" milikmu
            if (response.error && (response.error.includes("minimum") || response.error.includes("small"))) {
                await updateMinOrderFromError(pair, response.error);
            }

            return { success: false, error: response.error };
        }

    } catch (e) {
        console.log("❌ Place order error:", e.message);
        return { success: false, error: e.message };
    }
}

/* ======================================================
   UPDATE MIN ORDER FROM ERROR (YOUR ENHANCED VERSION)
====================================================== */

async function updateMinOrderFromError(pair, errorMessage) {
    try {
        console.log(`\n🔍 Menganalisis error minimal order untuk ${pair}...`);

        const patterns = [
            /minimum.*?(\d+(?:\.\d+)?)/i,
            /under the minimum.*?(\d+(?:\.\d+)?)/i,
            /minimal.*?(\d+(?:\.\d+)?)/i,
            /total transaction.*?(\d+(?:\.\d+)?)/i,
            /(\d+(?:\.\d+)?).*?minimum/i
        ];

        let suggestedMin = null;

        for (const pattern of patterns) {
            const match = errorMessage.match(pattern);
            if (match && match[1]) {
                suggestedMin = parseInt(match[1]);
                break;
            }
        }

        // Fallback jika pattern tidak ketemu
        if (!suggestedMin) {
            const allNumbers = errorMessage.match(/\d+(?:\.\d+)?/g);
            if (allNumbers && allNumbers.length > 0) {
                const validNumbers = allNumbers
                    .map(Number)
                    .filter(n => n >= 10000 && n <= 1000000); // Filter range IDR logis

                if (validNumbers.length > 0) {
                    suggestedMin = Math.max(...validNumbers);
                }
            }
        }

        if (suggestedMin) {
            // TAMBAHKAN BUFFER: Tambah Rp 2.000 agar tidak terkena pembulatan fee
            const finalMin = suggestedMin + 2000;

            console.log(`📊 Mendeteksi minimal order ${pair}: Rp ${formatIDR(suggestedMin)} (Disimpan: Rp ${formatIDR(finalMin)})`);

            if (!state.minOrderCache) state.minOrderCache = {};

            state.minOrderCache[pair] = finalMin;
            saveState();

            console.log(`✅ Minimal order ${pair} diperbarui.`);
        } else {
            console.log(`⚠️ Tidak bisa mendeteksi angka dari error: ${errorMessage}`);
        }

    } catch (e) {
        console.log("❌ Error di updateMinOrderFromError:", e.message);
    }
}



/* ======================================================
   CANCEL ORDER
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
   TECHNICAL INDICATORS
====================================================== */

class TechnicalIndicators {

    static atr(high, low, close, period = 14) {
        if (!high || !low || !close || high.length < period + 1) return null;

        try {
            // Gunakan library technicalindicators jika tersedia
            const ATR = require('technicalindicators').ATR;
            const atrValues = ATR.calculate({
                high,
                low,
                close,
                period
            });

            return atrValues[atrValues.length - 1];
        } catch (e) {
            // Fallback: hitung manual jika library error
            return this.calculateATRManual(high, low, close, period);
        }
    }

    static calculateATRManual(high, low, close, period = 14) {
        const tr = [];

        // Hitung True Range
        for (let i = 1; i < high.length; i++) {
            const hl = high[i] - low[i];
            const hc = Math.abs(high[i] - close[i - 1]);
            const lc = Math.abs(low[i] - close[i - 1]);

            tr.push(Math.max(hl, hc, lc));
        }

        // Hitung ATR (rata-rata dari TR)
        if (tr.length < period) return null;

        let sum = 0;
        for (let i = tr.length - period; i < tr.length; i++) {
            sum += tr[i];
        }

        return sum / period;
    }

    static getATRFromCandles(prices, period = 14) {
        if (!prices || prices.length < period + 1) return null;

        // prices adalah array harga close, tapi kita perlu high, low
        // Asumsi: prices adalah array harga close saja, kita perlu buat candlestick
        // Untuk sementara, gunakan metode sederhana
        const high = [];
        const low = [];
        const close = [];

        // Buat candlestick sederhana (dengan asumsi harga close sebagai semua)
        for (let i = 0; i < prices.length; i++) {
            if (i > 0) {
                const prevPrice = prices[i - 1];
                const currPrice = prices[i];

                high.push(Math.max(prevPrice, currPrice));
                low.push(Math.min(prevPrice, currPrice));
                close.push(currPrice);
            }
        }

        return this.atr(high, low, close, period);
    }

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
   MULTI-TIMEFRAME ANALYZER INITIALIZATION
====================================================== */

const multiTFAnalyzer = new MultiTimeframeAnalyzer(
    CONFIG,
    TechnicalIndicators,
    state
);

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

        if (vol < this.config.MIN_VOL_24H) {
            return { score: 0, reason: "INSUFFICIENT_VOLUME", rsi: 50 };
        }

        const spread = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
        if (spread > this.config.MAX_SPREAD) {
            return { score: 0, reason: "SPREAD_TOO_WIDE", rsi: 50 };
        }

        const pumpFromLow = ((price - low24h) / low24h) * 100;
        if (pumpFromLow > this.config.MAX_PUMP_PERCENT) {
            return { score: 0, reason: "PUMPED", rsi: 50 };
        }

        const priceHistory = this.state.priceMemory[pair] || [];
        if (priceHistory.length < this.config.MEM_LIMIT) {
            return { score: 0, reason: `BUILDING_DATA(${priceHistory.length})`, rsi: 50 };
        }

        const rsi = TechnicalIndicators.rsi(priceHistory, this.config.RSI_PERIOD);
        const ema9 = TechnicalIndicators.ema(priceHistory.slice(-20), 9);
        const ema21 = TechnicalIndicators.ema(priceHistory, 21);
        const bb = TechnicalIndicators.bb(priceHistory, this.config.BB_PERIOD, this.config.BB_STD);
        const marketStructure = TechnicalIndicators.detectMarketStructure(priceHistory);

        if (rsi < this.config.RSI_MIN || rsi > this.config.RSI_MAX) {
            return { score: 0, reason: "RSI_OUT_OF_RANGE", rsi };
        }

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

        // 1. DATA PREPARATION
        const prices = state.priceMemory[pair] || [];
        let atrValue = null;
        let atrPercent = null;
        let useAtr = CONFIG.USE_ATR;

        // 2. HITUNG ATR DENGAN SAFETY CHECK
        try {
            if (prices.length >= CONFIG.ATR_PERIOD + 10) {
                atrValue = TechnicalIndicators.getATRFromCandles(prices, CONFIG.ATR_PERIOD);

                if (atrValue) {
                    atrPercent = (atrValue / price) * 100;
                    console.log(`📊 ATR ${pair}: ${atrValue.toFixed(2)} (${atrPercent.toFixed(2)}%)`);
                } else {
                    useAtr = false;
                }
            } else {
                console.log(`⚠️ Data kurang untuk ATR (${prices.length}/${CONFIG.ATR_PERIOD + 10})`);
                useAtr = false;
            }
        } catch (e) {
            console.log(`⚠️ Error ATR: ${e.message}`);
            useAtr = false;
        }

        // 3. LOGIKA CLAMPING STOP LOSS (Anti Terlalu Besar / Kecil)
        let stopPrice, targetPrice, finalSlPercent;

        if (useAtr && atrValue) {
            // Hitung jarak berdasarkan multiplier
            let slDistancePercent = (atrValue * CONFIG.ATR_STOP_MULTIPLIER / price) * 100;

            // --- PROTEKSI ATR ---
            // Minimal SL 1.5% (agar tidak gampang kena noise)
            // Maksimal SL 5.0% (agar risiko tidak bengkak)
            finalSlPercent = Math.max(1.5, Math.min(5.0, slDistancePercent));

            // Risk:Reward Ratio (misal 1:2)
            const tpDistancePercent = finalSlPercent * (CONFIG.ATR_TP_MULTIPLIER / CONFIG.ATR_STOP_MULTIPLIER);

            stopPrice = price * (1 - (finalSlPercent / 100));
            targetPrice = price * (1 + (tpDistancePercent / 100));
        } else {
            // Fallback ke Fixed Percent jika ATR gagal
            finalSlPercent = CONFIG.SL_PERCENT;
            stopPrice = price * (1 - (CONFIG.SL_PERCENT / 100));
            targetPrice = price * (1 + (CONFIG.TP_PERCENT / 100));
        }

        // 4. POSITION SIZING (Menyesuaikan Volatilitas)
        const openSlots = CONFIG.MAX_POSITIONS - Object.keys(state.positions).length;
        if (openSlots <= 0) {
            console.log(`[SKIP] Slot penuh (${CONFIG.MAX_POSITIONS})`);
            return;
        }

        let spend;
        if (useAtr && atrPercent) {
            // Jika market sangat volatil (ATR % tinggi), gunakan modal lebih kecil
            let riskMultiplier = atrPercent > 1.5 ? 0.4 : (atrPercent > 0.8 ? 0.6 : 0.8);
            spend = Math.floor((state.equityNow * riskMultiplier) / openSlots);
        } else {
            spend = Math.floor((state.equityNow * 0.95) / CONFIG.MAX_POSITIONS);
        }

        // 5. VALIDASI MINIMAL ORDER (Gunakan hasil "belajar" bot sebelumnya)
        const cachedMin = state.minOrderCache?.[pair] || 50000;
        if (spend < cachedMin) {
            console.log(`⚠️ Modal Rp ${formatIDR(spend)} < Minimal ${pair} (Rp ${formatIDR(cachedMin)})`);
            // Coba naikkan ke minimal jika saldo cukup
            if (state.equityNow > cachedMin + 5000) {
                spend = cachedMin + 2000;
            } else {
                return;
            }
        }

        // 6. EKSEKUSI
        console.log(`\n🔵 Mencoba beli ${pair} | SL: ${finalSlPercent.toFixed(2)}%`);
        const res = await placeOrder(pair, 'buy', price, spend, true);

        if (res.success) {
            state.positions[pair] = {
                entry: price,
                high: price,
                stop: stopPrice,
                target: targetPrice,
                slPercent: finalSlPercent,
                atrValue: atrValue,
                size: spend,
                time: new Date().toLocaleString("id-ID"),
                strategy: useAtr ? "ATR-Adaptive" : "Fixed-Risk"
            };

            saveState();
            await getAccountInfo();

            // 7. TELEGRAM NOTIFICATION (Tetap Detail)
            const msg = `🚀 <b>BUY EXECUTED</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔹 <b>Pair</b>      : ${pair.toUpperCase()}\n` +
                `🔹 <b>Price</b>     : Rp ${formatIDR(price)}\n` +
                `🔹 <b>Modal</b>     : Rp ${formatIDR(spend)}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🛡️ <b>SL (${finalSlPercent.toFixed(2)}%)</b> : Rp ${formatIDR(stopPrice)}\n` +
                `🎯 <b>Target</b>    : Rp ${formatIDR(targetPrice)}\n` +
                `📊 <b>Strategy</b>  : ${useAtr ? 'ATR-Adaptive' : 'Fixed'}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 <b>Sisa Saldo</b> : Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, "TRADE");
            console.log(`✅ Berhasil beli ${pair}`);

        } else {
            console.log(`❌ Gagal beli ${pair}: ${res.error}`);
        }

    } catch (e) {
        console.log("❌ Error di executeBuy:", e.message);
    } finally {
        isBuying = false;
    }
}

/* ======================================================
   EXECUTE SELL - PERBAIKAN DENGAN HANDLING DECIMAL
====================================================== */


async function executeSell(pair, price, reason) {
    const pos = state.positions[pair];
    if (!pos) return;

    try {
        await getAccountInfo();

        // ===== AMBIL JUMLAH KOIN REAL DARI API =====
        const auth = await privateRequest('getInfo');
        if (!auth.success) {
            console.log("❌ Gagal ambil info akun, menggunakan estimasi");
            // Fallback ke estimasi jika API gagal
            var amount = pos.size / pos.entry;
        } else {
            const balance = auth.data.balance || {};
            const coin = pair.split('_')[0];
            amount = Number(balance[coin] || 0);

            console.log(`💰 Saldo ${coin} dari API: ${amount} (type: ${typeof amount})`);

            // Jika saldo 0, berarti sudah dijual manual
            if (amount <= 0) {
                console.log(`⚠️ ${coin} sudah tidak ada (0), menghapus posisi`);
                delete state.positions[pair];
                saveState();
                return;
            }
        }

        // ===== FORMAT JUMLAH KOIN SESUAI KEBUTUHAN API =====
        const coin = pair.split('_')[0];

        // Daftar koin yang membutuhkan integer (tanpa desimal)
        const integerCoins = ['pippin', 'pepe', 'jellyjelly', 'fartcoin', 'pengu', 'hype', 'btc', 'eth'];

        // Format amount sesuai jenis koin
        let formattedAmount;
        if (integerCoins.includes(coin)) {
            // Untuk koin tertentu, gunakan INTEGER MURNI (bukan string, bukan float dengan desimal)
            formattedAmount = Math.floor(amount);
            console.log(`💰 Format integer murni: ${formattedAmount} (${typeof formattedAmount}) untuk ${coin}`);
        } else {
            // Untuk koin lain, gunakan 8 desimal
            formattedAmount = Number(amount.toFixed(8));
            console.log(`💰 Format 8 desimal: ${formattedAmount} untuk ${coin}`);
        }

        // Validasi: pastikan formattedAmount > 0
        if (formattedAmount <= 0) {
            console.log(`❌ Jumlah koin tidak valid: ${formattedAmount}, menghapus posisi`);
            delete state.positions[pair];
            saveState();
            return;
        }

        // ===== EKSEKUSI ORDER JUAL =====
        const sellPrice = Math.floor(price * 0.998);
        console.log(`🔵 Menjual ${formattedAmount} ${coin} @ ${sellPrice}`);

        // Panggil placeOrder dengan formattedAmount yang sudah benar
        const res = await placeOrder(pair, 'sell', sellPrice, formattedAmount, false);

        if (res.success) {
            const grossPnlPercent = ((price - pos.entry) / pos.entry) * 100;

            // Hapus posisi dari state
            delete state.positions[pair];
            state.cooldown[pair] = Date.now();
            state.lastTradeTime = Date.now();

            // Update streak
            if (grossPnlPercent < 0) {
                state.consecutiveLosses++;
                state.consecutiveWins = 0;
            } else {
                state.consecutiveWins++;
                state.consecutiveLosses = 0;
            }

            saveState();
            await getAccountInfo();

            // ===== PERSIAPAN NOTIFIKASI TELEGRAM =====
            const emoji = grossPnlPercent >= 0 ? "💰" : "📉";

            // Hitung P&L dalam Rupiah (estimasi)
            const pnlValue = (price - pos.entry) * (pos.size / pos.entry);
            const pnlFormatted = pnlValue >= 0 ? `+Rp ${formatIDR(pnlValue)}` : `-Rp ${formatIDR(Math.abs(pnlValue))}`;

            // Hitung hold time
            const holdTime = Math.floor((Date.now() - new Date(pos.time).getTime()) / 60000);
            const holdText = holdTime < 60 ? `${holdTime}m` : `${Math.floor(holdTime / 60)}j ${holdTime % 60}m`;

            // Tentukan icon berdasarkan reason
            const reasonIcon = {
                'TAKE_PROFIT': '🎯',
                'TRAILING_STOP': '📈',
                'STOP_LOSS': '🛑',
                'MANUAL_SELL': '👤'
            }[reason] || '📌';

            // ===== NOTIFIKASI TELEGRAM =====
            const msg = `${emoji} <b>POSITION CLOSED</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🏷️ <b>Pair</b>        : ${pair.toUpperCase()}\n` +
                `📥 <b>Entry</b>       : Rp ${formatIDR(pos.entry)}\n` +
                `📤 <b>Exit</b>        : Rp ${formatIDR(price)}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Result</b>      : ${formatPercent(grossPnlPercent)}\n` +
                `💰 <b>P&L</b>         : ${pnlFormatted}\n` +
                `${reasonIcon} <b>Reason</b>      : ${reason}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💎 <b>New Balance</b>  : Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, grossPnlPercent >= 0 ? "SUCCESS" : "WARNING");
            console.log(`✅ [SELL] ${pair} @ ${formatIDR(price)} | P&L: ${formatPercent(grossPnlPercent)}`);

        } else {
            console.log(`❌ Gagal menjual ${pair}: ${res.error}`);

            // ===== FALLBACK: COBA DENGAN INTEGER MURNI =====
            if (res.error && res.error.includes("decimal")) {
                console.log(`🔄 Mencoba fallback dengan integer murni...`);

                // Ambil lagi saldo real dari API
                const auth2 = await privateRequest('getInfo');
                if (auth2.success) {
                    const balance2 = auth2.data.balance || {};
                    const fallbackAmount = Math.floor(Number(balance2[coin] || 0));

                    if (fallbackAmount > 0) {
                        console.log(`🔄 Fallback dengan integer: ${fallbackAmount}`);
                        const res2 = await placeOrder(pair, 'sell', sellPrice, fallbackAmount, false);

                        if (res2.success) {
                            console.log(`✅ Fallback berhasil!`);
                            // Proses sukses - panggil lagi fungsi ini? Atau langsung proses?
                            // Sederhananya, kita bisa rekursif panggil executeSell lagi
                            // Tapi hati-hati infinite loop, jadi lebih baik proses manual

                            // Update state
                            delete state.positions[pair];
                            state.cooldown[pair] = Date.now();
                            saveState();
                            await getAccountInfo();

                            await tg(`⚠️ Fallback sell ${pair} berhasil dengan integer ${fallbackAmount}`, "WARNING");
                        }
                    } else {
                        console.log(`❌ Fallback gagal: saldo 0`);
                    }
                }
            }

            // Log tambahan untuk debugging
            console.log(`💡 Debug info - amount: ${amount}, formatted: ${formattedAmount}, type: ${typeof formattedAmount}`);
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
        const targetPrice = pos.target;

        // ===== ATR-BASED TRAILING STOP =====
        let stopPrice = pos.currentStop || pos.stop;

        if (pos.useAtr && pos.atrValue) {
            // ATR-based trailing stop: lebih dinamis
            const atrTrailingDistance = pos.atrValue * CONFIG.ATR_TRAILING_MULTIPLIER;
            const atrTrailingStop = (pos.high || currentPrice) - atrTrailingDistance;

            // Trailing stop hanya naik
            if (atrTrailingStop > stopPrice) {
                stopPrice = atrTrailingStop;
                state.positions[pair].currentStop = stopPrice;
                console.log(`📈 ATR Trailing ${pair} naik: ${formatIDR(stopPrice)} (ATR: ${pos.atrValue.toFixed(2)})`);
                saveState();
            }
        } else {
            // Fixed percentage trailing stop
            if (profitPercent >= CONFIG.TRAILING_ACTIVATION) {
                const newTrailingStop = (pos.high || currentPrice) * (1 - CONFIG.TRAILING_GAP / 100);
                if (newTrailingStop > stopPrice) {
                    stopPrice = newTrailingStop;
                    state.positions[pair].currentStop = stopPrice;
                    console.log(`📈 Fixed Trailing ${pair} naik: ${formatIDR(stopPrice)}`);
                    saveState();
                }
            }
        }

        // ===== DEBUG =====
        console.log(`\n🔍 CHECKING ${pair}:`);
        console.log(`   Current: ${currentPrice}`);
        console.log(`   Entry: ${pos.entry}`);
        console.log(`   Profit: ${profitPercent.toFixed(2)}%`);
        console.log(`   Stop: ${formatIDR(stopPrice)}`);
        console.log(`   Target: ${formatIDR(targetPrice)}`);
        if (pos.atrValue) {
            console.log(`   ATR: ${pos.atrValue.toFixed(2)} (${pos.atrPercent?.toFixed(2)}%)`);
        }

        // ===== EKSEKUSI JUAL =====
        if (currentPrice >= targetPrice) {
            console.log(`🎯 TARGET HIT! Menjual ${pair} di ${currentPrice}`);
            await executeSell(pair, currentPrice, "TAKE_PROFIT");
        }
        else if (currentPrice <= stopPrice) {
            const exitReason = profitPercent > 0 ? "TRAILING_STOP" : "STOP_LOSS";
            console.log(`🛑 STOP HIT! Menjual ${pair} di ${currentPrice} (${exitReason})`);
            await executeSell(pair, currentPrice, exitReason);
        }
    }
}
/* ======================================================
   TELEGRAM COMMAND HANDLER
====================================================== */

let lastUpdateId = 0;

async function handleTelegramCommands() {
    if (!TELEGRAM_BOT_TOKEN) return;

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;

        const response = await axios.get(url);

        if (response.data.ok && response.data.result.length > 0) {
            for (const update of response.data.result) {
                lastUpdateId = update.update_id;

                const chatId = update.message?.chat?.id;
                const text = update.message?.text;

                if (chatId != TELEGRAM_CHAT_ID) continue;

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
    const cmd = command.toLowerCase().split(' ')[0];

    switch (cmd) {
        case '/start':
            response = `🤖 <b>TRADING BOT v5.0</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Bot siap digunakan!\n\n` +
                `<b>Perintah tersedia:</b>\n` +
                `• /status - Tampilkan status terkini\n` +
                `• /positions - Detail posisi aktif\n` +
                `• /balance - Cek saldo IDR\n` +
                `• /tf [pair] - Analisis multi-timeframe\n` +
                `• /help - Tampilkan menu ini\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;
        case '/atr':
            const atrPair = command.split(' ')[1] || 'pepe_idr';

            const prices = state.priceMemory[atrPair] || [];
            if (prices.length < 20) {
                response = `❌ Data tidak cukup untuk ${atrPair} (${prices.length} candles)`;
                break;
            }

            const atrValue = TechnicalIndicators.getATRFromCandles(prices, CONFIG.ATR_PERIOD);
            const currentPrice = prices[prices.length - 1];

            if (atrValue) {
                const atrPercent = (atrValue / currentPrice) * 100;
                response = `📊 <b>ATR ANALYSIS ${atrPair.toUpperCase()}</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Current Price: Rp ${formatIDR(currentPrice)}\n` +
                    `ATR (${CONFIG.ATR_PERIOD}): ${atrValue.toFixed(2)}\n` +
                    `ATR %: ${atrPercent.toFixed(2)}%\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Stop Loss (${CONFIG.ATR_STOP_MULTIPLIER}x): Rp ${formatIDR(currentPrice - atrValue * CONFIG.ATR_STOP_MULTIPLIER)}\n` +
                    `Take Profit (${CONFIG.ATR_TP_MULTIPLIER}x): Rp ${formatIDR(currentPrice + atrValue * CONFIG.ATR_TP_MULTIPLIER)}`;
            } else {
                response = `❌ Tidak bisa menghitung ATR untuk ${atrPair}`;
            }
            break;
        case '/help':
            response = `📋 <b>DAFTAR PERINTAH</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `/status - Tampilan dashboard lengkap\n` +
                `/balance - Ringkasan saldo dan drawdown\n` +
                `/positions - Detail posisi aktif\n` +
                `/daily - Info daily loss hari ini\n` +
                `/tf [pair] - Analisis multi-timeframe\n` +
                `/help - Tampilkan menu ini\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        case '/status':
        case '/dashboard':
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

        case '/tf':
        case '/timeframe':
            const tfPair = command.split(' ')[1] || 'pepe_idr';

            const tfAnalyses = multiTFAnalyzer.analyzeAllTimeframes(tfPair);
            if (!tfAnalyses || tfAnalyses.length === 0) {
                response = `❌ No timeframe data for ${tfPair}`;
                break;
            }

            const tfConsensus = multiTFAnalyzer.calculateConsensus(tfAnalyses);
            const tfCanEnter = multiTFAnalyzer.canEnter(tfPair, 6);

            let tfMsg = `📊 <b>MULTI-TIMEFRAME ${tfPair.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n`;

            tfAnalyses.forEach(a => {
                const arrow = a.trend.includes("BULLISH") ? "🟢" : a.trend.includes("BEARISH") ? "🔴" : "⚪";
                tfMsg += `${arrow} <b>${a.timeframe}:</b> ${a.trend} | RSI: ${a.rsi}\n`;
            });

            tfMsg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
            tfMsg += `<b>CONSENSUS:</b> ${tfConsensus.direction} (${(tfConsensus.consensusStrength * 100).toFixed(0)}%)\n`;
            tfMsg += `<b>ENTRY ALLOWED:</b> ${tfCanEnter.allowed ? '✅ YES' : '❌ NO'} (${tfCanEnter.reason})`;

            response = tfMsg;
            break;

        default:
            response = `Perintah tidak dikenal. Ketik /help untuk bantuan.`;
    }

    await tg(response, "INFO");
}

/* ======================================================
   MAIN SCANNER LOOP - OPTIMIZED WITH MULTI-TF
====================================================== */

async function scan() {
    try {
        await handleTelegramCommands();

        for (const [pair, pos] of Object.entries(state.positions)) {
            if (!pos.currentStop) {
                console.log(`🔄 Migrasi posisi ${pair}: menambahkan currentStop`);
                state.positions[pair].currentStop = pos.stop;
                saveState();
            }
        }

        const now = Date.now();
        if (now - tradeHistoryCache.lastSync > CONFIG.TRADE_HISTORY_SYNC_INTERVAL) {
            await syncTradeHistory();

            const today = new Date().toDateString();
            if (state.lastDate !== today) {
                console.log("📅 New day detected");
                state.lastDate = today;
            }
        }

        await getAccountInfo();

        const response = await axios.get(PUBLIC_URL, { timeout: 15000 });
        if (!response.data || !response.data.tickers) {
            setTimeout(scan, CONFIG.SCAN_INTERVAL);
            return;
        }

        const tickers = response.data.tickers;

        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;

            const price = Number(t.last || 0);
            const volume = Number(t.vol_idr || 0);

            if (price > 0) {
                state.priceMemory[pair] = [...(state.priceMemory[pair] || []), price].slice(-50);
                state.volMemory[pair] = [...(state.volMemory[pair] || []), volume].slice(-20);
            }
        }

        const marketRegime = analyzer.detectMarketRegime(tickers);
        await managePositions(tickers);

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
                const livePriceFormatted = formatIDR(currentPrice);
                const targetFormatted = formatIDR(pos.target);

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

        // MULTI-TIMEFRAME INSIGHT DENGAN WEIGHTED SCORE
        console.log(`\n📊 MULTI-TIMEFRAME INSIGHT (${CONFIG.TIMEFRAMES.join('/')}m):`);
        const topThree = candidates.slice(0, 3);
        for (const c of topThree) {
            const insight = multiTFAnalyzer.getInsight(c.pair, c.score);
            if (insight?.consensus) {
                const arrow = insight.consensus.direction === "BULLISH" ? "🟢" :
                    insight.consensus.direction === "BEARISH" ? "🔴" : "⚪";

                // Hitung weighted score
                let weightedScore = c.score;
                if (insight.consensus.direction === "BULLISH") {
                    weightedScore += insight.consensus.consensusStrength * CONFIG.TF_BONUS_BULLISH;
                } else if (insight.consensus.direction === "SIDEWAYS") {
                    weightedScore += insight.consensus.consensusStrength * CONFIG.TF_BONUS_SIDEWAYS;
                } else if (insight.consensus.direction === "BEARISH") {
                    weightedScore += CONFIG.TF_PENALTY_BEARISH;
                }

                weightedScore = Math.min(10, Math.max(0, weightedScore));

                console.log(`   ${c.pair.padEnd(12)} ${arrow} ${insight.consensus.direction} (${(insight.consensus.consensusStrength * 100).toFixed(0)}%)`);
                console.log(`        Teknikal: ${c.score.toFixed(1)} | Weighted: ${weightedScore.toFixed(1)} | ${insight.canEnter ? '✅ LAYAK' : '⛔ SKIP'}`);
            }
        }

        // EXECUTE TRADES DENGAN ENHANCED MULTI-TF LOGIC
        const canTrade = riskManager.canTrade();

        if (canTrade && Object.keys(state.positions).length < CONFIG.MAX_POSITIONS) {
            // Filter dan beri bobot multi-timeframe
            const qualifiedCandidates = [];

            for (const c of candidates) {
                if (c.score < 6) continue;
                if (marketRegime.regime.includes("BEAR") && c.score < 7) continue;

                const tfCheck = multiTFAnalyzer.canEnter(c.pair, c.score);

                // Hitung final score dengan bobot
                let finalScore = c.score;
                if (tfCheck.consensus) {
                    if (tfCheck.consensus.direction === "BULLISH") {
                        finalScore += tfCheck.consensus.consensusStrength * CONFIG.TF_BONUS_BULLISH;
                    } else if (tfCheck.consensus.direction === "SIDEWAYS") {
                        finalScore += tfCheck.consensus.consensusStrength * CONFIG.TF_BONUS_SIDEWAYS;
                    } else if (tfCheck.consensus.direction === "BEARISH") {
                        finalScore += CONFIG.TF_PENALTY_BEARISH;
                    }
                }

                finalScore = Math.min(10, Math.max(0, finalScore));

                qualifiedCandidates.push({
                    ...c,
                    tfCheck,
                    finalScore,
                    tfDirection: tfCheck.consensus?.direction || 'UNKNOWN',
                    tfStrength: tfCheck.consensus?.consensusStrength || 0
                });
            }

            // Urutkan berdasarkan finalScore
            qualifiedCandidates.sort((a, b) => b.finalScore - a.finalScore);

            const topPick = qualifiedCandidates[0];
            if (topPick && !isBuying) {
                console.log(`\n🎯 TOP PICK: ${topPick.pair}`);
                console.log(`   Score Teknikal: ${topPick.score.toFixed(1)}`);
                console.log(`   Multi-TF: ${topPick.tfDirection} (${(topPick.tfStrength * 100).toFixed(0)}%) | ${topPick.tfCheck.allowed ? '✅' : '⛔'}`);
                console.log(`   Final Score: ${topPick.finalScore.toFixed(1)}`);

                if (topPick.tfCheck.allowed || topPick.finalScore >= 7) {
                    // Jika diizinkan atau final score tinggi, eksekusi
                    console.log(`✅ MULTI-TF: ${topPick.pair} approved for entry`);
                    await executeBuy(topPick.pair, Number(topPick.ticker.last), topPick);
                } else {
                    console.log(`⛔ Top pick ditolak oleh multi-timeframe`);

                    // Cari kandidat berikutnya dengan final score tinggi
                    const nextPick = qualifiedCandidates.find(c =>
                        (c.tfCheck.allowed || c.finalScore >= 7) && c.pair !== topPick.pair
                    );

                    if (nextPick && !isBuying) {
                        console.log(`🔄 Mencoba alternatif: ${nextPick.pair}`);
                        await executeBuy(nextPick.pair, Number(nextPick.ticker.last), nextPick);
                    }
                }
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

    const info = await getAccountInfo();

    if (info.success) {
        console.log("✅ API Connection Successful");
        console.log(`💰 Initial Balance: Rp ${formatIDR(state.equityNow)}`);

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