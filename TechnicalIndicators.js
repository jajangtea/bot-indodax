    class TechnicalIndicators {
        rsi(prices, period = 14) {
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

        ema(prices, period) {
            if (!prices || prices.length < period) return prices[prices.length - 1];

            const k = 2 / (period + 1);
            let ema = prices[0];

            for (let i = 1; i < prices.length; i++) {
                ema = prices[i] * k + ema * (1 - k);
            }

            return ema;
        }

        bb(prices, period = 20, std = 2) {
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

        detectMarketStructure(prices) {
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

    export default TechnicalIndicators;
