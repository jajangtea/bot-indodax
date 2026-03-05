#!/bin/bash

# Warna
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

clear
echo -e "${PURPLE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║           RESET MAXIMUM DRAWDOWN EXCEEDED                ║${NC}"
echo -e "${PURPLE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

cd /gopanel/sites/simanis/public/bot-worker/

# Fungsi untuk format rupiah
format_rupiah() {
    echo $1 | awk '{printf "Rp %\047d\n", $1}'
}

# Cek file state
if [ ! -f bot_state.json ]; then
    echo -e "${RED}❌ File bot_state.json tidak ditemukan!${NC}"
    exit 1
fi

# Backup otomatis
BACKUP_DIR="backups/drawdown_$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR
cp bot_state.json $BACKUP_DIR/
cp trading_journal.csv $BACKUP_DIR/ 2>/dev/null
echo -e "${GREEN}✅ Backup created in: $BACKUP_DIR${NC}"

# Baca data dari state
EQUITY=$(grep -o '"equityNow": [0-9.]*' bot_state.json | head -1 | awk '{print $2}')
PEAK=$(grep -o '"peakEquity": [0-9.]*' bot_state.json | head -1 | awk '{print $2}')
DRAWDOWN=$(grep -o '"currentDrawdown": [0-9.]*' bot_state.json | head -1 | awk '{print $2}')
DAILY_LOSS=$(grep -o '"dailyLoss": [0-9.]*' bot_state.json | head -1 | awk '{print $2}')
CONSEC_LOSS=$(grep -o '"consecutiveLosses": [0-9]*' bot_state.json | head -1 | awk '{print $2}')

# Baca max drawdown dari config
MAX_DD=$(grep -o 'MAX_DRAWDOWN": [0-9]*' bot.js | head -1 | awk '{print $2}')
if [ -z "$MAX_DD" ]; then
    MAX_DD=15
fi

echo -e "${YELLOW}📊 CURRENT STATUS:${NC}"
echo -e "   Equity Now      : $(format_rupiah $EQUITY)"
echo -e "   Peak Equity     : $(format_rupiah $PEAK)"
echo -e "   Drawdown        : ${DRAWDOWN}%"
echo -e "   Max Drawdown    : ${MAX_DD}%"
echo -e "   Daily Loss      : $(format_rupiah $DAILY_LOSS)"
echo -e "   Consecutive Loss: $CONSEC_LOSS"
echo ""

echo -e "${BLUE}Pilih metode reset:${NC}"
echo "   1) Reset drawdown (set peak = equity)"
echo "   2) Reset semua metrics (fresh start)"
echo "   3) Naikkan max drawdown limit"
echo "   4) Hapus state (reset total)"
echo "   5) Keluar"
echo ""
read -p "Pilih [1-5]: " choice

case $choice in
    1)
        echo -e "\n${YELLOW}🔄 Mereset drawdown...${NC}"
        sed -i "s/\"peakEquity\": [0-9.]*/\"peakEquity\": $EQUITY/" bot_state.json
        sed -i 's/"currentDrawdown": [0-9.]*/"currentDrawdown": 0/' bot_state.json
        echo -e "${GREEN}✅ Drawdown direset ke 0%${NC}"
        ;;
        
    2)
        echo -e "\n${YELLOW}🔄 Mereset semua metrics...${NC}"
        sed -i "s/\"peakEquity\": [0-9.]*/\"peakEquity\": $EQUITY/" bot_state.json
        sed -i 's/"currentDrawdown": [0-9.]*/"currentDrawdown": 0/' bot_state.json
        sed -i 's/"dailyLoss": [0-9.]*/"dailyLoss": 0/' bot_state.json
        sed -i 's/"dailyTrades": [0-9]*/"dailyTrades": 0/' bot_state.json
        sed -i 's/"consecutiveLosses": [0-9]*/"consecutiveLosses": 0/' bot_state.json
        sed -i 's/"lastWinLoss": "[^"]*"/"lastWinLoss": null/' bot_state.json
        echo -e "${GREEN}✅ Semua metrics direset${NC}"
        ;;
        
    3)
        echo -e "\n${YELLOW}📈 Naikkan max drawdown limit${NC}"
        read -p "Masukkan max drawdown baru (%) [current: $MAX_DD]: " NEW_MAX_DD
        if [ -n "$NEW_MAX_DD" ]; then
            sed -i "s/MAX_DRAWDOWN: [0-9]*/MAX_DRAWDOWN: $NEW_MAX_DD/" bot.js
            echo -e "${GREEN}✅ Max drawdown diubah ke ${NEW_MAX_DD}%${NC}"
        fi
        ;;
        
    4)
        echo -e "\n${RED}⚠️ PERINGATAN: Ini akan menghapus semua data!${NC}"
        read -p "Yakin? (y/N): " confirm
        if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
            pm2 stop bot-pro
            rm -f bot_state.json trading_journal.csv *.tmp
            echo -e "${GREEN}✅ State dihapus${NC}"
        else
            echo -e "${YELLOW}Dibatalkan${NC}"
            exit 0
        fi
        ;;
        
    5)
        echo -e "${YELLOW}Keluar${NC}"
        exit 0
        ;;
        
    *)
        echo -e "${RED}Pilihan tidak valid${NC}"
        exit 1
        ;;
esac

# Restart bot
echo -e "\n${BLUE}🔄 Merestart bot...${NC}"
pm2 restart bot-pro

# Cek status
sleep 3
echo -e "\n${GREEN}✅ Selesai! Status bot:${NC}"
pm2 status bot-pro

echo -e "\n${YELLOW}📝 Untuk melihat log:${NC}"
echo "   pm2 logs bot-pro --lines 50"