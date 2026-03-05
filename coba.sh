# 1. Reset drawdown dulu
cd /gopanel/sites/simanis/public/bot-worker/
BALANCE=$(grep -o '"equityNow": [0-9.]*' bot_state.json | head -1 | awk '{print $2}')
sed -i "s/\"peakEquity\": [0-9.]*/\"peakEquity\": $BALANCE/" bot_state.json
sed -i 's/"currentDrawdown": [0-9.]*/"currentDrawdown": 0/' bot_state.json

# 2. Restart bot
pm2 restart bot-pro

# 3. Lihat log
pm2 logs bot-pro --lines 20