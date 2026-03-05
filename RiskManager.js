
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

        return this.state.isTradingEnabled;
    }
}


export default RiskManager;
