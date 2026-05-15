import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";

// =============================
// ✅ CARICA UTENTI
// =============================
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

// =============================
// ✅ INVIO A TUTTI
// =============================
async function sendToAll(text) {

  const users = loadUsers();

  if (users.length === 0) {
    console.log("❌ Nessun utente");
    return;
  }

  for (const id of users) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: id,
        text
      })
    });
  }
}

// =============================
// ✅ CAMPIONATI
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

  if (games.length === 0) return { gf: 1.3, ga: 1.3 };

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

// =============================
// ✅ CALCOLO INTELLIGENTE
// =============================
function calculate(lambdaH, lambdaA) {

  let pH = 0, pD = 0, pA = 0;
  let over25 = 0, under35 = 0, btts = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {

      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      if (i + j > 2) over25 += p;
      if (i + j < 4) under35 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }

  let bets = [
    { label: "1X", pct: pH + pD },
    { label: "X2", pct: pD + pA },
    { label: "OVER 2.5", pct: over25 },
    { label: "BTTS", pct: btts },
    { label: "UNDER 3.5", pct: under35 }
  ];

  // ✅ filtro pronostici troppo facili (no value)
  bets = bets.filter(b => b.pct < 0.80);

  bets.sort((a, b) => b.pct - a.pct);

  return bets.slice(0, 2);
}

// =============================
// ✅ LOAD DATI
// =============================
async function loadData() {

  let matches = [];

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

      const bets = calculate(lambdaH, lambdaA);

      if (bets.length >= 2) {
        matches.push({
          league: lg.name,
          home: m.HomeTeam,
          away: m.AwayTeam,
          bets
        });
      }
    });
  }

  return matches;
}

// =============================
// ✅ ICONE TIPSTER
// =============================
function icon(pct) {
  if (pct >= 0.72) return "✅";   // sicuro
  if (pct >= 0.60) return "⚖️"; // equilibrato
  return "🔥";                  // value
}

// =============================
// ✅ MESSAGGIO PRO
// =============================
function buildMessage(matches) {

  matches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top10 = matches.slice(0, 10);

  let msg = "🔥 TOP 10 VALUE PICKS 🔥\n\n";

  top10.forEach((m, i) => {
    msg += `${i + 1}️⃣ ${m.home} - ${m.away}\n`;
    msg += `${icon(m.bets[0].pct)} ${m.bets[0].label}\n`;
    msg += `${icon(m.bets[1].pct)} ${m.bets[1].label}\n\n`;
  });

  msg += "━━━━━━━━━━━━━━━\n";

  // ✅ raggruppamento campionati
  const leaguesMap = {};
  matches.forEach(m => {
    if (!leaguesMap[m.league]) leaguesMap[m.league] = [];
    leaguesMap[m.league].push(m);
  });

  for (const lg in leaguesMap) {

    msg += `\n📊 ${lg}\n\n`;

    leaguesMap[lg].forEach(m => {

      const short1 = m.bets[0].label
        .replace("OVER 2.5","O2.5")
        .replace("UNDER 3.5","U3.5");

      const short2 = m.bets[1].label
        .replace("OVER 2.5","O2.5")
        .replace("UNDER 3.5","U3.5");

      msg += `${m.home}-${m.away} → ${short1} | ${short2}\n`;
    });
  }

  msg += "\n━━━━━━━━━━━━━━━\n";
  msg += "🎯 Strategia: mix tra safe e value picks\n";
  msg += "⚠️ Modello Poisson";

  return msg;
}

// =============================
// ✅ MAIN
// =============================
async function run() {

  const data = await loadData();

  if (data.length === 0) {
    await sendToAll("⚠️ Nessuna partita trovata");
    return;
  }

  const message = buildMessage(data);

  await sendToAll(message);
}

run();
