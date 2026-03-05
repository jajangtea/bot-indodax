class MarketAnalyzer {
     constructor(state, config, technicalIndicators) {
        // Debug parameter yang diterima
        console.log("   📥 MarketAnalyzer constructor received:");
        console.log("      - state:", state ? "✅" : "❌");
        console.log("      - config:", config ? "✅" : "❌");
        console.log("      - technicalIndicators:", technicalIndicators ? "✅" : "❌");
        
        if (!technicalIndicators) {
            console.error("❌ ERROR: technicalIndicators is required for MarketAnalyzer");
            console.error("   🔍 Stack trace:", new Error().stack);
            throw new Error("technicalIndicators is required");
        }
        
        this.state = state;
        this.config = config;
        this.techInd = technicalIndicators;
        
        console.log("   ✅ MarketAnalyzer initialized with techInd");
    }

    evaluatePair(pair, ticker) {
        // VALIDASI: Cek this.techInd sebelum digunakan
        if (!this.techInd || typeof this.techInd.rsi !== 'function') {
            console.error("❌ MarketAnalyzer: techInd not properly initialized");
            return { score: 0, reason: "TECH_IND_NOT_READY", rsi: 50 };
        }
        
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

        // ✅ Gunakan this.techInd dengan aman
        try {
            const rsi = this.techInd.rsi(priceHistory, this.config.RSI_PERIOD);
            const ema9 = this.techInd.ema(priceHistory.slice(-20), 9);
            const ema21 = this.techInd.ema(priceHistory, 21);
            const bb = this.techInd.bb(priceHistory, this.config.BB_PERIOD, this.config.BB_STD);
            const marketStructure = this.techInd.detectMarketStructure(priceHistory);

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
            
        } catch (error) {
            console.log(`❌ Error calculating indicators for ${pair}:`, error.message);
            return { score: 0, reason: "INDICATOR_ERROR", rsi: 50 };
        }
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

        const ratio = upCount / (totalCount || 1);

        if (ratio > this.config.TREND_STRENGTH_THRESHOLD) {
            this.state.sentiment = "BULLISH";
            this.state.marketRegime = "HEALTHY_BULL";
        } else if (ratio < (1 - this.config.TREND_STRENGTH_THRESHOLD)) {
            this.state.sentiment = "BEARISH";
            this.state.marketRegime = "HEALTHY_BEAR";
        } else {
            this.state.sentiment = "SIDEWAYS";
            this.state.marketRegime = "SIDEWAYS";
        }

        return { sentiment: this.state.sentiment, regime: this.state.marketRegime };
    }
}

export default MarketAnalyzer;