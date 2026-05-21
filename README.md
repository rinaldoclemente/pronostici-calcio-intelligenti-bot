# ⚽ Pronostici calcio intelligenti

🔥 Analisi automatica delle partite di calcio basata su modello statistico avanzato per individuare **pronostici con reale valore**.

Il bot genera ogni settimana una selezione delle migliori giocate e le invia direttamente su Telegram.

---

## 🚀 Cosa fa

Ogni **venerdì** il bot:

- ✅ Analizza i principali campionati europei
- ✅ Calcola probabilità tramite modello Poisson
- ✅ Valuta la forma recente delle squadre
- ✅ Identifica giocate con valore reale
- ✅ Invia automaticamente i risultati su Telegram

---

## 📩 Cosa ricevi

### 🔥 1. Messaggio principale — Top Picks

Contiene le **10 migliori opportunità del weekend**, suddivise in tre livelli:

- ✅ **Sicura** → alta probabilità
- ⚖️ **Equilibrata** → buon compromesso rischio/valore
- 🔥 **Value** → quota più alta con base statistica

Esempio:

```text
🔥 ECCO LE MIGLIORI LETTURE DEL WEEKEND 🔥

⚽ Inter - Milan
✅ 1X
⚖️ Over 2.5
🔥 1 + Over 2.5
```

---

### 📊 2. Messaggi per campionato

Dopo il messaggio principale, il bot invia anche un messaggio separato per ogni campionato:

- 🇮🇹 Serie A
- 🏴 Premier League
- 🇩🇪 Bundesliga
- 🇪🇸 La Liga
- 🇫🇷 Ligue 1

Esempio:

```text
📊 SERIE A

⚽ Inter-Milan → 1X | Over 2.5 | 1 + Over 2.5
⚽ Napoli-Atalanta → 1X | Over 2.5 | 1 + Over 2.5
```

---

## 🧠 Metodo

Il bot utilizza un modello statistico basato su:

- 📈 **Modello Poisson** per stimare i gol attesi
- 📊 Statistiche recenti delle squadre
- 🏟️ Rendimento casa / trasferta
- ⚖️ Media gol del campionato
- 🔥 Selezione dei mercati con migliore valore statistico

Da questi dati calcola pronostici sui principali mercati:

- 1X2
- Doppia chance
- Over / Under
- BTTS, entrambe segnano
- Combo, ad esempio `1 + Over 2.5`

---

## 🎯 Obiettivo

L’obiettivo del bot è:

- 👉 Evitare giocate casuali
- 👉 Ridurre le scommesse banali
- 👉 Individuare opportunità con valore statistico
- 👉 Fornire una lettura più intelligente del weekend calcistico

---

## ⚙️ Setup

### 1. Clona il repository

```bash
git clone https://github.com/tuo-username/rinaldo-scout-bot.git
cd rinaldo-scout-bot
```

---

### 2. Crea il file `users.json`

Inserisci i chat ID Telegram che devono ricevere i messaggi:

```json
[
  "123456789"
]
```

Puoi inserire più utenti così:

```json
[
  "123456789",
  "987654321"
]
```

---

### 3. Configura il token Telegram

Su GitHub vai in:

```text
Repository → Settings → Secrets and variables → Actions → New repository secret
```

Crea un secret con questo nome:

```text
BOT_TOKEN
```

Come valore inserisci il token del tuo bot Telegram:

```text
123456789:ABCDEF_your_bot_token
```

---

### 4. Avvio locale opzionale

Se vuoi testare il bot in locale:

```bash
npm install
npm start
```

Oppure:

```bash
BOT_TOKEN="IL_TUO_TOKEN" node bot.js
```

---

## ⏰ Automazione con GitHub Actions

Il bot usa GitHub Actions per eseguire automaticamente il file `bot.js`.

Il workflow si trova in:

```text
.github/workflows/bot.yml
```

Configurazione attuale:

```yaml
cron: "0 8 * * 5"
```

Significa:

- ✅ ogni venerdì
- ✅ alle 08:00 UTC
- ✅ circa alle 10:00 italiane durante l’ora legale

Puoi eseguirlo anche manualmente da GitHub:

```text
Actions → Rinaldo Scout Bot → Run workflow
```

---

## 📁 Struttura del progetto

```text
.
├── bot.js
├── package.json
├── users.json
└── .github/
    └── workflows/
        └── bot.yml
```

---

## 🧩 File principali

### `bot.js`

Contiene tutta la logica del bot:

- caricamento dati partite
- calcolo statistiche
- modello Poisson
- generazione pronostici
- creazione messaggi Telegram
- invio agli utenti

---

### `users.json`

Contiene i destinatari Telegram:

```json
[
  "123456789"
]
```

---

### `package.json`

Definisce il comando di avvio:

```json
{
  "scripts": {
    "start": "node bot.js"
  }
}
```

---

### `.github/workflows/bot.yml`

Gestisce la schedulazione automatica settimanale tramite GitHub Actions.

---

## 📬 Esempio messaggio Telegram

```text
🔥 ECCO LE MIGLIORI LETTURE DEL WEEKEND 🔥

Analisi basata su modello statistico + forma squadre.
Qui trovi le giocate con miglior valore.

✅ Sicura → alta probabilità
⚖️ Equilibrata → rischio controllato
🔥 Value → quota alta

━━━━━━━━━━━━━━━

⚽ Inter - Milan
✅ 1X
⚖️ Over 2.5
🔥 1 + Over 2.5

⚽ Arsenal - Chelsea
✅ Over 1.5
⚖️ BTTS
🔥 BTTS + Over 2.5

━━━━━━━━━━━━━━━
🎯 Gioca poche selezioni per massimizzare valore
```

---

## ⚠️ Disclaimer

Questo bot:

- NON garantisce vincite
- NON è consulenza finanziaria
- NON rappresenta un invito al gioco
- Fornisce solo analisi statistiche automatiche

👉 Utilizzare i dati in modo responsabile.

---

## 💡 Possibili evoluzioni

Funzionalità che possono essere aggiunte in futuro:

- 🔥 Pick della settimana
- 💰 Schedina automatica pronta
- 📊 Ranking value bets
- 📈 Percentuali e quote stimate
- 🧠 Backtest storico
- 📱 Dashboard web
- 🔐 Versione premium con abbonamento

---

## 👤 Autore

**Rinaldo Scout**

Bot progettato per trasformare dati calcistici in letture più intelligenti del weekend.
