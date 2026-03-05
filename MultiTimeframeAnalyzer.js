// MultiTimeframeAnalyzer.js
class MultiTimeframeAnalyzer {
    constructor(config, technicalIndicators, state) {
        this.config = config;
        // Simpan instance technicalIndicators
        this.techInd = technicalIndicators;
        this.state = state;
        this.weights = config.TIMEFRAME_WEIGHTS || { '5m': 0.2, '15m': 0.3, '60m': 0.5 };
    }

    // Di dalam class MultiTimeframeAnalyzer, tambahkan method ini:
    getInsight(pair, baseScore) {
        const consensus = this.calculateWeightedConsensus(pair);

        if (!consensus || !consensus.direction) {
            return null;
        }

        const canEnter = this.canEnter(pair, baseScore);

        return {
            consensus: {
                direction: consensus.direction,
                consensusStrength: Math.abs(consensus.strength),
                details: consensus.details
            },
            canEnter: canEnter.allowed
        };
    }

    aggregateToTimeframe(pair, timeframeMinutes) {
        const rawPrices = this.state.priceMemory[pair] || [];
        if (rawPrices.length < 25) return null;

        // Hitung berapa banyak data tick dalam satu candle timeframe
        // Jika scan interval 8 detik, maka 5 menit = 300 detik / 8 = ~37 data point
        const ticksPerCandle = Math.max(1, Math.floor((timeframeMinutes * 60) / (this.config.SCAN_INTERVAL / 1000)));

        const candles = [];
        // Loop mundur dari data terbaru
        for (let i = rawPrices.length; i > 0; i -= ticksPerCandle) {
            const slice = rawPrices.slice(Math.max(0, i - ticksPerCandle), i);
            if (slice.length < 1) continue;
            candles.unshift({
                close: slice[slice.length - 1],
                high: Math.max(...slice),
                low: Math.min(...slice)
            });
            if (candles.length >= 40) break; // Batasi jumlah candle demi performa
        }
        return candles;
    }

    analyzeTimeframe(candles, tfLabel) {
        if (!candles || candles.length < 21) return null;
        const prices = candles.map(c => c.close);

        // ⚠️ PERBAIKAN: Gunakan this.techInd (instance), bukan TechnicalIndicators (class)
        const rsi = this.techInd.rsi(prices, 14);
        const ema9 = this.techInd.ema(prices, 9);
        const ema21 = this.techInd.ema(prices, 21);
        const currentPrice = prices[prices.length - 1];

        let score = 0;
        // Bullish: Harga di atas EMA9 dan EMA9 di atas EMA21
        if (currentPrice > ema9 && ema9 > ema21) score = 1;
        // Bearish: Harga di bawah EMA9 dan EMA9 di bawah EMA21
        else if (currentPrice < ema9 && ema9 < ema21) score = -1;

        return { score, rsi, weight: this.weights[tfLabel] || 0.3 };
    }

    // Fungsi jembatan untuk file bot.js kamu
    canEnter(pair, baseScore) {
        const consensus = this.calculateWeightedConsensus(pair);

        // Aturan: Boleh beli jika arah BULLISH atau NEUTRAL (tapi skor dasar sangat tinggi)
        const allowed = consensus.direction !== "BEARISH";

        return {
            allowed,
            consensus: {
                direction: consensus.direction,
                consensusStrength: Math.abs(consensus.strength),
                details: consensus.details
            }
        };
    }

    calculateWeightedConsensus(pair) {
        let totalWeightedScore = 0;
        let totalWeightUsed = 0;
        const details = [];

        for (const tf of [5, 15, 60]) {
            const candles = this.aggregateToTimeframe(pair, tf);
            const analysis = this.analyzeTimeframe(candles, `${tf}m`);

            if (analysis) {
                totalWeightedScore += (analysis.score * analysis.weight);
                totalWeightUsed += analysis.weight;
                details.push({ tf: `${tf}m`, score: analysis.score });
            }
        }

        const finalStrength = totalWeightUsed > 0 ? totalWeightedScore / totalWeightUsed : 0;

        return {
            strength: finalStrength,
            direction: finalStrength > 0.2 ? "BULLISH" : (finalStrength < -0.2 ? "BEARISH" : "NEUTRAL"),
            details
        };
    }

    // Tambahkan method untuk analisis semua timeframe (dipanggil dari bot.js)
    analyzeAllTimeframes(pair) {
        const results = [];
        for (const tf of [5, 15, 60]) {
            const candles = this.aggregateToTimeframe(pair, tf);
            if (!candles || candles.length < 21) continue;

            const prices = candles.map(c => c.close);
            const rsi = this.techInd.rsi(prices, 14);
            const ema9 = this.techInd.ema(prices, 9);
            const ema21 = this.techInd.ema(prices, 21);
            const currentPrice = prices[prices.length - 1];

            let trend = "NEUTRAL";
            if (currentPrice > ema9 && ema9 > ema21) trend = "BULLISH";
            else if (currentPrice < ema9 && ema9 < ema21) trend = "BEARISH";

            results.push({
                timeframe: `${tf}m`,
                trend,
                rsi: Math.round(rsi)
            });
        }
        return results;
    }

    calculateConsensus(tfAnalyses) {
        if (!tfAnalyses || tfAnalyses.length === 0) {
            return { direction: "NEUTRAL", consensusStrength: 0 };
        }

        let bullish = 0, bearish = 0;
        tfAnalyses.forEach(a => {
            if (a.trend === "BULLISH") bullish++;
            else if (a.trend === "BEARISH") bearish++;
        });

        const total = tfAnalyses.length;
        if (bullish > bearish) {
            return { direction: "BULLISH", consensusStrength: bullish / total };
        } else if (bearish > bullish) {
            return { direction: "BEARISH", consensusStrength: bearish / total };
        }
        return { direction: "NEUTRAL", consensusStrength: 0.5 };
    }
}

export default MultiTimeframeAnalyzer;