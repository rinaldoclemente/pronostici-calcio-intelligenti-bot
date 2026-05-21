import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante");
  process.exit(1);
}

const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", flag: "🏴", slug: "epl-2025" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga-2025" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga-2025" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1-2025" }
];

// ======================================================
// USERS
// ======================================================
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

// ======================================================
// TELEGRAM
// ======================================================
async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  const body = await res.text();
  console.log("Response:", body);

  if (!res.ok) {
    throw new Error(body);
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  for (const id of users) {
    try {
      await sendTelegram(id, text);
      console.log("✅ Inviato a", id);
    } catch (err) {
      console.log("❌ Errore", id, err.message);
    }
  }
}

// ======================================================
// UTILS
// ======================================================
function parseDate(value) {
  if (!value) return null;

  let s = value.replace(" ", "T");

  if (!s.endsWith("Z")) s += "Z";

  return new Date(s);
}

// ======================================================
// POISSON
// ======================================================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) fact *= i;

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

// ======================================================
// STATS
// ======================================================
function leagueAvg(played) {
  let hg = 0;
  let ag = 0;

  played.forEach(m => {
    hg += m.hg;
    ag += m.ag;
  });

  return {
    h: hg / played.length || 1.3,
    a: ag / played.length || 1.1
  };
}

function teamStats(team, played) {
  const games = played.filter(m => m.home === team || m.away === team).slice(-10);

  if (!games.length) return { gf: 1.3, ga: 1.3, pts: 1 };

  let gf = 0, ga = 0, pts = 0;

  games.forEach(m => {
    const isHome = m.home === team;

    const gF = isHome ? m.hg : m.ag;
    const gA = isHome ? m.ag : m.hg;

    gf += gF;
    ga += gA;

    if (gF > gA) pts += 3;
    else if (gF === gA) pts += 1;
  });

  return {
    gf: gf / games.length,
    ga: ga / games.length,
    pts: pts / games.length
  };
}

// ======================================================
// MATCH MODEL
// ======================================================
function calculateMatch(sH, sA, av) {

  const lambdaH = Math.max(0.3, (sH.gf / av.h) * (sA.ga / av.a) * av.h);
  const lambdaA = Math.max(0.3, (sA.gf / av.a) * (sH.ga / av.h) * av.a);

  const max = 6;

  let pH = 0, pD = 0, pA = 0;
  let matrix = [];

  for (let i = 0; i <= max; i++) {
    matrix[i] = [];
    for (let j = 0; j <= max; j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);
      matrix[i][j] = p;

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
    }
  }

  return { pH, pD, pA, matrix };
}

// ======================================================
// BETS
// ======================================================
function buildBets(match, res) {
  const sp = res.matrix;
  let bets = [];

  let over25 = 0, btts = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = sp[i][j];

      if (i + j > 2) over25 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }

  bets.push({ label: "1X", pct: res.pH + res.pD });
  bets.push({ label: "Over 2.5", pct: over25 });
  bets.push({ label: "BTTS", pct: btts });
  bets.push({ label: "1 + Over 2.5", pct: res.pH * over25 });

  bets = bets.sort((a, b) => b.pct - a.pct);

  return bets.slice(0, 3);
}

// ======================================================
// LOAD DATA
// ======================================================
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
          hg: Number(r.HomeTeamScore),
          ag: Number(r.AwayTeamScore)
        });
      } else {
        upcoming.push(r);
      }
    });

    const av = leagueAvg(played);

    upcoming.slice(0, 5).forEach(m => {

      const h = teamStats(m.HomeTeam, played);
      const a = teamStats(m.AwayTeam, played);

      const resMatch = calculateMatch(h, a, av);
      const bets = buildBets(m, resMatch);

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

// ======================================================
// MESSAGGIO PRINCIPALE
// ======================================================
function buildMainMessage(matches) {

  matches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top = matches.slice(0, 10);

  let msg = "";

  msg += "🔥 ECCO LE MIGLIORI LETTURE DEL WEEKEND 🔥\n\n";

  msg += "Analisi basata su modello statistico + forma squadre.\n";
  msg += "Qui trovi le giocate con miglior valore.\n\n";

  msg += "✅ Sicura → alta probabilità\n";
  msg += "⚖️ Equilibrata → rischio controllato\n";
  msg += "🔥 Value → quota alta\n\n";

  msg += "━━━━━━━━━━━━━━━\n\n";

  top.forEach(m => {
    msg += `⚽ ${m.home} - ${m.away}\n`;
    msg += `✅ ${m.bets[0].label}\n`;
    msg += `⚖️ ${m.bets[1].label}\n`;
    msg += `🔥 ${m.bets[2].label}\n\n`;
  });

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "🎯 Gioca poche selezioni per massimizzare valore";

  return msg;
}

// ======================================================
// MESSAGGI PER CAMPIONATO
// ======================================================
function buildLeagueMessages(matches) {

  const map = {};

  matches.forEach(m => {
    if (!map[m.league]) map[m.league] = [];
    map[m.league].push(m);
  });

  const messages = [];

  for (const lg in map) {

    let msg = `📊 ${lg}\n\n`;

    map[lg].forEach(m => {
      msg += `⚽ ${m.home}-${m.away} → `;
      msg += `${m.bets[0].label} | `;
      msg += `${m.bets[1].label} | `;
      msg += `${m.bets[2].label}\n`;
    });

    messages.push(msg);
  }

  return messages;
}

// ======================================================
// MAIN
// ======================================================
async function main() {

  console.log("🚀 Avvio bot");

  const matches = await loadData();

  if (!matches.length) {
    await sendToAll("⚠️ Nessuna partita trovata");
    return;
  }

  // 1° messaggio
  const mainMsg = buildMainMessage(matches);
  await sendToAll(mainMsg);

  // messaggi campionati
  const leagueMsgs = buildLeagueMessages(matches);

  for (const m of leagueMsgs) {
    await sendToAll(m);
  }

  console.log("✅ Fine");
}

main().catch(console.error);
