// =============================
// 🤖 TELEGRAM TIPSTER BOT PRO
// =============================

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const BASE_URL = "https://fixturedownload.com/feed/json/";

// ✅ TUTTI I CAMPIONATI
const LEAGUES = [
  { name: "SERIE A", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", slug: "epl-2025" },
  { name: "BUNDESLIGA", slug: "bundesliga-2025" },
  { name: "LA LIGA", slug: "la-liga-2025" },
  { name: "LIGUE 1", slug: "ligue-1-2025" },
  { name: "EREDIVISIE", slug: "eredivisie-2025" }
];

// =============================
// ✅ INVIO MESSAGGIO
// =============================
async function sendMessage(chatId, text, keyboard = null) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: keyboard
    })
  });
}

// =============================
// ✅ MENU
// =============================
function buildMenu() {
  return {
    keyboard: [
      ["🔥 Solo TOP 10"],
      ["🇮🇹 Serie A", "🏴 Premier League"],
      ["🇪🇸 La Liga", "🇩🇪 Bundesliga"],
      ["🇫🇷 Ligue 1", "🇳🇱 Eredivisie"],
      ["📊 Tutte le partite"],
      ["✅ Tutto"]
    ],
    resize_keyboard: true
  };
}

// =============================
// ✅ WELCOME
// =============================
function welcomeText() {
  return `
👋 Benvenuto in *Pronostici Calcio Intelligenti*

⚽ Analizzo le partite dei principali campionati con un modello statistico (Poisson).

🔥 TOP 10:
Sono i 10 pronostici migliori tra TUTTI i campionati (non solo una lega).

📩 Ogni venerdì alle 16 riceverai:
• TOP 10 globali
• Tutte le partite del weekend
• 2 pronostici per match
• Risultati esatti più probabili

⚙️ Puoi scegliere cosa ricevere dal menu 👇
`;
}

// =============================
// ✅ ICONE
// =============================
function icon(pct) {
  if (pct >= 0.65) return "✅";
  if (pct >= 0.55) return "🔥";
  return "⚖️";
}

// =============================
// ✅ STATISTICHE
// =============================
function getStats(team, matches) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (games.length === 0) return { gf: 1.2, ga: 1.2 };

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

// =============================
// ✅ POISSON
// =============================
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

// =============================
// ✅ CALCOLO PRONOSTICI
// =============================
function calculateBets(lambdaH, lambdaA) {

  let pH = 0, pD = 0, pA = 0;
  let over25 = 0, under35 = 0, btts = 0;

  let scores = [];

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {

      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      scores.push({ score: `${i}-${j}`, p });

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      if (i + j > 2) over25 += p;
      if (i + j < 4) under35 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }

  scores.sort((a, b) => b.p - a.p);

  const bets = [
    { label: "1", pct: pH },
    { label: "X", pct: pD },
    { label: "2", pct: pA },
    { label: "1X", pct: pH + pD },
    { label: "X2", pct: pD + pA },
    { label: "OVER 2.5", pct: over25 },
    { label: "UNDER 3.5", pct: under35 },
    { label: "BTTS SÌ", pct: btts }
  ];

  bets.sort((a, b) => b.pct - a.pct);

  return {
    topBets: bets.slice(0, 2),
    scores: scores.slice(0, 2)
  };
}

// =============================
// ✅ LOAD DATI
// =============================
async function loadData() {

  let matchesByLeague = {};

  for (const lg of LEAGUES) {

    const res = await fetch(BASE_URL + lg.slug);
    const json = await res.json();

    const played = [];
    const upcoming = [];

    json.forEach(r => {
      const finished = r.HomeTeamScore !== null && r.AwayTeamScore !== null;

      const m = {
        home: r.HomeTeam,
        away: r.AwayTeam,
        hg: r.HomeTeamScore,
        ag: r.AwayTeamScore
      };

      if (finished) played.push(m);
      else upcoming.push(m);
    });

    let matches = [];

    upcoming.slice(0, 10).forEach(m => {

      const h = getStats(m.home, played);
      const a = getStats(m.away, played);

      const lambdaH = (h.gf + a.ga) / 2;
      const lambdaA = (a.gf + h.ga) / 2;

      const res = calculateBets(lambdaH, lambdaA);

      matches.push({
        home: m.home,
        away: m.away,
        bets: res.topBets,
        scores: res.scores
      });

    });

    matchesByLeague[lg.name] = matches;
  }

  return matchesByLeague;
}

// =============================
// ✅ MESSAGGIO TIPSTER
// =============================
function buildMessage(data) {

  let all = [];
  Object.values(data).forEach(arr => all = all.concat(arr));

  all.sort((a, b) => b.bets[0].pct - a.bets[0].pct);
  const top10 = all.slice(0, 10);

  let msg = "🔥🔥 TOP 10 VALUE PICKS 🔥🔥\n\n";

  top10.forEach((m, i) => {
    msg += `${i + 1}) ${m.home} - ${m.away}\n`;
    msg += `${icon(m.bets[0].pct)} ${m.bets[0].label} (${(m.bets[0].pct * 100).toFixed(0)}%)\n`;
    msg += `${icon(m.bets[1].pct)} ${m.bets[1].label} (${(m.bets[1].pct * 100).toFixed(0)}%)\n\n`;
  });

  msg += "----------------------------------\n\n";

  for (const lg in data) {
    msg += `📊 ${lg}\n\n`;

    data[lg].forEach(m => {
      msg += `🔸 ${m.home} - ${m.away}\n`;
      msg += `👉 ${m.bets[0].label} | ${m.bets[1].label}\n`;
      msg += `🎯 ${m.scores[0].score} / ${m.scores[1].score}\n\n`;
    });

    msg += "----------------------------------\n\n";
  }

  msg += "⚠️ Modello Poisson\n📈 Solo scopo informativo";

  if (msg.length > 3500) msg = msg.substring(0, 3500);

  return msg;
}

// =============================
// ✅ HANDLE UTENTE
// =============================
async function handleUpdate(update) {

  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (text === "/start") {
    await sendMessage(chatId, welcomeText(), buildMenu());
  }

  if (text.includes("TOP")) {
    await sendMessage(chatId, "✅ Riceverai TOP 10 globali");
  }

  if (text.includes("Serie A")) {
    await sendMessage(chatId, "✅ Solo Serie A selezionata");
  }

  if (text.includes("Premier")) {
    await sendMessage(chatId, "✅ Solo Premier League");
  }

  if (text.includes("Liga")) {
    await sendMessage(chatId, "✅ Solo La Liga");
  }

  if (text.includes("Bundesliga")) {
    await sendMessage(chatId, "✅ Solo Bundesliga");
  }

  if (text.includes("Ligue")) {
    await sendMessage(chatId, "✅ Solo Ligue 1");
  }

  if (text.includes("Eredivisie")) {
    await sendMessage(chatId, "✅ Solo Eredivisie");
  }

  if (text.includes("Tutto")) {
    await sendMessage(chatId, "✅ Riceverai tutto");
  }
}

// =============================
// ✅ LISTEN (solo locale)
// =============================
async function listen() {
  let offset = 0;

  while (true) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}`);
    const data = await res.json();

    for (const update of data.result) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// =============================
// ✅ RUN (GitHub)
// =============================
async function run() {
  const data = await loadData();
  const msg = buildMessage(data);
  await sendMessage(CHAT_ID, msg);
}

// =============================
// ✅ AVVIO
// =============================

if (process.env.RUN_LISTENER === "true") {
  listen();
} else {
  run();
}
