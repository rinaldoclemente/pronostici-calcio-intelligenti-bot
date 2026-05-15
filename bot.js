import fs from "fs";
import { execSync } from "child_process";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const USERS_FILE = "users.json";

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
// ✅ USERS
// =============================

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

  // ✅ commit automatico GitHub
  try {
    execSync("git config user.name 'bot'");
    execSync("git config user.email 'bot@github.com'");
    execSync("git add users.json");
    execSync("git commit -m 'update users'");
    execSync("git push");
  } catch {
    console.log("Nessuna modifica da pushare");
  }
}

function addUser(id) {
  let users = loadUsers();

  if (!users.includes(id)) {
    users.push(id);
    saveUsers(users);
    console.log("✅ Nuovo utente:", id);
  }
}

// =============================
// ✅ SEND
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

async function sendToAll(text) {
  const users = loadUsers();

  for (const id of users) {
    try {
      await sendMessage(id, text);
    } catch {
      console.log("Errore invio a:", id);
    }
  }

  // fallback: manda sempre anche a te
  if (users.length === 0) {
    await sendMessage(CHAT_ID, "⚠️ Nessun utente registrato\n\n" + text);
  }
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
👋 Benvenuto in Pronostici Calcio Intelligenti

⚽ Analizzo le partite con modello Poisson

🔥 TOP 10 = migliori pronostici tra TUTTI i campionati

📩 Ogni venerdì alle 16 riceverai:
• TOP 10 globali
• Pronostici per partita
• Risultati esatti

👇 Scegli cosa ricevere
`;
}

// =============================
// ✅ LOGICA
// =============================
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function getStats(team, matches) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (games.length === 0) return { gf: 1.2, ga: 1.2 };

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

function calculate(lambdaH, lambdaA) {

  let pH = 0, pD = 0, pA = 0, over25 = 0;
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
// ✅ DATA
// =============================
async function loadData() {

  let all = [];

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

      all.push({
        home: m.HomeTeam,
        away: m.AwayTeam,
        ...res
      });
    });
  }

  return all;
}

// =============================
// ✅ MESSAGGIO
// =============================
function buildMessage(matches) {

  matches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top10 = matches.slice(0, 10);

  let msg = "🔥 TOP 10 PRONOSTICI\n\n";

  top10.forEach(m => {
    msg += `${m.home} - ${m.away}\n`;
    msg += `${m.bets[0].label} - ${m.bets[1].label}\n\n`;
  });

  return msg;
}

// =============================
// ✅ HANDLE
// =============================
async function handleUpdate(update) {

  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (text === "/start") {
    addUser(chatId);
    await sendMessage(chatId, welcomeText(), buildMenu());
  }
}

// =============================
// ✅ LISTENER
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
// ✅ RUN (cron)
// =============================
async function run() {
  const data = await loadData();
  const msg = buildMessage(data);
  await sendToAll(msg);
}

// =============================
// ✅ AVVIO
// =============================
if (process.env.RUN_LISTENER === "true") {
  listen();
} else {
  run();
}
