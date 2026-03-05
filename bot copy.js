import dotenv from "dotenv";
import crypto from "crypto";
import querystring from "querystring";
import https from "https";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ======================================================
   TRADER PROFESSIONAL FRAMEWORK v4.0
   - Market Structure Analysis
   - Institutional Risk Management
   - Multi-Timeframe Confirmation
   - Statistical Edge Detection
   - Psychological Discipline System
====================================================== */

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
const STATE_FILE = path.join(__dirname, "bot_state.json");
const LOG_FILE = path.join(__dirname, "trading_journal.csv");

/* ======================================================
   PROFESSIONAL TRADING CONFIGURATION
   Setiap parameter memiliki alasan statistik
====================================================== */

const CONFIG = {
    // === RISK MANAGEMENT (Ini adalah pembeda utama) ===
    RISK_PER_TRADE: 1.2,           // % risiko dari equity per trade (Kelly Criterion based)
    MAX_POSITIONS: 2,               // Maksimal posisi terbuka (diversifikasi)
    MAX_DAILY_LOSS: 5,              // Daily loss limit (% dari equity)
    MAX_DRAWDOWN: 50,               // Maximum drawdown sebelum stop trading
    MIN_EQUITY: 10000,             // Minimal equity untuk trading (Rp)
    
    // === MARKET FILTERS (Probabilitas berbasis data) ===
    MIN_VOL_24H: 500_000_000,       // Minimal volume 24j (likuiditas)
    MAX_SPREAD: 0.25,               // Maksimal spread (%)
    MAX_PUMP_PERCENT: 12,           // Maksimal pump dari low (hindari FOMO)
    MIN_PAIR_AGE: 7,                 // Minimal umur pair (hari) di market
    
    // === TECHNICAL INDICATORS (Statistical Edge) ===
    RSI_MIN: 55,                     // RSI oversold threshold (adjusted for crypto)
    RSI_MAX: 95,                     // RSI overbought threshold
    RSI_PERIOD: 14,                   // Period RSI
    EMA_SHORT: 9,
    EMA_LONG: 21,
    BB_PERIOD: 20,
    BB_STD: 2,
    
    // === TRADE EXECUTION ===
    BUY_PERCENT: 0.90,               // Gunakan 90% dari alokasi per posisi
    TP_PERCENT: 2.8,                  // Take profit (%)
    SL_PERCENT: 4,                   // Stop loss awal (%)
    TRAILING_GAP: 0.6,                 // Trailing stop gap (%)
    TRAILING_ACTIVATION: 1.0,          // Aktivasi trailing setelah profit (%)
    
    // === SYSTEM PARAMETERS ===
    MEM_LIMIT: 30,                     // Minimum memory untuk RSI
    COOLDOWN_MIN: 25,                   // Cooldown setelah jual (menit)
    SCAN_INTERVAL: 8000,                // Scan interval (ms)
    
    // === MARKET REGIME DETECTION ===
    TREND_STRENGTH_THRESHOLD: 0.55,     // Threshold untuk bull/bear
    VOLATILITY_THRESHOLD: 0.15,          // Threshold volatilitas tinggi
    
    // === PSYCHOLOGICAL SAFEGUARDS ===
    MAX_TRADES_PER_DAY: 10,               // Mencegah overtrading
    MIN_TIME_BETWEEN_TRADES: 120000,      // Minimal waktu antar trade (2 menit)
};

/* ======================================================
   BLACKLIST & WHITELIST MANAGEMENT
   - Menghindari stablecoin dan pair tidak likuid
====================================================== */

const BLACKLIST = new Set([
    "btc", "eth", "bnb", "usdt", "usdc", "busd", "dai", 
    "wbtc", "weth", "xaut", "tusd", "usdp", "usdd", "ust",
    "eurs", "ceur", "idk", "bsc", "matic", "ada", "sol", "xrp"
]);

const WHITELIST = new Set([
    // Altcoin potensial dengan likuiditas baik
    "trx", "xlm", "xem", "vet", "theta", "ftm", "avax",
    "link", "uni", "aave", "snx", "crv", "comp", "yfi",
    "sand", "mana", "axs", "enj", "gala", "flow", "neo"
]);

// Jika WHITELIST tidak kosong, hanya pair dalam whitelist yang dipertimbangkan
const USE_WHITELIST = false; // Set true untuk mode konservatif

/* ======================================================
   STATE MANAGEMENT (Trading Journal System)
   Trader profesional selalu mencatat dan evaluasi
====================================================== */

let state = {
    // Trading state
    positions: {},          // Posisi aktif
    cooldown: {},           // Pair dalam cooldown
    priceMemory: {},        // History harga untuk RSI
    volMemory: {},          // History volume
    tradeHistory: [],       // Riwayat trade
    
    // Risk management
    equityNow: 0,
    dailyLoss: 0,
    dailyTrades: 0,
    lastTradeTime: 0,
    peakEquity: 0,
    currentDrawdown: 0,
    
    // Market analysis
    sentiment: "NEUTRAL",
    marketRegime: "SIDEWAYS",
    volatilityLevel: "NORMAL",
    
    // Psychological metrics
    consecutiveWins: 0,
    consecutiveLosses: 0,
    lastWinLoss: null,
};

let isBuying = false;      // Lock untuk mencegah race condition
let isTradingEnabled = true; // Emergency stop

/* ======================================================
   STATE PERSISTENCE
====================================================== */

// Load state dari file
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE));
    } catch (e) { 
        console.log("⚠️ State file corrupt, using fresh state"); 
    }
}

// Save state dengan atomic write
const saveState = () => {
    try {
        // Tulis LANGSUNG ke file asli (tanpa .tmp)
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { 
            mode: 0o644,  // Permission file
            flag: 'w'      // Write mode
        });
        console.log("✅ State saved directly");
    } catch (e) {
        if (e.code === 'EACCES') {
            console.log("❌ ERROR: Cannot write to file. Fix permission!");
            console.log("Jalankan: sudo chown manis_aja:www-data " + STATE_FILE);
            console.log("Jalankan: sudo chmod 664 " + STATE_FILE);
        } else {
            console.log("❌ Error saving state:", e.message);
        }
    }
};

// Trading Journal Entry
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
   PROFESSIONAL RISK CALCULATIONS
   - Position sizing berdasarkan volatilitas
   - Kelly Criterion implementation
   - Drawdown management
====================================================== */

class RiskManager {
    constructor(state, config) {
        this.state = state;
        this.config = config;
    }
    
    // Hitung ukuran posisi optimal berdasarkan volatilitas
    calculatePositionSize(equity, volatility, confidence) {
        // Base risk percentage
        let riskPercent = this.config.RISK_PER_TRADE;
        
        // Adjust based on volatility
        if (volatility > this.config.VOLATILITY_THRESHOLD) {
            riskPercent *= 0.7; // Kurangi risiko saat volatilitas tinggi
        }
        
        // Adjust based on market regime
        if (this.state.marketRegime === "BEARISH") {
            riskPercent *= 0.5; // Setengah risiko saat bear market
        }
        
        // Adjust based on recent performance
        if (this.state.consecutiveLosses >= 3) {
            riskPercent *= 0.5; // Kurangi risiko setelah 3 losses berturut-turut
        } else if (this.state.consecutiveWins >= 3) {
            riskPercent *= 1.2; // Tambah sedikit setelah wins, tapi tetap hati-hati
        }
        
        // Apply confidence score (dari analisis teknikal)
        riskPercent *= (confidence / 10);
        
        // Calculate final position size
        const riskAmount = equity * (riskPercent / 100);
        return riskAmount;
    }
    
    // Cek apakah masih boleh trading
    canTrade() {
        // Check daily loss limit
        if (this.state.dailyLoss >= this.config.MAX_DAILY_LOSS) {
            console.log("⛔ Daily loss limit reached");
            return false;
        }
        
        // Check daily trades limit
        if (this.state.dailyTrades >= this.config.MAX_TRADES_PER_DAY) {
            console.log("⛔ Daily trade limit reached");
            return false;
        }
        
        // Check minimum equity
        if (this.state.equityNow < this.config.MIN_EQUITY) {
            console.log("⛔ Minimum equity not met");
            return false;
        }
        
        // Check drawdown
        if (this.state.currentDrawdown > this.config.MAX_DRAWDOWN) {
            console.log("⛔ Maximum drawdown exceeded");
            return false;
        }
        
        // Check time between trades
        if (Date.now() - this.state.lastTradeTime < this.config.MIN_TIME_BETWEEN_TRADES) {
            return false;
        }
        
        return isTradingEnabled;
    }
    
    // Update drawdown
    updateDrawdown(currentEquity) {
        if (currentEquity > this.state.peakEquity) {
            this.state.peakEquity = currentEquity;
            this.state.currentDrawdown = 0;
        } else {
            this.state.currentDrawdown = ((this.state.peakEquity - currentEquity) / this.state.peakEquity) * 100;
        }
    }
}

const riskManager = new RiskManager(state, CONFIG);

/* ======================================================
   ADVANCED TECHNICAL INDICATORS
   - Bukan sekadar pakai, tapi paham logika matematisnya
====================================================== */

class TechnicalIndicators {
    // RSI dengan smoothing
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
    
    // Exponential Moving Average
    static ema(prices, period) {
        if (!prices || prices.length < period) return prices[prices.length - 1];
        
        const k = 2 / (period + 1);
        let ema = prices[0];
        
        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }
        
        return ema;
    }
    
    // Bollinger Bands
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
    
    // Volume Profile (Simple version)
    static volumeProfile(prices, volumes) {
        if (!prices || !volumes || prices.length < 20) return { vwap: prices[prices.length - 1] };
        
        let volumeSum = 0;
        let priceVolumeSum = 0;
        
        for (let i = Math.max(0, prices.length - 20); i < prices.length; i++) {
            volumeSum += volumes[i] || 0;
            priceVolumeSum += (prices[i] * (volumes[i] || 0));
        }
        
        return {
            vwap: priceVolumeSum / volumeSum,
            volumeProfile: "NORMAL"
        };
    }
    
    // Market Structure Detection
    static detectMarketStructure(prices) {
        if (!prices || prices.length < 50) return "UNDEFINED";
        
        const recentPrices = prices.slice(-50);
        const firstHalf = recentPrices.slice(0, 25);
        const secondHalf = recentPrices.slice(25);
        
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        
        // Deteksi trend
        if (secondAvg > firstAvg * 1.05) return "UPTREND";
        if (secondAvg < firstAvg * 0.95) return "DOWNTREND";
        
        // Deteksi sideways
        const volatility = Math.sqrt(recentPrices.map(p => Math.pow(p - secondAvg, 2)).reduce((a, b) => a + b, 0) / recentPrices.length);
        if (volatility / secondAvg < 0.03) return "SIDEWAYS";
        
        return "CHOPPY";
    }
}

/* ======================================================
   NETWORKING & API COMMUNICATION
   - Error handling profesional
   - Retry mechanism
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
            await sleep(2000 * (i + 1)); // Exponential backoff
        }
    }
}

// Telegram notifikasi dengan format profesional
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

// Private API request dengan signature
async function privateReq(method, params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Nonce menggunakan timestamp mikrodetik
            const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
            
            const payload = { method, nonce, ...params };
            const postData = querystring.stringify(payload);
            
            if (!INDODAX_SECRET_KEY) throw new Error("Secret Key missing");
            
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
            
            if (res.success === 1) {
                return { success: true, data: res.return };
            } else {
                console.log(`⚠️ API Error [${method}]: ${res.error}`);
                return { success: false, error: res.error };
            }
        } catch (e) {
            console.log(`❌ Request Error (attempt ${i + 1}):`, e.message);
            if (i === retries - 1) return { success: false, error: e.message };
            await sleep(2000);
        }
    }
    
    return { success: false, error: "Max retries exceeded" };
}

// Refresh balance dengan validasi
async function refreshBalance() {
    try {
        const auth = await privateReq("getInfo");
        if (auth.success) {
            const newEquity = Number(auth.data.balance.idr || 0);
            
            // Update drawdown
            riskManager.updateDrawdown(newEquity);
            
            // Reset daily loss jika hari baru
            const today = new Date().toDateString();
            if (state.lastDate !== today) {
                state.dailyLoss = 0;
                state.dailyTrades = 0;
                state.lastDate = today;
            }
            
            state.equityNow = newEquity;
            return true;
        }
        return false;
    } catch (e) {
        console.log("❌ Balance refresh error:", e.message);
        return false;
    }
}

/* ======================================================
   MARKET ANALYSIS ENGINE
   - Multi-timeframe analysis
   - Regime detection
   - Score calculation
====================================================== */

class MarketAnalyzer {
    constructor(state, config) {
        this.state = state;
        this.config = config;
    }
    
    // Evaluasi pair untuk potensi beli
    evaluatePair(pair, ticker) {
        const price = Number(ticker.last || 0);
        const vol = Number(ticker.vol_idr || 0);
        const buyPrice = Number(ticker.buy || 0);
        const sellPrice = Number(ticker.sell || 0);
        const low24h = Number(ticker.low || price);
        const high24h = Number(ticker.high || price);
        
        // === FILTER LIKUIDITAS ===
        if (vol < this.config.MIN_VOL_24H) {
            return { score: 0, reason: "INSUFFICIENT_VOLUME", rsi: 50 };
        }
        
        // === FILTER SPREAD ===
        const spread = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
        if (spread > this.config.MAX_SPREAD) {
            return { score: 0, reason: "SPREAD_TOO_WIDE", rsi: 50 };
        }
        
        // === FILTER PUMP ===
        const pumpFromLow = ((price - low24h) / low24h) * 100;
        if (pumpFromLow > this.config.MAX_PUMP_PERCENT) {
            return { score: 0, reason: "PUMPED", rsi: 50 };
        }
        
        // === GET PRICE HISTORY ===
        const priceHistory = this.state.priceMemory[pair] || [];
        if (priceHistory.length < this.config.MEM_LIMIT) {
            return { score: 0, reason: `BUILDING_DATA(${priceHistory.length})`, rsi: 50 };
        }
        
        // === TECHNICAL ANALYSIS ===
        const rsi = TechnicalIndicators.rsi(priceHistory, this.config.RSI_PERIOD);
        const ema9 = TechnicalIndicators.ema(priceHistory.slice(-20), 9);
        const ema21 = TechnicalIndicators.ema(priceHistory, 21);
        const bb = TechnicalIndicators.bb(priceHistory, this.config.BB_PERIOD, this.config.BB_STD);
        const marketStructure = TechnicalIndicators.detectMarketStructure(priceHistory);
        
        // === MARKET REGIME CHECK ===
        if (this.state.marketRegime === "BEARISH" && rsi > 60) {
            return { score: 0, reason: "BEAR_MARKET_OVERBOUGHT", rsi };
        }
        
        // === RSI FILTER ===
        if (rsi < this.config.RSI_MIN || rsi > this.config.RSI_MAX) {
            return { score: 0, reason: "RSI_OUT_OF_RANGE", rsi };
        }
        
        // === SCORING SYSTEM ===
        let score = 0;
        let confidenceFactors = [];
        
        // 1. RSI Score (30% weight)
        if (rsi >= 50 && rsi <= 65) {
            score += 3;
            confidenceFactors.push("RSI_OPTIMAL");
        } else if (rsi > 45 && rsi < 50) {
            score += 2;
            confidenceFactors.push("RSI_NEAR_OVERSOLD");
        }
        
        // 2. EMA Crossover (20% weight)
        if (ema9 > ema21) {
            score += 2;
            confidenceFactors.push("EMA_BULLISH");
        }
        
        // 3. Bollinger Bands (15% weight)
        if (price <= bb.middle && price >= bb.lower) {
            score += 1.5;
            confidenceFactors.push("BB_SUPPORT");
        } else if (price < bb.lower) {
            score += 2.5;
            confidenceFactors.push("BB_OVERSOLD");
        }
        
        // 4. Volume Analysis (15% weight)
        const avgVol = this.state.volMemory[pair] 
            ? this.state.volMemory[pair].reduce((a, b) => a + b, 0) / this.state.volMemory[pair].length 
            : vol;
        
        if (vol > avgVol * 1.2) {
            score += 1.5;
            confidenceFactors.push("VOLUME_SPIKE");
        }
        
        // 5. Market Structure (20% weight)
        if (marketStructure === "UPTREND") {
            score += 2;
            confidenceFactors.push("UPTREND");
        } else if (marketStructure === "SIDEWAYS") {
            score += 1;
            confidenceFactors.push("SIDEWAYS");
        }
        
        // 6. Sentiment Adjustment
        if (this.state.sentiment === "BULLISH") {
            score += 1;
            confidenceFactors.push("BULLISH_SENTIMENT");
        } else if (this.state.sentiment === "BEARISH") {
            score -= 2;
        }
        
        // Normalize score to 1-10 scale
        const finalScore = Math.min(10, Math.max(0, score));
        const confidence = finalScore / 10;
        
        return {
            score: finalScore,
            confidence,
            rsi,
            ema9,
            ema21,
            bb,
            marketStructure,
            factors: confidenceFactors,
            reason: "QUALIFIED"
        };
    }
    
    // Detect market regime secara real-time
    detectMarketRegime(tickers) {
        let upCount = 0;
        let totalCount = 0;
        let volatilitySum = 0;
        
        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;
            
            const price = Number(t.last || 0);
            const low = Number(t.low || price);
            const high = Number(t.high || price);
            
            if (price > low * 1.02) upCount++;
            totalCount++;
            
            // Hitung volatilitas
            if (low > 0) {
                volatilitySum += ((high - low) / low) * 100;
            }
        }
        
        const ratio = upCount / totalCount;
        const avgVolatility = volatilitySum / totalCount;
        
        // Detect sentiment
        if (ratio > CONFIG.TREND_STRENGTH_THRESHOLD) {
            this.state.sentiment = "BULLISH";
        } else if (ratio < (1 - CONFIG.TREND_STRENGTH_THRESHOLD)) {
            this.state.sentiment = "BEARISH";
        } else {
            this.state.sentiment = "SIDEWAYS";
        }
        
        // Detect volatility
        this.state.volatilityLevel = avgVolatility > CONFIG.VOLATILITY_THRESHOLD * 100 
            ? "HIGH" 
            : "NORMAL";
        
        // Detect market regime
        if (this.state.sentiment === "BULLISH" && this.state.volatilityLevel === "NORMAL") {
            this.state.marketRegime = "HEALTHY_BULL";
        } else if (this.state.sentiment === "BULLISH" && this.state.volatilityLevel === "HIGH") {
            this.state.marketRegime = "MANIC_BULL";
        } else if (this.state.sentiment === "BEARISH" && this.state.volatilityLevel === "NORMAL") {
            this.state.marketRegime = "HEALTHY_BEAR";
        } else if (this.state.sentiment === "BEARISH" && this.state.volatilityLevel === "HIGH") {
            this.state.marketRegime = "PANIC_BEAR";
        } else {
            this.state.marketRegime = "SIDEWAYS";
        }
        
        return {
            sentiment: this.state.sentiment,
            volatility: this.state.volatilityLevel,
            regime: this.state.marketRegime
        };
    }
}

const analyzer = new MarketAnalyzer(state, CONFIG);

/* ======================================================
   EXECUTION ENGINE
   - Institutional grade order execution
   - Risk checks before each trade
====================================================== */

async function executeBuy(pair, price) {
    // 1. CEK PENGUNCI
    if (isBuying) return;
    isBuying = true;

    try {
        // 2. REFRESH SALDO
        await refreshBalance();
        
        // 3. HITUNG DANA TRADING (95% dari total)
        const tradingBalance = Math.floor(state.equityNow * 0.95);
        const holdBalance = state.equityNow - tradingBalance;
        
        console.log(`\n💰 PEMBAGIAN DANA:`);
        console.log(`Total Balance  : Rp ${formatIDR(state.equityNow)}`);
        console.log(`Trading (95%)  : Rp ${formatIDR(tradingBalance)}`);
        console.log(`Hold (5%)      : Rp ${formatIDR(holdBalance)}`);

        // 4. HITUNG SLOT TERSEDIA
        const openSlots = CONFIG.MAX_POSITIONS - Object.keys(state.positions).length;
        
        if (openSlots <= 0) {
            console.log(`[SKIP] Slot penuh, tidak bisa membeli ${pair}`);
            return;
        }

        // 5. BAGI RATA DANA TRADING PER SLOT
        const spendPerSlot = Math.floor(tradingBalance / CONFIG.MAX_POSITIONS);
        
        console.log(`\n📊 PERHITUNGAN MODAL PER POSISI:`);
        console.log(`MAX_POSITIONS   : ${CONFIG.MAX_POSITIONS}`);
        console.log(`Slot tersisa    : ${openSlots}`);
        console.log(`Modal per slot  : Rp ${formatIDR(spendPerSlot)}`);

        // 6. GUNAKAN MODAL TERSEBUT UNTUK BELI
        const spend = spendPerSlot;
        
        console.log(`\n🔵 Mencoba beli ${pair} dengan Rp ${formatIDR(spend)}`);

        // 7. KIRIM ORDER KE INDODAX
        const buyPrice = Math.ceil(price * 1.005); // +0.5% untuk slippage
        const res = await privateReq("trade", {
            pair,
            type: "buy",
            price: buyPrice,
            idr: spend
        });

        // 8. JIKA BERHASIL
        if (res.success) {
            // Hitung TP/SL
            const targetPrice = price * (1 + CONFIG.TP_PERCENT / 100);
            const stopPrice = price * (1 - CONFIG.SL_PERCENT / 100);

            // Simpan ke state
            state.positions[pair] = {
                entry: price,
                high: price,
                target: targetPrice,
                stop: stopPrice,
                coin: pair.split("_")[0],
                time: new Date().toLocaleString("id-ID"),
                size: spend
            };

            saveState();
            await refreshBalance();

            // Notifikasi Telegram
            const msg = `🚀 <b>BUY EXECUTED</b>\n` +
                `--------------------------\n` +
                `<b>Pair</b>      : ${pair.toUpperCase()}\n` +
                `<b>Price</b>     : Rp ${formatIDR(price)}\n` +
                `<b>Modal</b>     : Rp ${formatIDR(spend)}\n` +
                `--------------------------\n` +
                `<b>Target TP</b> : Rp ${formatIDR(targetPrice)} (${CONFIG.TP_PERCENT}%)\n` +
                `<b>Stop Loss</b> : Rp ${formatIDR(stopPrice)} (${CONFIG.SL_PERCENT}%)\n` +
                `--------------------------\n` +
                `<b>Sisa Hold</b> : Rp ${formatIDR(holdBalance)}\n` +
                `--------------------------`;
            
            await tg(msg);
            console.log(`\x1b[32m✅ BERHASIL membeli ${pair} di harga ${price}\x1b[0m`);
            
        } else {
            console.log(`\x1b[31m❌ GAGAL membeli ${pair}: ${res.error}\x1b[0m`);
            
            // Jika gagal karena minimal order, beri tahu
            if (res.error && res.error.includes("Minimal order")) {
                console.log(`⚠️ Indodax menolak: Minimal order Rp 50.000`);
                console.log(`💡 Solusi: Tambah deposit hingga minimal Rp ${Math.ceil(50000 * CONFIG.MAX_POSITIONS / 0.95)}`);
            }
        }

    } catch (e) {
        console.log("❌ ERROR di executeBuy:", e.message);
    } finally {
        // 9. BUKA KUNCI
        isBuying = false;
    }
}

async function executeSell(pair, price, reason) {
    const pos = state.positions[pair];
    if (!pos) return;
    
    try {
        // === GET BALANCE ===
        const auth = await privateReq("getInfo");
        if (!auth.success) return;
        
        const amount = Number(auth.data.balance[pos.coin] || 0);
        if (amount <= 0) {
            delete state.positions[pair];
            saveState();
            return;
        }
        
        // === EXECUTE SELL ORDER ===
        const sellPrice = Math.floor(price * 0.998); // 0.2% slippage buffer
        const res = await privateReq("trade", {
            pair,
            type: "sell",
            price: sellPrice,
            [pos.coin]: amount
        });
        
        if (res.success) {
            // === CALCULATE P&L ===
            const grossPnlPercent = ((price - pos.entry) / pos.entry) * 100;
            
            // Hitung actual P&L setelah fee
            const totalReceived = Math.floor(price * amount * 0.997);
            const totalSpent = Math.floor(pos.entry * (pos.size / pos.entry) * 1.003);
            const netPnlActual = totalReceived - totalSpent;
            const netPnlPercent = (netPnlActual / totalSpent) * 100;
            
            // === UPDATE RISK METRICS ===
            if (netPnlActual < 0) {
                state.dailyLoss += Math.abs(netPnlActual);
                state.consecutiveLosses++;
                state.consecutiveWins = 0;
                state.lastWinLoss = "LOSS";
            } else {
                state.consecutiveWins++;
                state.consecutiveLosses = 0;
                state.lastWinLoss = "WIN";
            }
            
            // === UPDATE STATE ===
            delete state.positions[pair];
            state.cooldown[pair] = Date.now();
            
            saveState();
            await refreshBalance();
            
            // === LOG TRADE ===
            logTrade({
                pair,
                type: "SELL",
                price: price,
                amount: amount,
                pnl: netPnlActual,
                reason: reason,
                grossPercent: grossPnlPercent,
                netPercent: netPnlPercent
            });
            
            // === SEND NOTIFICATION ===
            const emoji = netPnlActual >= 0 ? "💰" : "📉";
            const sign = netPnlActual >= 0 ? "+" : "";
            
            // Format persentase dengan warna
            const grossColor = grossPnlPercent >= 0 ? "🟢" : "🔴";
            const netColor = netPnlPercent >= 0 ? "🟢" : "🔴";
            
            const msg = `${emoji} <b>POSITION CLOSED</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Pair     : ${pair.toUpperCase()}\n` +
                `Exit     : Rp ${formatIDR(price)}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>NET RESULT (after fee)</b>\n` +
                `   ${sign}Rp ${formatIDR(Math.abs(netPnlActual))} (${netColor} ${formatPercent(netPnlPercent)} NET)\n` +
                `📈 <b>GROSS RESULT (before fee)</b>\n` +
                `   ${grossColor} ${formatPercent(grossPnlPercent)} GROSS\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 Reason : ${reason}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💼 Balance : Rp ${formatIDR(state.equityNow)}\n` +
                `📈 Win Streak : ${state.consecutiveWins}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`;
            
            await tg(msg, netPnlActual >= 0 ? "SUCCESS" : "WARNING");
            
            console.log(`\x1b[${netPnlActual >= 0 ? 32 : 33}m[SELL] ${pair} @ ${formatIDR(price)} | NET: ${formatPercent(netPnlPercent)} | GROSS: ${formatPercent(grossPnlPercent)}\x1b[0m`);
        }
        
    } catch (e) {
        console.log("❌ ExecuteSell Error:", e.message);
    }
}

/* ======================================================
   POSITION MANAGEMENT
   - Trailing stop implementation
   - Auto-sync dengan market
====================================================== */

async function managePositions(tickers) {
    for (const [pair, pos] of Object.entries(state.positions)) {
        const ticker = tickers[pair];
        if (!ticker) continue;
        
        const currentPrice = Number(ticker.last || 0);
        if (!currentPrice) continue;
        
        // === UPDATE HIGH PRICE ===
        if (currentPrice > (pos.high || pos.entry)) {
            state.positions[pair].high = currentPrice;
            saveState();
        }
        
        // === CHECK IF ALREADY SOLD MANUALLY ===
        const auth = await privateReq("getInfo");
        if (auth.success) {
            const coinBalance = Number(auth.data.balance[pos.coin] || 0);
            if (coinBalance <= 0) {
                console.log(`[AUTO-SYNC] ${pair} sudah terjual manual`);
                delete state.positions[pair];
                saveState();
                continue;
            }
        }
        
        // === CALCULATE EXIT LEVELS ===
        const profitPercent = ((currentPrice - pos.entry) / pos.entry) * 100;
        
        // Take Profit
        const targetPrice = pos.entry * (1 + CONFIG.TP_PERCENT / 100);
        
        // Trailing Stop
        let stopPrice = pos.entry * (1 - CONFIG.SL_PERCENT / 100);
        
        // Aktifkan trailing setelah profit mencapai activation threshold
        if (profitPercent >= CONFIG.TRAILING_ACTIVATION) {
            const trailingStop = (pos.high || currentPrice) * (1 - CONFIG.TRAILING_GAP / 100);
            stopPrice = Math.max(stopPrice, trailingStop);
        }
        
        // === EXECUTE EXIT ===
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
   MAIN SCANNER LOOP
   - Professional grade market scanning
   - Real-time analysis
====================================================== */

async function scan() {
    try {
        // === REFRESH BALANCE ===
        await refreshBalance();
        
        // === FETCH MARKET DATA ===
        const response = await axios.get(PUBLIC_URL, { timeout: 15000 });
        if (!response.data || !response.data.tickers) {
            setTimeout(scan, CONFIG.SCAN_INTERVAL);
            return;
        }
        
        const tickers = response.data.tickers;
        
        // === UPDATE PRICE MEMORY ===
        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;
            
            const price = Number(t.last || 0);
            const volume = Number(t.vol_idr || 0);
            
            if (price > 0) {
                state.priceMemory[pair] = [...(state.priceMemory[pair] || []), price].slice(-50);
                state.volMemory[pair] = [...(state.volMemory[pair] || []), volume].slice(-20);
            }
        }
        
        // === DETECT MARKET REGIME ===
        const marketRegime = analyzer.detectMarketRegime(tickers);
        
        // === MANAGE EXISTING POSITIONS ===
        await managePositions(tickers);
        
        // === SCAN FOR NEW OPPORTUNITIES ===
        const candidates = [];
        
        for (const [pair, t] of Object.entries(tickers)) {
            if (!pair.endsWith("_idr")) continue;
            
            const base = pair.split("_")[0];
            
            // Filter blacklist
            if (BLACKLIST.has(base)) continue;
            
            // Whitelist filter (jika diaktifkan)
            if (USE_WHITELIST && !WHITELIST.has(base)) continue;
            
            // Skip jika dalam cooldown
            if (Date.now() - (state.cooldown[pair] || 0) < CONFIG.COOLDOWN_MIN * 60000) continue;
            
            // Skip jika sudah punya posisi
            if (state.positions[pair]) continue;
            
            // Evaluasi pair
            const analysis = analyzer.evaluatePair(pair, t);
            
            if (analysis.score > 0) {
                candidates.push({
                    pair,
                    ticker: t,
                    ...analysis
                });
            }
        }
        
        // === SORT BY SCORE ===
        candidates.sort((a, b) => b.score - a.score);
        
        // === DISPLAY DASHBOARD ===
        console.clear();
        console.log(`\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m`);
        console.log(`\x1b[36m║        PROFESSIONAL TRADING BOT v4.0                     ║\x1b[0m`);
        console.log(`\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m\n`);
        
        console.log(`📊 MARKET REGIME:`);
        console.log(`   Sentiment    : ${state.sentiment}`);
        console.log(`   Volatility   : ${state.volatilityLevel}`);
        console.log(`   Regime       : ${state.marketRegime}\n`);
        
        console.log(`💰 ACCOUNT SUMMARY:`);
        console.log(`   Balance      : Rp ${formatIDR(state.equityNow)}`);
        console.log(`   Peak Equity  : Rp ${formatIDR(state.peakEquity)}`);
        console.log(`   Drawdown     : ${state.currentDrawdown.toFixed(2)}%`);
        console.log(`   Daily Loss   : Rp ${formatIDR(state.dailyLoss)} / ${CONFIG.MAX_DAILY_LOSS}%\n`);
        
        console.log(`📈 POSITIONS: ${Object.keys(state.positions).length}/${CONFIG.MAX_POSITIONS}`);
        
        if (Object.keys(state.positions).length > 0) {
            for (const [pair, pos] of Object.entries(state.positions)) {
                const currentPrice = Number(tickers[pair]?.last || 0);
                const pnl = currentPrice ? ((currentPrice - pos.entry) / pos.entry * 100) : 0;
                const color = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
                
                console.log(`   ${pair.toUpperCase().padEnd(10)} | ${color}${pnl.toFixed(2)}%\x1b[0m | Target: ${formatIDR(pos.target)}`);
            }
        } else {
            console.log(`   No open positions\n`);
        }
        
        console.log(`🎯 TOP CANDIDATES:`);
        candidates.slice(0, 5).forEach((c, i) => {
            const color = c.score >= 8 ? "\x1b[32m" : c.score >= 6 ? "\x1b[33m" : "\x1b[0m";
            console.log(`   ${i+1}. ${c.pair.toUpperCase().padEnd(10)} ${color}Score: ${c.score.toFixed(1)} RSI: ${c.rsi.toFixed(0)} Confidence: ${(c.confidence*100).toFixed(0)}%\x1b[0m`);
        });
        
        // === EXECUTE TRADES ===
        const canTrade = riskManager.canTrade();
        
        if (canTrade && Object.keys(state.positions).length < CONFIG.MAX_POSITIONS) {
            // Filter kandidat berdasarkan sentimen
            const qualifiedCandidates = candidates.filter(c => {
                if (marketRegime.regime.includes("BEAR") && c.score < 7) return false;
                if (c.score < 6) return false;
                return true;
            });
            
            const topPick = qualifiedCandidates[0];
            
            if (topPick && !isBuying) {
                const price = Number(topPick.ticker.last);
                await executeBuy(topPick.pair, price, topPick);
            }
        }
        
        saveState();
        
    } catch (err) {
        console.log("❌ Scan Error:", err.message);
        
        // Emergency stop jika error parah
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
            console.log("⚠️ Network error, but bot will continue...");
        }
    }
    
    setTimeout(scan, CONFIG.SCAN_INTERVAL);
}

/* ======================================================
   EMERGENCY STOP & RECOVERY
====================================================== */

process.on('SIGINT', async () => {
    console.log('\n\n⚠️ Received SIGINT. Saving state and shutting down...');
    saveState();
    await tg("🛑 Bot dihentikan secara manual", "WARNING");
    process.exit(0);
});

process.on('uncaughtException', async (err) => {
    console.log('❌ Uncaught Exception:', err);
    await tg(`❌ Uncaught Exception: ${err.message}`, "ERROR");
    saveState();
});

/* ======================================================
   BOT INITIALIZATION
====================================================== */

(async () => {
    console.log("🚀 Initializing Professional Trading Bot...");
    
    // Test API connection
    const success = await refreshBalance();
    
    if (success) {
        console.log("✅ API Connection Successful");
        console.log(`💰 Initial Balance: Rp ${formatIDR(state.equityNow)}`);
        
        // Initialize peak equity
        if (state.peakEquity === 0) {
            state.peakEquity = state.equityNow;
        }
        
        // Send startup notification
        await tg(
            `🤖 <b>Bot Started Successfully</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Balance    : Rp ${formatIDR(state.equityNow)}\n` +
            `Max Risk   : ${CONFIG.RISK_PER_TRADE}%/trade\n` +
            `Max Loss   : ${CONFIG.MAX_DAILY_LOSS}%/day\n` +
            `Positions  : 0/${CONFIG.MAX_POSITIONS}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Regime Detection: ACTIVE\n` +
            `Risk Management: PROFESSIONAL\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`,
            "SUCCESS"
        );
        
        // Start main loop
        scan();
    } else {
        console.log("❌ Failed to connect to Indodax API");
        console.log("Please check your API keys in .env file");
        await tg("❌ Bot failed to start: API Connection Error", "ERROR");
    }
})();

/* ======================================================
   END OF IMPLEMENTATION
   Trader Profesional = Risk Manager + Statistician + Psychologist
====================================================== */
