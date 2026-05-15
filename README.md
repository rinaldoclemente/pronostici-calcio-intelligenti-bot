# ⚽ Smart Football Predictions Bot

Bot Telegram che genera pronostici calcistici automatici usando un modello statistico basato su distribuzione di Poisson.

## 🚀 Funzionalità

- 📊 Analisi statistica su 6 campionati europei:
  - Serie A
  - Premier League
  - Bundesliga
  - La Liga
  - Ligue 1
  - Eredivisie

- 🧠 Modello predittivo:
  - Attack & Defence Strength
  - Distribuzione di Poisson
  - Calcolo probabilità risultati esatti

- 🎯 Output automatico:
  - ✅ Top 10 pronostici più probabili
  - ✅ Tutte le partite del weekend
  - ✅ Top 2 risultati per ogni match
  - ✅ Percentuali di probabilità

- 🤖 Bot Telegram:
  - Invio automatico ogni venerdì alle 15
  - Messaggi formattati leggibili

- ⏰ Automation:
  - GitHub Actions scheduler
  - Nessuna infrastruttura necessaria

---

## 📦 Architettura

- `predictor.js` → Download dati partite
- `logic.js` → Modello Poisson
- `bot.js` → Invio messaggi Telegram
- `.github/workflows/` → Scheduler automatico

---

## ⚙️ Setup

1. Crea un bot su Telegram (@BotFather)
2. Ottieni:
   - BOT_TOKEN
   - CHAT_ID

3. Aggiungi secrets su GitHub:
   - `BOT_TOKEN`
   - `CHAT_ID`

4. Attiva GitHub Actions

---

## ⏰ Schedulazione

```yaml
cron: "0 13 * * 5"
