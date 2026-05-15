import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";

// =============================
// ✅ UTENTI
// =============================
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  for (const id of users) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
// ✅ STATS
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
  let over15 = 0, over25 = 0;
  let under25 = 0, under35 = 0;
  let btts = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {

      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      if (i + j > 1) over15 += p;
      if (i + j > 2) over25 += p;

      if (i + j < 3) under25 += p;
      if (i + j < 4) under35 += p;

      if (i > 0 && j > 0) btts += p;
    }
  }

  const base = {
    "1": pH,
    "X": pD,
    "2": pA,
    "1X": pH + pD,
    "X2": pD + pA,
    "O1.5": over15,
    "O2.5": over25,
    "U2.5": under25,
    "U3.5": under35,
    "BTTS": btts
  };

  let bets = [];

  // ✅ SINGLE
  Object.entries(base).forEach(([label, pct]) => {
    bets.push({ label, pct });
  });

  // ✅ COMBO CORRETTE

  // 1X2 + Over/Under
  ["1","X","2"].forEach(r => {
    ["O1.5","O2.5","U2.5","U3.5"].forEach(t => {
      bets.push({
        label: `${r} + ${t}`,
        pct: base[r] * base[t]
      });
    });
  });

  // Double chance + Over/Under
  ["1X","X2"].forEach(dc => {
    ["O1.5","O2.5","U2.5","U3.5"].forEach(t => {
      bets.push({
        label: `${dc} + ${t}`,
        pct: base[dc] * base[t]
      });
    });
  });

  // BTTS + Over
  ["O1.5","O2.5"].forEach(t => {
    bets.push({
      label: `BTTS + ${t}`,
      pct: base["BTTS"] * base[t]
    });
  });

  // ✅ filtro qualità
  bets = bets.filter(b => b.pct > 0.40 && b.pct < 0.85);

  bets.sort((a, b) => b.pct - a.pct);

  // ✅ 3 livelli
  let safe = bets.find(b => b.pct >= 0.70);
  let mid  = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  let risk = bets.find(b => b.pct < 0.55);

  let result = [];

  if (safe) result.push(safe);
  if (mid) result.push(mid);
  if (risk) result.push(risk);

  for (let i = 0; i < bets.length && result.length < 3; i++) {
    if (!result.includes(bets[i])) result.push(bets[i]);
  }

  return result.slice(0, 3);
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

      matches.push({
        league: lg.name,
        home: m.HomeTeam,
        away: m.AwayTeam,
        bets
      });
    });
  }

  return matches;
}

// =============================
// ✅ MESSAGGIO TIPSTER
// =============================
function buildMessage(matches) {

  matches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top10 = matches.slice(0, 10);

  let msg = "🔥 TOP 10 VALUE PICKS 🔥\n\n";

  // ✅ NO NUMERI
  top10.forEach(m => {
    msg += `${m.home} - ${m.away}\n`;
    msg += `✅ ${m.bets[0].label}\n`;
    msg += `⚖️ ${m.bets[1].label}\n`;
    msg += `🔥 ${m.bets[2].label}\n\n`;
  });

  msg += "━━━━━━━━━━━━━━━\n";

  const leaguesMap = {};
  matches.forEach(m => {
    if (!leaguesMap[m.league]) leaguesMap[m.league] = [];
    leaguesMap[m.league].push(m);
  });

  for (const lg in leaguesMap) {

    msg += `\n📊 ${lg}\n\n`;

    leaguesMap[lg].forEach(m => {
      msg += `${m.home}-${m.away} → `;
      msg += `${m.bets[0].label} | ${m.bets[1].label} | ${m.bets[2].label}\n`;
    });
  }

  msg += "\n━━━━━━━━━━━━━━━\n";
  msg += "🎯 Strategia: mix tra safe, equilibrati e value\n";

  if (msg.length > 3500) {
    msg = msg.substring(0, 3500);
  }

  return msg;
}

// =============================
// ✅ MAIN
// =============================
async function run() {

  const matches = await loadData();

  if (matches.length === 0) {
    await sendToAll("⚠️ Nessuna partita trovata");
    return;
  }

  const msg = buildMessage(matches);

  await sendToAll(msg);
}

run();
