import dotenv from "dotenv";
import crypto from "crypto";
import querystring from "querystring";
import https from "https";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import MultiTimeframeAnalyzer from './MultiTimeframeAnalyzer.js';
import MarketAnalyzer from './MarketAnalyzer.js';
import TechnicalIndicators from './TechnicalIndicators.js';
import RiskManager from './RiskManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    INDODAX_API_KEY,
    INDODAX_SECRET_KEY
} = process.env;

let analyzer;
let riskManager;
let multiTFAnalyzer;
let technicalIndicators;
let componentsInitialized = false;

let lastUpdateId = 0;
let isTelegramActive = true;
let telegramRetryCount = 0;
let lastCleanup = 0;  // Untuk cleanup koin

// Debug imports
console.log("🔍 Import Debug:");
console.log("   - TechnicalIndicators:", TechnicalIndicators ? "✅" : "❌", typeof TechnicalIndicators);
console.log("   - MultiTimeframeAnalyzer:", MultiTimeframeAnalyzer ? "✅" : "❌", typeof MultiTimeframeAnalyzer);
console.log("   - MarketAnalyzer:", MarketAnalyzer ? "✅" : "❌", typeof MarketAnalyzer);
console.log("   - RiskManager:", RiskManager ? "✅" : "❌", typeof RiskManager);
console.log("----------------------------------------");

// ======================================================
// API ENDPOINTS
// ======================================================
const PUBLIC_URL = "https://indodax.com/api/summaries";
const TAPI_URL = "https://indodax.com/tapi";
const STATE_FILE = path.join(__dirname, "bot_state.json");
const LOG_FILE = path.join(__dirname, "trading_journal.csv");

let isBuying = false;


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
    // === RISK MANAGEMENT (AMAN) ===
    RISK_PER_TRADE: 1.0,                    // Turunkan dari 1.2 ke 1.0% biar lebih aman
    MAX_POSITIONS: 2,                        // Bagus, 2 posisi cukup untuk modal kecil
    MAX_DAILY_LOSS: 3,                       // Turunkan dari 5 ke 3% (cut loss lebih disiplin)
    MAX_DRAWDOWN: 50,                         // Turunkan dari 50 ke 30%
    MIN_EQUITY: 15000,                        // Naikkan jadi 50rb (minimal order 15rb x 2 posisi + buffer)

    // === MARKET FILTERS (LEBIH SELEKTIF) ===
    MIN_VOL_24H: 1_000_000_000,               // Naikkan dari 500jt ke 1M (volume lebih likuid)
    MAX_SPREAD: 0.15,                          // Turunkan dari 0.25 ke 0.15% (spread lebih ketat)
    MAX_PUMP_PERCENT: 8,                       // Turunkan dari 12 ke 8% (hindari koin overbought)
    MIN_PAIR_AGE: 7,                            // Tetap 7 hari

    // === TECHNICAL INDICATORS (LEBIH SELEKTIF) ===
    RSI_MIN: 55,                                // Turunkan dari 65 ke 55 (lebih banyak kandidat)
    RSI_MAX: 92,                                // Turunkan dari 98 ke 92 (hindari overbought ekstrem)
    RSI_PERIOD: 14,                             // Standar
    EMA_SHORT: 9,                               // Standar
    EMA_LONG: 21,                               // Standar
    BB_PERIOD: 20,                              // Standar
    BB_STD: 2,                                  // Standar

    // === TRADE EXECUTION (OPTIMAL) ===
    BUY_PERCENT: 0.95,                          // Naikkan dari 0.90 ke 0.95 (gunakan 95% balance)
    TP_PERCENT: 2,                             // Naikkan dari 2.8 ke 3.2% (target lebih besar)
    SL_PERCENT: 3.5,                             // Turunkan dari 4 ke 3.5% (cut loss lebih ketat)
    TRAILING_GAP: 1.8,                           // Turunkan dari 0.6 ke 0.5% (trailing lebih rapat)
    TRAILING_ACTIVATION: 2.0,                    // Turunkan dari 1.0 ke 0.8% (aktivasi lebih awal)

    // === SYSTEM PARAMETERS ===
    MEM_LIMIT: 15,                               // Standar
    COOLDOWN_MIN: 30,                             // Naikkan dari 25 ke 30 menit (lebih lama cooldown)
    SCAN_INTERVAL: 6000,                          // Naikkan dari 4000 ke 6000ms (kurangi rate limit)

    // === MARKET REGIME DETECTION ===
    TREND_STRENGTH_THRESHOLD: 0.60,               // Naikkan dari 0.55 ke 0.60 (trend lebih kuat)
    VOLATILITY_THRESHOLD: 0.12,                   // Turunkan dari 0.15 ke 0.12 (deteksi volatilitas lebih sensitif)

    // === PSYCHOLOGICAL SAFEGUARDS ===
    MAX_TRADES_PER_DAY: 5,                        // Turunkan dari 10 ke 5 (lebih selektif)
    MIN_TIME_BETWEEN_TRADES: 180000,               // Naikkan dari 2 menit ke 3 menit

    // === API PARAMETERS ===
    TRADE_HISTORY_SYNC_INTERVAL: 300000,           // Naikkan dari 60 detik ke 5 menit
    RECV_WINDOW: 5000,                             // Standar

    // === MULTI-TIMEFRAME ANALYSIS (OPTIMAL) ===
    TIMEFRAMES: [5, 15, 60],                       // Bagus, 3 timeframe
    TIMEFRAME_WEIGHTS: {
        '5m': 0.15,                                 // Turunkan dari 0.2 ke 0.15 (lebih percaya trend besar)
        '15m': 0.25,                                // Turunkan dari 0.3 ke 0.25
        '60m': 0.60                                 // Naikkan dari 0.5 ke 0.60 (prioritas trend utama)
    },
    MIN_TF_CONSENSUS: 0.65,                         // Naikkan dari 0.6 ke 0.65 (konsensus lebih kuat)
    USE_MULTI_TIMEFRAME: true,

    // === ENHANCED MULTI-TF SETTINGS (LEBIH SELEKTIF) ===
    TF_BONUS_BULLISH: 2.5,                          // Naikkan dari 2.0 ke 2.5 (bonus lebih besar)
    TF_BONUS_SIDEWAYS: 0.8,                         // Turunkan dari 0.5 ke 0.3 (sideways kurang bagus)
    TF_PENALTY_BEARISH: -0.5,                       // Turunkan dari -1.0 ke -1.5 (penalti lebih berat)
    TF_MIN_STRENGTH: 0.4,                           // Naikkan dari 0.3 ke 0.4 (minimal kekuatan lebih tinggi)
};
/* ======================================================
   BLACKLIST & WHITELIST MANAGEMENT
====================================================== */

const BLACKLIST = new Set([
    "btc", "eth", "usdc", "busd", "dai",
    "wbtc", "weth", "xaut", "tusd", "usdp", "usdd", "ust",
    "eurs", "ceur", "idk", "bsc", "matic", "ada"
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
    isTradingEnabled: true, // Pindahkan ke sini    

    // Stats untuk multi-timeframe
    multiTFStats: {
        totalChecks: 0,
        approved: 0,
        rejected: 0,
        lastUpdate: 0
    }
};



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

/* ======================================================
   TRADE HISTORY SYNC - PERBAIKAN DAILY LOSS
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

            await sleep(2000);
        }

        const today = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        let dailyPL = 0;
        let tradeCount = 0;

        allTrades.forEach(trade => {
            if (trade.trade_time >= today) {
                // ===== VALIDASI DATA =====
                const price = Number(trade.price);
                const qtyKey = Object.keys(trade)[3]; // Ambil key untuk quantity
                const qty = Number(trade[qtyKey]);
                const fee = Number(trade.fee || 0);

                // Skip jika data tidak valid
                if (isNaN(price) || isNaN(qty) || price <= 0 || qty <= 0) {
                    console.log(`⚠️ Data trade tidak valid:`, trade);
                    return;
                }

                const tradeValue = price * qty;

                // Validasi tradeValue masuk akal (misal tidak lebih dari 1 Milyar)// Hitung rata-rata trade value dari history
                const avgTradeValue = allTrades.reduce((sum, t) => sum + (Number(t.price) * Number(t[Object.keys(t)[3]])), 0) / allTrades.length;
                const MAX_REASONABLE_VALUE = avgTradeValue * 10; // 10x dari rata-rata

                if (tradeValue > MAX_REASONABLE_VALUE) {
                    console.log(`⚠️ Trade value terlalu besar: ${tradeValue}, skip`);
                    return;
                }

                // Hitung P&L
                let pl = 0;
                if (trade.type === 'sell') {
                    pl = tradeValue - fee;
                } else {
                    pl = -fee; // Buy hanya kena fee
                }

                dailyPL += pl;
                tradeCount++;
            }
        });

        // ===== VALIDASI DAILY PL =====
        // Pastikan dailyPL tidak melebihi batas wajar (misal 2x equity)
        const MAX_REASONABLE_LOSS = state.equityNow * 2;

        if (Math.abs(dailyPL) > MAX_REASONABLE_LOSS) {
            console.log(`⚠️ Daily PL tidak wajar: Rp ${formatIDR(dailyPL)}`);
            console.log(`   Equity saat ini: Rp ${formatIDR(state.equityNow)}`);
            console.log(`   Trade count: ${tradeCount}`);
            console.log(`   ⚠️ RESET ke 0 karena kemungkinan error data`);
            dailyPL = 0;
        }

        // Validasi tambahan: jika dailyPL > equity, kemungkinan error
        if (Math.abs(dailyPL) > state.equityNow) {
            console.log(`⚠️ Daily PL (${formatIDR(Math.abs(dailyPL))}) > equity (${formatIDR(state.equityNow)})`);
            console.log(`   ⚠️ Menggunakan nilai yang lebih kecil`);
            dailyPL = Math.min(Math.abs(dailyPL), state.equityNow) * (dailyPL >= 0 ? 1 : -1);
        }

        // Pastikan dailyLoss tidak negatif (harus absolute)
        const newDailyLoss = Math.abs(dailyPL);

        // Validasi final: pastikan tidak ada angka aneh
        if (isNaN(newDailyLoss) || !isFinite(newDailyLoss) || newDailyLoss < 0) {
            console.log(`❌ Daily loss tidak valid, reset ke 0`);
            state.dailyLoss = 0;
        } else {
            state.dailyLoss = newDailyLoss;
        }

        console.log(`📊 Daily P&L: Rp ${formatIDR(dailyPL)} (${tradeCount} trades)`);
        console.log(`📊 Daily Loss tersimpan: Rp ${formatIDR(state.dailyLoss)}`);

    } catch (e) {
        console.log("❌ Trade history sync error:", e.message);

        // Jika error, set dailyLoss ke 0 untuk keamanan
        state.dailyLoss = 0;
    }
}
/* ======================================================
   PLACE ORDER
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
   EXECUTE BUY
====================================================== */

async function executeBuy(pair, price, analysis) {
    if (isBuying) return;
    isBuying = true;

    try {
        await getAccountInfo();

        const MIN_ORDER_INDODAX = 15000;
        const SAFE_BUFFER = 1.05;

        const MIN_ORDER_ESTIMATE = {
            'pepe_idr': 15000,
            'jellyjelly_idr': 15000,
            'fartcoin_idr': 15000,
            'pengu_idr': 15000,
            'pippin_idr': 15000,
            'default': 15000
        };

        const cachedMinOrder = state.minOrderCache?.[pair];
        const minOrderForPair = cachedMinOrder || MIN_ORDER_ESTIMATE[pair] || MIN_ORDER_ESTIMATE.default;

        if (cachedMinOrder) {
            console.log(`📦 Menggunakan cached minimal order: Rp ${formatIDR(cachedMinOrder)} untuk ${pair}`);
        }

        const tradingBalance = Math.floor(state.equityNow * 0.95);
        const holdBalance = state.equityNow - tradingBalance;
        const openSlots = CONFIG.MAX_POSITIONS - Object.keys(state.positions).length;

        if (openSlots <= 0) {
            console.log(`[SKIP] Slot penuh, tidak bisa membeli ${pair}`);
            return;
        }

        console.log(`\n💰 ANALISIS MODAL:`);
        console.log(`   Total Balance  : Rp ${formatIDR(state.equityNow)}`);
        console.log(`   Trading Balance: Rp ${formatIDR(tradingBalance)}`);
        console.log(`   Slot tersisa   : ${openSlots}`);
        console.log(`   Minimal order  : Rp ${formatIDR(minOrderForPair)} untuk ${pair}`);

        let spend = 0;
        let strategy = "";

        const spendPerSlot = Math.floor(tradingBalance / CONFIG.MAX_POSITIONS);

        if (spendPerSlot >= minOrderForPair) {
            spend = spendPerSlot;
            strategy = `Bagi rata (${CONFIG.MAX_POSITIONS} slot)`;
        }
        else if (tradingBalance >= minOrderForPair * SAFE_BUFFER) {
            spend = Math.floor(tradingBalance);
            strategy = `Konsentrasi 1 posisi (sisa slot ${openSlots - 1} kosong)`;
        }
        else if (tradingBalance >= minOrderForPair) {
            spend = minOrderForPair;
            strategy = `Minimal order (sisa untuk fee)`;
        }
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

        const buyPrice = Math.ceil(price * 1.005);
        const res = await placeOrder(pair, 'buy', buyPrice, spend, true);

        if (res.success) {
            const targetPrice = price * (1 + CONFIG.TP_PERCENT / 100);
            const stopPrice = price * (1 - CONFIG.SL_PERCENT / 100);

            // Di executeBuy, saat menyimpan posisi
            state.positions[pair] = {
                entry: price,
                high: price,
                target: targetPrice,
                stop: stopPrice,           // ← Simpan initial stop
                currentStop: stopPrice,     // ← Tambahkan field untuk trailing stop
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
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔹 <b>Pair</b>       : ${pair.toUpperCase()}\n` +
                `🔹 <b>Price</b>      : Rp ${formatIDR(price)}\n` +
                `🔹 <b>Modal</b>      : Rp ${formatIDR(spend)}\n` +
                `🔹 <b>Strategi</b>   : ${strategy}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🎯 <b>Target</b>     : Rp ${formatIDR(targetPrice)} (${CONFIG.TP_PERCENT}%)\n` +
                `🛑 <b>Stop</b>       : Rp ${formatIDR(stopPrice)} (${CONFIG.SL_PERCENT}%)\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 <b>Sisa Saldo</b> : Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, "TRADE");
            console.log(`✅ BERHASIL membeli ${pair} di harga ${price}`);

        } else {
            console.log(`❌ GAGAL membeli ${pair}: ${res.error}`);

            if (res.error && res.error.includes("minimum")) {
                await updateMinOrderFromError(pair, res.error);
                console.log(`💡 Saran: Coba lagi nanti dengan modal lebih besar atau beli koin lain`);
            }
        }

    } catch (e) {
        console.log("❌ ERROR di executeBuy:", e.message);
    } finally {
        isBuying = false;
    }
}

/* ======================================================
   UPDATE MIN ORDER FROM ERROR
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
            var amount = pos.size / pos.entry;
        } else {
            const balance = auth.data.balance || {};
            const coin = pair.split('_')[0];
            amount = Number(balance[coin] || 0);

            console.log(`💰 Saldo ${coin} dari API: ${amount}`);

            if (amount <= 0) {
                console.log(`⚠️ ${coin} sudah tidak ada (0), menghapus posisi`);
                delete state.positions[pair];
                saveState();
                return;
            }
        }

        const coin = pair.split('_')[0];
        const integerCoins = ['pippin', 'pepe', 'jellyjelly', 'fartcoin', 'pengu', 'hype', 'doge', 'shib'];
        const isIntegerCoin = integerCoins.includes(coin);

        // ===== CETAK INFORMASI MINIMAL ORDER =====
        console.log(`\n🔍 INFORMASI MINIMAL ORDER:`);

        // Coba dapatkan minimal order dari cache atau error sebelumnya
        let minOrder = state.minOrderCache?.[pair] || 0;
        console.log(`   Minimal order dari cache: ${minOrder} ${coin}`);

        // Jika tidak ada di cache, coba dapatkan dari ticker
        if (minOrder === 0) {
            try {
                const response = await axios.get(`https://indodax.com/api/${pair}/depth`);
                if (response.data?.sell?.length > 0) {
                    // Estimasi minimal order dari order book
                    const firstSell = response.data.sell[0];
                    minOrder = Number(firstSell[1]) * 0.1; // Estimasi kasar
                    console.log(`   Estimasi dari order book: ${minOrder} ${coin}`);
                }
            } catch (e) {
                console.log(`   Gagal ambil order book: ${e.message}`);
            }
        }

        // ===== JUAL SEMUA KOIN (SELL ALL) =====
        console.log(`\n🔵 SELL ALL ${coin}: ${amount}`);

        // Format amount untuk jual semua
        let sellAmount;
        if (isIntegerCoin) {
            // Untuk integer coin: floor ke bawah (jual semua yang bisa dijual)
            sellAmount = Math.floor(amount);
            console.log(`   Integer coin: ${sellAmount} dari ${amount} (sisa ${amount - sellAmount})`);
        } else {
            // Untuk desimal coin: 8 desimal
            sellAmount = Number(amount.toFixed(8));
        }

        // Validasi minimal order
        if (sellAmount < minOrder && minOrder > 0) {
            console.log(`⚠️ Amount jual (${sellAmount}) di bawah minimal order (${minOrder})`);

            // Coba jual dengan amount minimal
            if (amount >= minOrder) {
                console.log(`🔄 Mencoba jual dengan minimal order: ${minOrder}`);
                sellAmount = minOrder;
            } else {
                console.log(`❌ Tidak bisa jual: saldo ${amount} < minimal order ${minOrder}`);

                // Simpan ke state untuk cleanup nanti (tapi tidak bisa dijual)
                console.log(`   Sisa akan dibiarkan karena tidak mencapai minimal order`);
                return;
            }
        }

        if (sellAmount <= 0) {
            console.log(`❌ Amount jual tidak valid: ${sellAmount}`);
            return;
        }

        const sellPrice = Math.floor(price * 0.998);
        console.log(`🔵 Menjual ${sellAmount} ${coin} @ ${sellPrice}`);

        const res = await placeOrder(pair, 'sell', sellPrice, sellAmount, false);

        if (res.success) {
            console.log(`✅ SELL ALL berhasil: ${sellAmount} ${coin}`);

            // Cek apakah masih ada sisa
            await sleep(2000);
            await getAccountInfo();

            const auth2 = await privateRequest('getInfo');
            if (auth2.success) {
                const remaining = Number(auth2.data.balance[coin] || 0);
                if (remaining > 0) {
                    console.log(`⚠️ Masih ada sisa ${remaining} ${coin} (mungkin karena fee atau pembulatan)`);

                    // Jika sisa masih di atas minimal order, jual lagi
                    if (remaining >= minOrder) {
                        console.log(`🔄 Mencoba jual sisa lagi...`);
                        let remainingAmount;
                        if (isIntegerCoin) {
                            remainingAmount = Math.floor(remaining);
                        } else {
                            remainingAmount = Number(remaining.toFixed(8));
                        }

                        const res2 = await placeOrder(pair, 'sell', sellPrice, remainingAmount, false);
                        if (res2.success) {
                            console.log(`✅ Sisa berhasil dijual: ${remainingAmount}`);
                        }
                    } else {
                        console.log(`⏭️ Sisa ${remaining} dibiarkan (di bawah minimal order)`);
                    }
                }
            }

            // ===== HITUNG PROFIT =====
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

            // ===== NOTIFIKASI TELEGRAM =====
            const emoji = grossPnlPercent >= 0 ? "💰" : "📉";
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

            const msg = `${emoji} <b>POSITION CLOSED</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🏷️ <b>Pair</b>        : ${pair.toUpperCase()}\n` +
                `📥 <b>Entry</b>       : Rp ${formatIDR(pos.entry)}\n` +
                `📤 <b>Exit</b>        : Rp ${formatIDR(price)}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Result</b>      : ${formatPercent(grossPnlPercent)}\n` +
                `💰 <b>P&L</b>         : ${pnlFormatted}\n` +
                `${reasonIcon} <b>Reason</b>      : ${reason}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💎 <b>New Balance</b>  : Rp ${formatIDR(state.equityNow)}`;

            await tg(msg, grossPnlPercent >= 0 ? "SUCCESS" : "WARNING");
            console.log(`✅ [SELL] ${pair} @ ${formatIDR(price)} | P&L: ${formatPercent(grossPnlPercent)}`);

        } else {
            console.log(`❌ Gagal menjual: ${res.error}`);

            // ===== HANDLE ERROR MINIMAL ORDER =====
            if (res.error?.includes("Minimum order") || res.error?.includes("minimum")) {
                const match = res.error.match(/Minimum order ([\d.]+)/);
                if (match && match[1]) {
                    const minOrderFromError = Number(match[1]);
                    console.log(`📊 Mendapat minimal order dari error: ${minOrderFromError} ${coin}`);

                    // Simpan ke cache
                    if (!state.minOrderCache) state.minOrderCache = {};
                    state.minOrderCache[pair] = minOrderFromError;
                    saveState();

                    // Coba jual dengan minimal order yang benar
                    if (amount >= minOrderFromError) {
                        console.log(`🔄 Mencoba ulang dengan minimal order: ${minOrderFromError}`);

                        // Format amount sesuai minimal order
                        let retryAmount;
                        if (isIntegerCoin) {
                            retryAmount = Math.floor(minOrderFromError);
                        } else {
                            retryAmount = Number(minOrderFromError.toFixed(8));
                        }

                        const res2 = await placeOrder(pair, 'sell', sellPrice, retryAmount, false);

                        if (res2.success) {
                            console.log(`✅ Berhasil jual dengan minimal order!`);

                            // Proses sukses (hapus posisi, notifikasi, dll)
                            delete state.positions[pair];
                            state.cooldown[pair] = Date.now();
                            saveState();

                            await tg(`⚠️ Fallback sell ${pair} berhasil dengan minimal order ${retryAmount}`, "WARNING");
                            return;
                        }
                    } else {
                        console.log(`❌ Saldo ${amount} < minimal order ${minOrderFromError}, tidak bisa jual`);
                    }
                }
            }

            // ===== FALLBACK: COBA DENGAN VARIASI AMOUNT =====
            if (res.error && (res.error.includes("decimal") || res.error.includes("minimum"))) {
                console.log(`🔄 Mencoba fallback dengan amount berbeda...`);

                // Coba berbagai variasi amount
                const variations = [
                    Math.floor(amount * 1000) / 1000,      // 3 desimal
                    Math.floor(amount * 100) / 100,        // 2 desimal
                    Math.floor(amount),                    // Integer
                ];

                for (const varAmount of variations) {
                    if (varAmount <= 0) continue;

                    console.log(`🔄 Mencoba dengan amount: ${varAmount}`);
                    const res2 = await placeOrder(pair, 'sell', sellPrice, varAmount, false);

                    if (res2.success) {
                        console.log(`✅ Fallback berhasil dengan amount ${varAmount}!`);

                        // Proses sukses
                        delete state.positions[pair];
                        state.cooldown[pair] = Date.now();
                        saveState();
                        await getAccountInfo();
                        await tg(`⚠️ Fallback sell ${pair} berhasil dengan amount ${varAmount}`, "WARNING");
                        return;
                    }

                    await sleep(2000);
                }
            }
        }

    } catch (e) {
        console.log("❌ ExecuteSell Error:", e.message);
    }
}


async function cleanupRemainingCoins() {
    try {
        console.log("\n🧹 Membersihkan sisa koin...");

        const auth = await privateRequest('getInfo');
        if (!auth.success) return;

        const balance = auth.data.balance || {};
        const integerCoins = ['pippin', 'pepe', 'jellyjelly', 'fartcoin', 'pengu', 'hype', 'doge', 'shib'];

        let cleanedCount = 0;
        let totalValue = 0;

        for (const [coin, amount] of Object.entries(balance)) {
            if (coin === 'idr' || coin === 'usdt') continue;

            const coinAmount = Number(amount);
            if (isNaN(coinAmount) || coinAmount <= 0) continue;

            const pair = `${coin}_idr`;

            // Skip jika sedang dalam posisi trading
            if (state.positions[pair]) {
                console.log(`⏭️ Skip ${coin} - sedang dalam posisi trading`);
                continue;
            }

            // Cek minimal order dari cache
            const minOrder = state.minOrderCache?.[pair] || 0;

            // Threshold minimal untuk dijual (gunakan yang lebih besar antara minOrder atau threshold default)
            const defaultMin = integerCoins.includes(coin) ? 1 : 0.0001;
            const requiredAmount = Math.max(minOrder, defaultMin);

            if (coinAmount >= requiredAmount) {
                console.log(`\n🔍 Ditemukan sisa ${coin}: ${coinAmount} (min order: ${requiredAmount})`);

                // ===== AMBIL HARGA TERBARU =====
                let price = 0;
                try {
                    const response = await axios.get(PUBLIC_URL);
                    const ticker = response.data.tickers?.[pair];
                    if (ticker) {
                        price = Number(ticker.last || 0);
                        console.log(`   Harga ${coin}: Rp ${formatIDR(price)}`);
                    } else {
                        console.log(`   ⚠️ Harga ${pair} tidak ditemukan, skip`);
                        continue;
                    }
                } catch (e) {
                    console.log(`   ❌ Gagal ambil harga ${coin}: ${e.message}`);
                    continue;
                }

                if (price <= 0) {
                    console.log(`   ⚠️ Harga ${coin} invalid, skip`);
                    continue;
                }

                // ===== FORMAT AMOUNT UNTUK DIJUAL =====
                let sellAmount;
                if (integerCoins.includes(coin)) {
                    // Untuk integer coin: bulatkan ke bawah
                    sellAmount = Math.floor(coinAmount);
                    // Jika setelah dibulatkan jadi 0 tapi aslinya >=1, set ke 1
                    if (sellAmount < 1 && coinAmount >= 1) sellAmount = 1;
                    console.log(`   Format integer: ${sellAmount} ${coin}`);
                } else {
                    // Untuk desimal coin: 8 desimal
                    sellAmount = Number(coinAmount.toFixed(8));
                    console.log(`   Format desimal: ${sellAmount} ${coin}`);
                }

                // Validasi amount
                if (sellAmount <= 0) {
                    console.log(`   ⚠️ Amount terlalu kecil: ${sellAmount}, skip`);
                    continue;
                }

                // ===== EKSEKUSI ORDER JUAL =====
                const sellPrice = Math.floor(price * 0.998); // Diskon 0.2%
                console.log(`   🔄 Mencoba jual sisa ${sellAmount} ${coin} @ ${sellPrice}`);

                const res = await placeOrder(pair, 'sell', sellPrice, sellAmount, false);

                if (res.success) {
                    console.log(`   ✅ Berhasil jual sisa ${coin}: ${sellAmount}`);
                    cleanedCount++;

                    // Estimasi nilai dalam IDR
                    const valueInIdr = sellAmount * sellPrice;
                    totalValue += valueInIdr;

                    // Kirim notifikasi Telegram (tidak spam, cukup 1 notifikasi per batch)
                    if (cleanedCount === 1) {
                        // Notifikasi akan dikirim di akhir
                    }

                    // Cek apakah masih ada sisa setelah jual
                    await sleep(2000);
                    const auth2 = await privateRequest('getInfo');
                    if (auth2.success) {
                        const remaining = Number(auth2.data.balance[coin] || 0);
                        if (remaining > 0) {
                            console.log(`   ⚠️ Masih ada sisa ${remaining} ${coin} setelah jual`);

                            // Jika sisa masih di atas minimal order, coba jual lagi
                            if (remaining >= requiredAmount) {
                                console.log(`   🔄 Mencoba jual sisa lagi...`);
                                let remainingAmount;
                                if (integerCoins.includes(coin)) {
                                    remainingAmount = Math.floor(remaining);
                                } else {
                                    remainingAmount = Number(remaining.toFixed(8));
                                }

                                const res2 = await placeOrder(pair, 'sell', sellPrice, remainingAmount, false);
                                if (res2.success) {
                                    console.log(`   ✅ Sisa berhasil dijual: ${remainingAmount}`);
                                }
                            }
                        }
                    }

                } else {
                    console.log(`   ❌ Gagal jual sisa ${coin}: ${res.error}`);

                    // ===== HANDLE ERROR MINIMAL ORDER =====
                    if (res.error?.includes("Minimum order") || res.error?.includes("minimum")) {
                        const match = res.error.match(/Minimum order ([\d.]+)/);
                        if (match && match[1]) {
                            const minOrderFromError = Number(match[1]);
                            console.log(`   📊 Mendapat minimal order dari error: ${minOrderFromError} ${coin}`);

                            // Simpan ke cache
                            if (!state.minOrderCache) state.minOrderCache = {};
                            state.minOrderCache[pair] = minOrderFromError;
                            saveState();

                            // Coba jual dengan minimal order yang benar
                            if (coinAmount >= minOrderFromError) {
                                console.log(`   🔄 Mencoba ulang dengan minimal order: ${minOrderFromError}`);

                                let retryAmount;
                                if (integerCoins.includes(coin)) {
                                    retryAmount = Math.floor(minOrderFromError);
                                } else {
                                    retryAmount = Number(minOrderFromError.toFixed(8));
                                }

                                const res2 = await placeOrder(pair, 'sell', sellPrice, retryAmount, false);
                                if (res2.success) {
                                    console.log(`   ✅ Berhasil jual dengan minimal order!`);
                                    cleanedCount++;
                                }
                            }
                        }
                    }

                    // ===== FALLBACK: COBA DENGAN VARIASI AMOUNT =====
                    else if (res.error?.includes("decimal")) {
                        console.log(`   🔄 Mencoba fallback dengan amount berbeda...`);

                        // Coba berbagai variasi amount
                        const variations = [
                            Math.floor(coinAmount * 1000) / 1000,      // 3 desimal
                            Math.floor(coinAmount * 100) / 100,        // 2 desimal
                            Math.floor(coinAmount),                    // Integer
                        ];

                        for (const varAmount of variations) {
                            if (varAmount <= 0) continue;

                            console.log(`   🔄 Mencoba dengan amount: ${varAmount}`);
                            const res2 = await placeOrder(pair, 'sell', sellPrice, varAmount, false);

                            if (res2.success) {
                                console.log(`   ✅ Fallback berhasil dengan amount ${varAmount}!`);
                                cleanedCount++;
                                break;
                            }

                            await sleep(2000);
                        }
                    }
                }

                // Delay antar koin
                await sleep(2000);

            } else {
                console.log(`⏭️ Skip ${coin}: ${coinAmount} < minimal order ${requiredAmount}`);
            }
        }

        // ===== RINGKASAN CLEANUP =====
        if (cleanedCount > 0) {
            console.log(`\n📊 RINGKASAN CLEANUP:`);
            console.log(`   ✅ Berhasil menjual ${cleanedCount} koin sisa`);
            console.log(`   💰 Total nilai: Rp ${formatIDR(totalValue)}`);

            // Kirim notifikasi Telegram (satu ringkasan)
            await tg(
                `💰 <b>Cleanup Selesai</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `✅ Terjual: ${cleanedCount} koin\n` +
                `💎 Total: Rp ${formatIDR(totalValue)}\n` +
                `━━━━━━━━━━━━━━━━━━`,
                "INFO"
            );
        } else {
            console.log("\n✅ Tidak ada koin sisa yang perlu dibersihkan");
        }

    } catch (e) {
        console.log("❌ Cleanup error:", e.message);
    }
}


async function updateAllMinOrders() {
    console.log("\n📊 Mengupdate minimal order semua koin...");

    try {
        const response = await axios.get(PUBLIC_URL);
        const tickers = response.data.tickers || {};

        if (!state.minOrderCache) state.minOrderCache = {};

        for (const pair of Object.keys(tickers)) {
            if (!pair.endsWith("_idr")) continue;

            // Coba dapatkan minimal order dengan order kecil
            const testAmount = 10000; // Rp 10.000
            const testPrice = 1000;

            // Simulasi order kecil untuk dapatkan error
            const res = await placeOrder(pair, 'buy', testPrice, testAmount, true);

            if (!res.success && res.error?.includes("Minimum order")) {
                const match = res.error.match(/Minimum order ([\d.]+)/);
                if (match && match[1]) {
                    const minOrder = Number(match[1]);
                    state.minOrderCache[pair] = minOrder;
                    console.log(`   ${pair}: ${minOrder} ${pair.split('_')[0]}`);
                }
            }

            await sleep(2000); // Hindari rate limit
        }

        saveState();
        console.log("✅ Minimal order cache updated");

    } catch (e) {
        console.log("❌ Gagal update minimal order:", e.message);
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

        // ===== PERBAIKAN TRAILING STOP =====
        // Inisialisasi currentStop jika belum ada
        if (!pos.currentStop) {
            state.positions[pair].currentStop = pos.stop;
        }

        let stopPrice = pos.currentStop; // Gunakan stop terakhir yang tersimpan

        // Hitung trailing stop baru jika sudah waktunya
        if (profitPercent >= CONFIG.TRAILING_ACTIVATION) {
            const newTrailingStop = (pos.high || currentPrice) * (1 - CONFIG.TRAILING_GAP / 100);

            // Trailing stop hanya boleh NAIK, tidak boleh turun
            if (newTrailingStop > stopPrice) {
                stopPrice = newTrailingStop;
                state.positions[pair].currentStop = stopPrice; // Simpan yang baru
                console.log(`📈 Trailing stop ${pair} naik: ${formatIDR(stopPrice)}`);
                saveState();
            }
        }

        // ===== DEBUG =====
        console.log(`\n🔍 CHECKING ${pair}:`);
        console.log(`   Current: ${currentPrice}`);
        console.log(`   Entry: ${pos.entry}`);
        console.log(`   Profit: ${profitPercent.toFixed(2)}%`);
        console.log(`   Stop: ${formatIDR(stopPrice)}`);
        console.log(`   Target: ${formatIDR(targetPrice)}`);

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
async function initializeComponents() {
    console.log("\n🔧 Starting component initialization...");

    // Step 1: Technical Indicators
    console.log("📦 Step 1: Initializing Technical Indicators...");
    try {
        technicalIndicators = new TechnicalIndicators();
        console.log("   ✅ Technical Indicators created");
        console.log("   📊 Methods available:",
            Object.getOwnPropertyNames(Object.getPrototypeOf(technicalIndicators))
                .filter(name => name !== 'constructor')
        );
    } catch (e) {
        console.log("   ❌ Failed to create TechnicalIndicators:", e.message);
        throw e;
    }

    // Step 2: Multi-Timeframe Analyzer
    console.log("⏱️ Step 2: Initializing Multi-Timeframe Analyzer...");
    try {
        multiTFAnalyzer = new MultiTimeframeAnalyzer(CONFIG, technicalIndicators, state);
        console.log("   ✅ Multi-Timeframe Analyzer created");
    } catch (e) {
        console.log("   ❌ Failed to create MultiTimeframeAnalyzer:", e.message);
        throw e;
    }

    // Step 3: Market Analyzer
    console.log("📊 Step 3: Initializing Market Analyzer...");
    try {
        analyzer = new MarketAnalyzer(state, CONFIG, technicalIndicators);
        console.log("   ✅ Market Analyzer created");
    } catch (e) {
        console.log("   ❌ Failed to create MarketAnalyzer:", e.message);
        throw e;
    }

    // Step 4: Risk Manager
    console.log("🛡️ Step 4: Initializing Risk Manager...");
    try {
        riskManager = new RiskManager(state, CONFIG);
        console.log("   ✅ Risk Manager created");
    } catch (e) {
        console.log("   ❌ Failed to create RiskManager:", e.message);
        throw e;
    }

    // Final verification
    console.log("\n🔍 Final Component Verification:");
    console.log("   - technicalIndicators:", technicalIndicators ? "✅" : "❌");
    console.log("   - multiTFAnalyzer:", multiTFAnalyzer ? "✅" : "❌");
    console.log("   - analyzer:", analyzer ? "✅" : "❌");
    console.log("   - riskManager:", riskManager ? "✅" : "❌");

    componentsInitialized = true;
    console.log("🎯 All components initialized successfully\n");
}

async function handleTelegramCommands() {
    // Cek apakah variabel telegram sudah didefinisikan
    if (typeof isTelegramActive === 'undefined') {
        console.log("⚠️ isTelegramActive undefined, initializing...");
        isTelegramActive = true;
    }

    if (typeof lastUpdateId === 'undefined') {
        console.log("⚠️ lastUpdateId undefined, initializing...");
        lastUpdateId = 0;
    }

    if (typeof telegramRetryCount === 'undefined') {
        console.log("⚠️ telegramRetryCount undefined, initializing...");
        telegramRetryCount = 0;
    }

    if (!TELEGRAM_BOT_TOKEN) {
        // console.log("📱 Telegram disabled: no token");
        return;
    }

    if (!isTelegramActive) {
        // console.log("📱 Telegram inactive");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;

        const response = await axios.get(url).catch(err => {
            if (err.response?.status === 409) {
                console.log("📱 Telegram conflict - another bot instance detected!");
                console.log("   ℹ️ Bot akan tetap berjalan tanpa notifikasi Telegram");
                isTelegramActive = false;
                return { data: { ok: false } };
            }
            throw err;
        });

        if (response.data?.ok && response.data.result.length > 0) {
            for (const update of response.data.result) {
                lastUpdateId = update.update_id;

                const chatId = update.message?.chat?.id;
                const text = update.message?.text;

                if (chatId && chatId.toString() === TELEGRAM_CHAT_ID?.toString() && text) {
                    console.log(`📱 Received command: ${text}`);
                    await processTelegramCommand(chatId, text);
                }
            }
        }

        telegramRetryCount = 0;

    } catch (e) {
        if (e.response?.status === 409) {
            console.log("📱 Telegram conflict - another bot instance?");
            isTelegramActive = false;
        } else {
            console.log("📱 Telegram command error:", e.message);

            telegramRetryCount++;
            if (telegramRetryCount > 5) {
                console.log("   ⚠️ Too many Telegram errors, disabling...");
                isTelegramActive = false;
            }
        }
    }
}


async function processTelegramCommand(chatId, command) {
    let response = "";
    const cmd = command.toLowerCase().split(' ')[0];

    switch (cmd) {
        case '/start':
            response = `🤖 <b>TRADING BOT v5.0</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `✅ <b>Bot aktif dan siap digunakan!</b>\n\n` +
                `📌 <b>Fitur Utama:</b>\n` +
                `• Multi-Timeframe Analysis (5/15/60m)\n` +
                `• Risk Management (Daily Loss, Drawdown)\n` +
                `• Trailing Stop Otomatis\n` +
                `• Telegram Command Control\n\n` +
                `📋 <b>Perintah Dasar:</b>\n` +
                `• /status - Dashboard lengkap\n` +
                `• /balance - Info saldo & drawdown\n` +
                `• /positions - Detail posisi aktif\n` +
                `• /daily - Info daily loss\n\n` +
                `🔧 <b>Pengaturan:</b>\n` +
                `• /enable - Aktifkan trading\n` +
                `• /disable - Nonaktifkan trading\n\n` +
                `📊 <b>Analisis:</b>\n` +
                `• /tf [pair] - Multi-timeframe analysis\n\n` +
                `🔄 <b>Reset:</b>\n` +
                `• /resetpeak confirm - Reset peak equity\n` +
                `• /resetdaily confirm - Reset daily loss\n\n` +
                `🤖 <b>Bot Control:</b>\n` +
                `• /statusbot - Status PM2 bot\n` +
                `• /restart confirm - Restart bot\n` +
                `• /logs [n] - Lihat n log terakhir\n\n` +
                `❓ <b>Bantuan:</b>\n` +
                `• /help - Tampilkan semua perintah\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            break;

        case '/help':
            response = `📋 <b>DAFTAR LENGKAP PERINTAH</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

                `📊 <b>INFORMASI & DASHBOARD</b>\n` +
                `/status - Dashboard lengkap\n` +
                `/balance - Info saldo, peak equity, drawdown\n` +
                `/positions - Detail semua posisi aktif\n` +
                `/daily - Info daily loss hari ini\n` +
                `/drawdown - Info drawdown detail\n` +
                `/tf [pair] - Analisis multi-timeframe\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

                `⚙️ <b>PENGATURAN TRADING</b>\n` +
                `/enable - Aktifkan trading (buka posisi baru)\n` +
                `/disable - Nonaktifkan trading (hanya monitor)\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

                `🔄 <b>RESET & MAINTENANCE</b>\n` +
                `/resetpeak confirm - Reset peak equity ke balance saat ini\n` +
                `/resetdaily confirm - Reset daily loss ke 0\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

                `🤖 <b>BOT CONTROL (PM2)</b>\n` +
                `/statusbot - Cek status bot (online/offline, CPU, RAM)\n` +
                `/restart confirm - Restart bot (offline beberapa detik)\n` +
                `/logs [n] - Lihat n log terakhir (default 20)\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

                `❓ <b>BANTUAN</b>\n` +
                `/start - Tampilkan menu utama\n` +
                `/help - Tampilkan daftar perintah ini\n` +
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
                        positionsText += `\n${arrow} <b>${pair.toUpperCase()}</b>: ${pnl}%\n   Live: Rp ${formatIDR(currentPrice)}\n   Target: Rp ${formatIDR(pos.target)}\n   Stop: Rp ${formatIDR(pos.currentStop)}`;
                    }
                }

                response = `📊 <b>LIVE DASHBOARD</b>\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `💰 Balance: Rp ${formatIDR(state.equityNow)}\n` +
                    `📉 Drawdown: ${state.currentDrawdown.toFixed(2)}%\n` +
                    `📊 Daily Loss: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n` +
                    `📈 Market: ${state.sentiment} | ${state.marketRegime}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `<b>POSISI (${Object.keys(state.positions).length}/${CONFIG.MAX_POSITIONS}):</b>\n${positionsText}\n` +
                    `━━━━━━━━━━━━━━━━━━`;
            } catch (e) {
                response = `❌ Gagal mengambil data market: ${e.message}`;
            }
            break;

        case '/balance':
            response = `💰 <b>INFORMASI SALDO</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `Balance IDR: Rp ${formatIDR(state.equityNow)}\n` +
                `Peak Equity: Rp ${formatIDR(state.peakEquity)}\n` +
                `Drawdown: ${state.currentDrawdown.toFixed(2)}%\n` +
                `Daily Loss: Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n` +
                `━━━━━━━━━━━━━━━━━━`;
            break;

        case '/positions':
            if (Object.keys(state.positions).length === 0) {
                response = `📭 <b>POSISI AKTIF</b>\━━━━━━━━━━━━━━━━━━\nTidak ada posisi terbuka.`;
            } else {
                let posText = "";
                for (const [pair, pos] of Object.entries(state.positions)) {
                    posText += `\n🔹 <b>${pair.toUpperCase()}</b>\n` +
                        `   Entry: Rp ${formatIDR(pos.entry)}\n` +
                        `   Target: Rp ${formatIDR(pos.target)}\n` +
                        `   Stop: Rp ${formatIDR(pos.stop)}\n` +
                        `   Current Stop: Rp ${formatIDR(pos.currentStop)}\n`;
                }
                response = `📌 <b>POSISI AKTIF (${Object.keys(state.positions).length})</b>\━━━━━━━━━━━━━━━━━━${posText}\n━━━━━━━━━━━━━━━━━━━━━━`;
            }
            break;

        case '/daily':
            const dailyLossPercent = (state.dailyLoss / state.equityNow * 100) || 0;
            const remainingLoss = CONFIG.MAX_DAILY_LOSS * state.equityNow / 100 - state.dailyLoss;

            response = `📊 <b>DAILY LOSS INFO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 Current Balance: Rp ${formatIDR(state.equityNow)}\n` +
                `📉 Daily Loss: Rp ${formatIDR(state.dailyLoss)}\n` +
                `📊 Daily Trades: ${state.dailyTrades}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🎯 Batas Maksimal: ${CONFIG.MAX_DAILY_LOSS}%\n` +
                `📈 Persentase: ${dailyLossPercent.toFixed(2)}%\n` +
                `✅ Sisa Aman: Rp ${formatIDR(Math.max(0, remainingLoss))}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔄 Reset dengan: /resetdaily confirm`;
            break;

        case '/enable':
            state.isTradingEnabled = true;
            saveState();
            response = `✅ <b>Trading ENABLED</b>\nBot akan mulai membuka posisi baru.`;
            break;

        case '/disable':
            state.isTradingEnabled = false;
            saveState();
            response = `⚠️ <b>Trading DISABLED</b>\nBot tidak akan membuka posisi baru.\nPosisi existing tetap dimonitor.`;
            break;

        case '/tf':
        case '/timeframe':
            const tfPair = command.split(' ')[1] || 'pepe_idr';

            if (!multiTFAnalyzer) {
                response = `❌ Multi-timeframe analyzer belum siap`;
                break;
            }

            const tfAnalyses = multiTFAnalyzer.analyzeAllTimeframes(tfPair);
            if (!tfAnalyses || tfAnalyses.length === 0) {
                response = `❌ No timeframe data for ${tfPair}`;
                break;
            }

            const tfConsensus = multiTFAnalyzer.calculateConsensus(tfAnalyses);
            const tfCanEnter = multiTFAnalyzer.canEnter(tfPair, 6);

            let tfMsg = `📊 <b>MULTI-TIMEFRAME ${tfPair.toUpperCase()}</b>\━━━━━━━━━━━━━━━━━━\n`;

            tfAnalyses.forEach(a => {
                const arrow = a.trend.includes("BULLISH") ? "🟢" : a.trend.includes("BEARISH") ? "🔴" : "⚪";
                tfMsg += `${arrow} <b>${a.timeframe}:</b> ${a.trend} | RSI: ${a.rsi}\n`;
            });

            tfMsg += `━━━━━━━━━━━━━━━━━━\n`;
            tfMsg += `<b>CONSENSUS:</b> ${tfConsensus.direction} (${(tfConsensus.consensusStrength * 100).toFixed(0)}%)\n`;
            tfMsg += `<b>ENTRY ALLOWED:</b> ${tfCanEnter.allowed ? '✅ YES' : '❌ NO'}`;

            response = tfMsg;
            break;

        case '/drawdown':
        case '/dd':
            response = `📊 <b>DRAWDOWN INFO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 Current Balance: Rp ${formatIDR(state.equityNow)}\n` +
                `📈 Peak Equity: Rp ${formatIDR(state.peakEquity)}\n` +
                `📉 Drawdown: ${state.currentDrawdown.toFixed(2)}%\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📉 Loss from peak: Rp ${formatIDR(state.peakEquity - state.equityNow)}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔄 Reset dengan: /resetpeak confirm`;
            break;

        case '/resetpeak':
            if (command.split(' ')[1] !== 'confirm') {
                response = `⚠️ <b>RESET PEAK EQUITY</b>\n` +
                    `Aksi ini akan mengatur ulang peak equity ke balance saat ini.\n\n` +
                    `Current Balance: Rp ${formatIDR(state.equityNow)}\n` +
                    `Current Peak: Rp ${formatIDR(state.peakEquity)}\n` +
                    `Current Drawdown: ${state.currentDrawdown.toFixed(2)}%\n\n` +
                    `Ketik: <code>/resetpeak confirm</code> untuk melanjutkan.`;
                break;
            }

            try {
                const backupPath = path.join(__dirname, `bot_state.json.backup-${Date.now()}`);
                fs.copyFileSync(STATE_FILE, backupPath);

                let stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                const oldPeak = stateData.peakEquity;

                stateData.peakEquity = state.equityNow;
                stateData.currentDrawdown = 0;

                fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));

                state.peakEquity = state.equityNow;
                state.currentDrawdown = 0;

                response = `✅ <b>PEAK EQUITY RESET</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Old Peak: Rp ${formatIDR(oldPeak)}\n` +
                    `New Peak: Rp ${formatIDR(state.peakEquity)}\n` +
                    `Drawdown: 0.00%\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `Backup: ${path.basename(backupPath)}`;

            } catch (e) {
                response = `❌ Error: ${e.message}`;
            }
            break;
        case '/resetdaily':
        case '/resetloss':
            if (command.split(' ')[1] !== 'confirm') {
                response = `⚠️ <b>RESET DAILY LOSS</b>\n` +
                    `Aksi ini akan mereset daily loss ke 0.\n\n` +
                    `Current Daily Loss: Rp ${formatIDR(state.dailyLoss)}\n` +
                    `Batas Maksimal: ${CONFIG.MAX_DAILY_LOSS}%\n\n` +
                    `Ketik: <code>/resetdaily confirm</code> untuk melanjutkan.`;
                break;
            }

            try {
                // Backup state dulu
                const backupPath = path.join(__dirname, `bot_state.json.backup-daily-${Date.now()}`);
                fs.copyFileSync(STATE_FILE, backupPath);

                // Baca file state
                let stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

                // Simpan nilai lama untuk laporan
                const oldDailyLoss = stateData.dailyLoss;
                const oldDailyTrades = stateData.dailyTrades;

                // Reset daily loss ke 0
                stateData.dailyLoss = 0;
                stateData.dailyTrades = 0;

                // Tulis kembali
                fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));

                // Update state di memory
                state.dailyLoss = 0;
                state.dailyTrades = 0;

                response = `✅ <b>DAILY LOSS RESET</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📌 <b>Before:</b>\n` +
                    `   Daily Loss: Rp ${formatIDR(oldDailyLoss)}\n` +
                    `   Daily Trades: ${oldDailyTrades}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📌 <b>After:</b>\n` +
                    `   Daily Loss: Rp 0\n` +
                    `   Daily Trades: 0\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💾 Backup saved: ${path.basename(backupPath)}`;

            } catch (e) {
                response = `❌ Error: ${e.message}`;
            }
            break;
        case '/restart':
        case '/reboot':
            if (command.split(' ')[1] !== 'confirm') {
                response = `⚠️ <b>RESTART BOT</b>\n` +
                    `Aksi ini akan merestart bot menggunakan PM2.\n\n` +
                    `⚠️ Bot akan offline selama beberapa detik!\n\n` +
                    `Ketik: <code>/restart confirm</code> untuk melanjutkan.\n` +
                    `Atau: <code>/restart logs</code> untuk restart + lihat log.`;
                break;
            }

            try {
                const { exec } = require('child_process');

                response = `🔄 <b>Merestart bot...</b>\n` +
                    `Bot akan online kembali dalam beberapa detik.`;
                await tg(response, "WARNING");

                // Eksekusi restart
                exec('pm2 restart my-worker', (error, stdout, stderr) => {
                    if (error) {
                        console.log(`❌ Restart error: ${error.message}`);
                        return;
                    }
                    if (stderr) {
                        console.log(`⚠️ Restart stderr: ${stderr}`);
                    }
                    console.log(`✅ Restart output: ${stdout}`);
                });

                // Tidak perlu response lagi karena bot akan restart
                return;

            } catch (e) {
                response = `❌ Error: ${e.message}`;
            }
            break;

        case '/logs':
            const args = command.split(' ');
            const lines = args[1] && !isNaN(args[1]) ? parseInt(args[1]) : 20;

            try {
                const { exec } = require('child_process');

                response = `📋 <b>Mengambil ${lines} log terakhir...</b>`;
                await tg(response, "INFO");

                // Eksekusi pm2 logs
                exec(`pm2 logs my-worker --lines ${lines} --nostream`, (error, stdout, stderr) => {
                    if (error) {
                        console.log(`❌ Logs error: ${error.message}`);
                        return;
                    }

                    // Format log untuk Telegram
                    let logText = stdout || stderr;

                    // Batasi panjang pesan Telegram (max 4096 karakter)
                    if (logText.length > 3500) {
                        logText = logText.substring(0, 3500) + '...\n📝 Log terlalu panjang, ditruncate.';
                    }

                    // Kirim log sebagai pesan terpisah
                    tg(`📋 <b>PM2 LOGS (${lines} lines)</b>\n<pre>${logText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`, "INFO");
                });

                // Response awal
                response = `✅ Perintah logs diterima. Silakan tunggu...`;

            } catch (e) {
                response = `❌ Error: ${e.message}`;
            }
            break;

        case '/statusbot':
        case '/botstatus':
            try {
                const { exec } = require('child_process');

                exec('pm2 status my-worker', (error, stdout, stderr) => {
                    if (error) {
                        console.log(`❌ Status error: ${error.message}`);
                        return;
                    }

                    // Parse status PM2
                    const statusText = stdout || stderr;

                    // Cari status bot
                    let status = 'Unknown';
                    let cpu = '0%';
                    let mem = '0MB';
                    let uptime = '0s';

                    const lines = statusText.split('\n');
                    for (const line of lines) {
                        if (line.includes('my-worker')) {
                            const parts = line.split(/\s+/);
                            status = parts[8] || 'unknown';
                            cpu = parts[11] || '0%';
                            mem = parts[12] || '0MB';
                            uptime = parts[9] || '0s';
                            break;
                        }
                    }

                    // Format response
                    const statusEmoji = status === 'online' ? '✅' : '❌';
                    const msg = `🤖 <b>BOT STATUS</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `${statusEmoji} Status: ${status}\n` +
                        `⏱️ Uptime: ${uptime}\n` +
                        `💻 CPU: ${cpu}\n` +
                        `💾 RAM: ${mem}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `📋 Log: /logs 20\n` +
                        `🔄 Restart: /restart confirm`;

                    tg(msg, status === 'online' ? "SUCCESS" : "WARNING");
                });

                response = `📊 Mengecek status bot...`;

            } catch (e) {
                response = `❌ Error: ${e.message}`;
            }
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
        const sekarang = Date.now();
        if (!lastCleanup || sekarang - lastCleanup > 30 * 60 * 1000) {
            await cleanupRemainingCoins();
            lastCleanup = sekarang;
        }
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
/* ======================================================
   BOT INITIALIZATION - SATU-SATUNYA
====================================================== */

(async () => {
    console.log("🚀 Initializing Professional Trading Bot v5.0 (API V2)...");

    try {
        await initializeComponents();
    } catch (e) {
        console.log("\n❌ Failed to initialize components:", e.message);
        console.log(e.stack);
        process.exit(1);
    }

    // Lanjut dengan koneksi API
    console.log("🔌 Connecting to Indodax API...");
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

        console.log("🔄 Starting main scanner loop...\n");
        scan();
    } else {
        console.log("❌ Failed to connect to Indodax API");
        console.log("Please check your API keys in .env file");
        await tg("❌ Bot failed to start: API Connection Error", "ERROR");
        process.exit(1);
    }
})();   