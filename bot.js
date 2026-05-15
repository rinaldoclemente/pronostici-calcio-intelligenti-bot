// =============================
// 🤖 TELEGRAM TIPSTER BOT
// =============================

const TOKEN = process.env.BOT_TOKEN;

// ✅ QUI INSERISCI I CHAT ID
const USERS = [
  123456789,  // 👈 tuo chat id
  987654321   // 👈 chat id amici
];

// =============================
// ✅ INVIO MESSAGGIO A TUTTI
// =============================
async function sendToAll(text) {

  for (const chatId of USERS) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      });

      console.log("✅ Inviato a:", chatId);

    } catch (err) {
      console.log("❌ Errore invio a:", chatId);
    }
  }
}

// =============================
// ✅ DATI CAMPIONATI
// =============================
const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", slug: "epl-2025" },
  { name: "BUNDESLIGA", slug: "bundesliga-2025" },
  { name: "LA LIGA", slug: "la-liga-2025" },
  { name: "LIGUE 1", slug: "ligue-1-2025" },
  { name: "EREDIVISIE", slug: "eredivisie-2025" }
];

// =============================
// ✅ POISSON
// =============================
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
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
// ✅ CALCOLO PRONOSTICI
// =============================
function calculate(lambdaH, lambdaA) {

  let pH = 0, pD = 0, pA = 0;
  let over25 = 0;

  let scores = [];

  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {

      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      scores.push({ score: `${i}-${j}`, p });

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      if (i + j > 2) over25 += p;
    }
  }

  scores.sort((a, b) => b.p - a.p);

  const bets = [
    { label: "1X", pct: pH + pD },
    { label: "X2", pct: pD + pA },
    { label: "OVER 2.5", pct: over25 }
  ];

  bets.sort((a, b) => b.pct - a.pct);

  return {
    bets: bets.slice(0, 2),
    scores: scores.slice(0, 2)
  };
}

// =============================
// ✅ CARICA DATI
// =============================
async function loadData() {

  let allMatches = [];

  for (const lg of LEAGUES) {

    const res = await fetch(BASE_URL + lg.slug);
    const json = await res.json();

    const played = [];
    const upcoming = [];

    json.forEach(r => {
      if (r.HomeTeamScore !== null) {
        played.push({
          home: r.HomeTeam,
          away: r.AwayTeam,
          hg: r.HomeTeamScore,
          ag: r.AwayTeamScore
        });
      } else {
        upcoming.push(r);
      }
    });

    upcoming.slice(0, 5).forEach(m => {

      const h = getStats(m.HomeTeam, played);
      const a = getStats(m.AwayTeam, played);

      const lambdaH = (h.gf + a.ga) / 2;
      const lambdaA = (a.gf + h.ga) / 2;

      const res = calculate(lambdaH, lambdaA);

      allMatches.push({
        home: m.HomeTeam,
        away: m.AwayTeam,
        ...res
      });
    });
  }

  return allMatches;
}

// =============================
// ✅ COSTRUZIONE MESSAGGIO
// =============================
function buildMessage(matches) {

  matches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top10 = matches.slice(0, 10);

  let msg = "🔥🔥 TOP 10 PRONOSTICI 🔥🔥\n\n";

  top10.forEach((m, i) => {
    msg += `${i + 1}) ${m.home} - ${m.away}\n`;
    msg += `${m.bets[0].label} - ${m.bets[1].label}\n\n`;
  });

  msg += "📊 Altre partite\n\n";

  matches.slice(0, 15).forEach(m => {
    msg += `${m.home} - ${m.away}\n`;
    msg += `${m.bets[0].label} / ${m.bets[1].label}\n\n`;
  });

  // limite telegram
  if (msg.length > 3500) {
    msg = msg.substring(0, 3500);
  }

  return msg;
}

// =============================
// ✅ MAIN
// =============================
async function run() {

  console.log("🚀 BOT PARTITO");

  const data = await loadData();

  if (data.length === 0) {
    await sendToAll("⚠️ Nessuna partita trovata");
    return;
  }

  const message = buildMessage(data);

  await sendToAll(message);
}

run();
``
