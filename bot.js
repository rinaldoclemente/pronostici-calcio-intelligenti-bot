import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante. Imposta la variabile ambiente BOT_TOKEN.");
  process.exit(1);
}

const USERS_FILE = process.env.USERS_FILE || "users.json";

const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", flag: "🏴", slug: "epl-2025" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga-2025" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga-2025" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1-2025" },
  { name: "EREDIVISIE", flag: "🇳🇱", slug: "eredivisie-2025" }
];

// Invio automatico giornaliero
const ENABLE_SCHEDULE = process.env.ENABLE_SCHEDULE !== "false";
const RUN_ON_START = process.env.RUN_ON_START === "true";

// Ora locale Europe/Rome
const SCHEDULE_HOUR = Number(process.env.SCHEDULE_HOUR || 10);
const SCHEDULE_MINUTE = Number(process.env.SCHEDULE_MINUTE || 0);
const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";

// Se true mostra percentuali e quota stimata.
// Default false per mantenere stile tipster pulito.
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";

// Numero massimo partite nel riepilogo top
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);

// Ultime N partite per statistiche squadra
const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);

// Admin opzionali per /run.
// Esempio env: ADMIN_IDS="123456,987654"
// Se vuoto, tutti gli utenti registrati possono usare /run.
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

// ======================================================
// UTENTI
// ======================================================
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function addUser(chatId) {
  const users = loadUsers();
  const id = String(chatId);

  if (!users.includes(id)) {
    users.push(id);
    saveUsers(users);
  }
}

function removeUser(chatId) {
  const id = String(chatId);
  const users = loadUsers().filter(x => x !== id);
  saveUsers(users);
}

function isAdmin(chatId) {
  if (!ADMIN_IDS.length) return true;
  return ADMIN_IDS.includes(String(chatId));
}

// ======================================================
// TELEGRAM API
// ======================================================
async function telegram(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram ${method} error: ${res.status} ${text}`);
  }

  return res.json();
}

function splitMessage(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  let rest = text;

  while (rest.length > maxLen) {
    let idx = rest.lastIndexOf("\n", maxLen);
    if (idx < 500) idx = maxLen;

    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx).trim();
  }

  if (rest.length) parts.push(rest);
  return parts;
}

async function sendMessage(chatId, text) {
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    });
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  if (!users.length) {
    console.log("ℹ️ Nessun utente registrato.");
    return;
  }

  for (const id of users) {
    try {
      await sendMessage(id, text);
      console.log(`✅ Messaggio inviato a ${id}`);
    } catch (err) {
      console.error(`❌ Errore invio a ${id}:`, err.message);
    }
  }
}

// ======================================================
// DATE UTILS
// ======================================================
function parseDateValue(value) {
  if (!value) return null;

  let s = String(value).trim();

  // Converte "YYYY-MM-DD HH:mm:ss" in ISO-like.
  s = s.replace(" ", "T");

  // Se non c'è timezone, assumiamo UTC perché il campo è DateUtc.
  const hasTimezone =
    s.endsWith("Z") ||
    /[+-]\d{2}:?\d{2}$/.test(s);

  if (!hasTimezone) s += "Z";

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateIT(dateUtc) {
  const d = parseDateValue(dateUtc);
  if (!d) return "";

  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function getLocalParts() {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const obj = {};
  for (const p of parts) {
    if (p.type !== "literal") obj[p.type] = p.value;
  }

  return {
    year: obj.year,
    month: obj.month,
    day: obj.day,
    hour: Number(obj.hour),
    minute: Number(obj.minute),
    key: `${obj.year}-${obj.month}-${obj.day}`
  };
}

// ======================================================
// FETCH CON TIMEOUT
// ======================================================
async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "RinaldoScoutBot/1.0"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ======================================================
// PARSING FIXTURES
// ======================================================
function parseFixtureData(json, league) {
  const played = [];
  const upcoming = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const r of json) {
    if (!r.HomeTeam || !r.AwayTeam) continue;

    const hasScore =
      r.HomeTeamScore !== null &&
      r.HomeTeamScore !== undefined &&
      r.AwayTeamScore !== null &&
      r.AwayTeamScore !== undefined &&
      r.HomeTeamScore !== "" &&
      r.AwayTeamScore !== "";

    const matchDate = parseDateValue(r.DateUtc);

    const match = {
      league: league.name,
      flag: league.flag,
      slug: league.slug,
      round: Number(r.RoundNumber || 0),
      dateUtc: r.DateUtc || "",
      home: r.HomeTeam,
      away: r.AwayTeam,
      hg: hasScore ? Number(r.HomeTeamScore) : null,
      ag: hasScore ? Number(r.AwayTeamScore) : null
    };

    if (hasScore) {
      played.push(match);
    } else {
      // Scarta partite senza risultato ma già passate.
      if (matchDate) {
        const onlyDate = new Date(matchDate);
        onlyDate.setHours(0, 0, 0, 0);

        if (onlyDate < today) continue;
      }

      upcoming.push(match);
    }
  }

  played.sort((a, b) => {
    const da = parseDateValue(a.dateUtc)?.getTime() || 0;
    const db = parseDateValue(b.dateUtc)?.getTime() || 0;
    return da - db;
  });

  upcoming.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;

    const da = parseDateValue(a.dateUtc)?.getTime() || 0;
    const db = parseDateValue(b.dateUtc)?.getTime() || 0;
    return da - db;
  });

  return { played, upcoming };
}

// ======================================================
// MODELLO STATISTICO
// ======================================================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) {
    fact *= i;
  }

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function leagueAverage(played) {
  if (!played || !played.length) {
    return { h: 1.35, a: 1.05 };
  }

  let homeGoals = 0;
  let awayGoals = 0;

  for (const m of played) {
    homeGoals += m.hg;
    awayGoals += m.ag;
  }

  return {
    h: homeGoals / played.length,
    a: awayGoals / played.length
  };
}

function teamStats(team, role, n, played) {
  const limit = Number(n) || 10;

  const games = played
    .filter(m => {
      if (role === "home") return m.home === team;
      if (role === "away") return m.away === team;
      return m.home === team || m.away === team;
    })
    .slice(-limit);

  if (!games.length) return null;

  let gf = 0;
  let ga = 0;
  let pts = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let cs = 0;
  let btts = 0;
  let o25 = 0;

  for (const m of games) {
    const isHome = m.home === team;
    const mygf = isHome ? m.hg : m.ag;
    const myga = isHome ? m.ag : m.hg;

    gf += mygf;
    ga += myga;

    if (mygf > myga) {
      pts += 3;
      wins++;
    } else if (mygf === myga) {
      pts += 1;
      draws++;
    } else {
      losses++;
    }

    if (myga === 0) cs++;
    if (mygf > 0 && myga > 0) btts++;
    if (mygf + myga > 2) o25++;
  }

  const total = games.length;

  return {
    n: total,
    gf: gf / total,
    ga: ga / total,
    pts: pts / total,
    wins: wins / total * 100,
    draws: draws / total * 100,
    losses: losses / total * 100,
    cs: cs / total * 100,
    btts: btts / total * 100,
    o25: o25 / total * 100
  };
}

function calculateMatch(sH, sA, av) {
  const safeHomeAvg = av.h || 1.35;
  const safeAwayAvg = av.a || 1.05;

  const lambdaHomeRaw = Math.max(
    0.2,
    (sH.gf / safeHomeAvg) * (sA.ga / safeAwayAvg) * safeHomeAvg
  );

  const lambdaAwayRaw = Math.max(
    0.2,
    (sA.gf / safeAwayAvg) * (sH.ga / safeHomeAvg) * safeAwayAvg
  );

  const adjustByPoints = p => {
    return (p / 3 - 0.333) * 0.18 + 1;
  };

  const lambdaH = Math.max(0.1, lambdaHomeRaw * adjustByPoints(sH.pts));
  const lambdaA = Math.max(0.1, lambdaAwayRaw * adjustByPoints(sA.pts));

  const maxGoals = 6;
  const scoreMatrix = [];

  let pH = 0;
  let pD = 0;
  let pA = 0;
  let mass = 0;

  for (let i = 0; i <= maxGoals; i++) {
    scoreMatrix[i] = [];

    for (let j = 0; j <= maxGoals; j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      scoreMatrix[i][j] = p;
      mass += p;

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
    }
  }

  const total = pH + pD + pA || 1;

  return {
    lambdaH,
    lambdaA,
    pH: pH / total,
    pD: pD / total,
    pA: pA / total,
    scoreMatrix,
    mass
  };
}

// ======================================================
// QUOTA STIMATA INTERNA
// ======================================================
function calcQuota(pct) {
  if (!pct || pct <= 2) return null;

  const raw = 1 / (pct / 100);

  let margin;
  if (raw < 1.5) margin = 0.06;
  else if (raw < 2.5) margin = 0.08;
  else if (raw < 4) margin = 0.10;
  else margin = 0.12;

  return Math.max(1.01, Math.round(raw * (1 - margin) * 20) / 20);
}

// ======================================================
// MERCATI
// ======================================================
function buildBets(home, away, res) {
  const sp = res.scoreMatrix;
  const maxG = 6;
  const mass = res.mass || 1;

  function accByCondition(fn) {
    let sum = 0;

    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        if (fn(i, j)) sum += sp[i][j];
      }
    }

    return sum / mass;
  }

  const pH = res.pH;
  const pD = res.pD;
  const pA = res.pA;

  const over15 = accByCondition((i, j) => i + j > 1);
  const over25 = accByCondition((i, j) => i + j > 2);
  const over35 = accByCondition((i, j) => i + j > 3);
  const under25 = accByCondition((i, j) => i + j <= 2);
  const under35 = accByCondition((i, j) => i + j <= 3);

  const btts = accByCondition((i, j) => i > 0 && j > 0);
  const noBtts = accByCondition((i, j) => !(i > 0 && j > 0));

  const homeScores = accByCondition((i, j) => i >= 1);
  const awayScores = accByCondition((i, j) => j >= 1);

  const homeCleanSheet = accByCondition((i, j) => j === 0);
  const awayCleanSheet = accByCondition((i, j) => i === 0);

  const mg13 = accByCondition((i, j) => i + j >= 1 && i + j <= 3);
  const mg23 = accByCondition((i, j) => i + j >= 2 && i + j <= 3);
  const mg14 = accByCondition((i, j) => i + j >= 1 && i + j <= 4);

  const homeWinOver15 = accByCondition((i, j) => i > j && i + j > 1);
  const homeWinOver25 = accByCondition((i, j) => i > j && i + j > 2);
  const awayWinOver15 = accByCondition((i, j) => j > i && i + j > 1);
  const awayWinOver25 = accByCondition((i, j) => j > i && i + j > 2);

  const drawUnder25 = accByCondition((i, j) => i === j && i + j <= 2);
  const bttsOver25 = accByCondition((i, j) => i > 0 && j > 0 && i + j > 2);

  const dc1xOver15 = accByCondition((i, j) => i >= j && i + j > 1);
  const dc1xUnder35 = accByCondition((i, j) => i >= j && i + j <= 3);
  const dcx2Over15 = accByCondition((i, j) => j >= i && i + j > 1);
  const dcx2Under35 = accByCondition((i, j) => j >= i && i + j <= 3);

  let bets = [
    { label: "1", pct: pH, cat: "1x2" },
    { label: "X", pct: pD, cat: "1x2" },
    { label: "2", pct: pA, cat: "1x2" },

    { label: "1X", pct: pH + pD, cat: "doppia" },
    { label: "X2", pct: pD + pA, cat: "doppia" },
    { label: "12", pct: pH + pA, cat: "doppia" },

    { label: "Over 1.5", pct: over15, cat: "gol" },
    { label: "Over 2.5", pct: over25, cat: "gol" },
    { label: "Over 3.5", pct: over35, cat: "gol" },
    { label: "Under 2.5", pct: under25, cat: "gol" },
    { label: "Under 3.5", pct: under35, cat: "gol" },

    { label: "BTTS Sì", pct: btts, cat: "btts" },
    { label: "BTTS No", pct: noBtts, cat: "btts" },

    { label: `${home} segna`, pct: homeScores, cat: "teamgoal" },
    { label: `${away} segna`, pct: awayScores, cat: "teamgoal" },
    { label: `${home} clean sheet`, pct: homeCleanSheet, cat: "teamgoal" },
    { label: `${away} clean sheet`, pct: awayCleanSheet, cat: "teamgoal" },

    { label: "Multigol 1-3", pct: mg13, cat: "multi" },
    { label: "Multigol 2-3", pct: mg23, cat: "multi" },
    { label: "Multigol 1-4", pct: mg14, cat: "multi" },

    { label: "1 + Over 1.5", pct: homeWinOver15, cat: "combo" },
    { label: "1 + Over 2.5", pct: homeWinOver25, cat: "combo" },
    { label: "2 + Over 1.5", pct: awayWinOver15, cat: "combo" },
    { label: "2 + Over 2.5", pct: awayWinOver25, cat: "combo" },
    { label: "X + Under 2.5", pct: drawUnder25, cat: "combo" },
    { label: "BTTS + Over 2.5", pct: bttsOver25, cat: "combo" },

    { label: "1X + Over 1.5", pct: dc1xOver15, cat: "combo" },
    { label: "1X + Under 3.5", pct: dc1xUnder35, cat: "combo" },
    { label: "X2 + Over 1.5", pct: dcx2Over15, cat: "combo" },
    { label: "X2 + Under 3.5", pct: dcx2Under35, cat: "combo" }
  ];

  bets = bets
    .map(b => {
      const pctInt = Math.round(b.pct * 100);

      return {
        ...b,
        pctValue: b.pct,
        pct: pctInt,
        quota: calcQuota(pctInt)
      };
    })
    // Evita mercati troppo bassi o troppo “scontati”
    .filter(b => b.pct >= 40 && b.pct <= 88)
    .sort((a, b) => b.pct - a.pct);

  return selectThreeLevels(bets);
}

function selectThreeLevels(bets) {
  const result = [];

  const safe = bets.find(b => b.pct >= 70);
  const mid = bets.find(b => b.pct < 70 && b.pct >= 55);
  const risk = bets.find(b => b.pct < 55 && b.pct >= 40);

  if (safe) result.push(safe);
  if (mid && !result.some(x => x.label === mid.label)) result.push(mid);
  if (risk && !result.some(x => x.label === risk.label)) result.push(risk);

  for (const bet of bets) {
    if (result.length >= 3) break;

    if (!result.some(x => x.label === bet.label)) {
      result.push(bet);
    }
  }

  return result.slice(0, 3);
}

// ======================================================
// LOAD DATI E GENERAZIONE ANALISI
// ======================================================
async function loadData() {
  const matches = [];

  for (const lg of LEAGUES) {
    try {
      console.log(`📥 Carico ${lg.name}...`);

      const json = await fetchJsonWithTimeout(BASE_URL + lg.slug);

      if (!Array.isArray(json) || !json.length) {
        console.warn(`⚠️ Dati vuoti per ${lg.name}`);
        continue;
      }

      const { played, upcoming } = parseFixtureData(json, lg);

      if (!played.length) {
        console.warn(`⚠️ Nessuna partita giocata per ${lg.name}`);
        continue;
      }

      if (!upcoming.length) {
        console.warn(`⚠️ Nessuna partita futura per ${lg.name}`);
        continue;
      }

      const av = leagueAverage(played);

      // Solo prossima giornata del campionato
      const nextRound = Math.min(
        ...upcoming
          .map(m => m.round || 999)
          .filter(Boolean)
      );

      const targetMatches = upcoming.filter(m => m.round === nextRound);

      for (const m of targetMatches) {
        const sH =
          teamStats(m.home, "home", TEAM_FORM_N, played) ||
          teamStats(m.home, "both", TEAM_FORM_N, played);

        const sA =
          teamStats(m.away, "away", TEAM_FORM_N, played) ||
          teamStats(m.away, "both", TEAM_FORM_N, played);

        if (!sH || !sA) continue;

        const resMatch = calculateMatch(sH, sA, av);
        const bets = buildBets(m.home, m.away, resMatch);

        if (!bets.length) continue;

        matches.push({
          league: lg.name,
          flag: lg.flag,
          round: m.round,
          dateUtc: m.dateUtc,
          home: m.home,
          away: m.away,
          xgHome: resMatch.lambdaH,
          xgAway: resMatch.lambdaA,
          p1: Math.round(resMatch.pH * 100),
          px: Math.round(resMatch.pD * 100),
          p2: Math.round(resMatch.pA * 100),
          bets
        });
      }

      console.log(`✅ ${lg.name}: ${targetMatches.length} partite analizzate`);
    } catch (err) {
      console.error(`❌ Errore ${lg.name}:`, err.message);
    }
  }

  return matches;
}

// ======================================================
// FORMAT MESSAGGIO
// ======================================================
function formatBet(bet) {
  if (!bet) return "-";

  if (!SHOW_NUMBERS) {
    return bet.label;
  }

  const quota = bet.quota ? ` · quota stimata ${bet.quota.toFixed(2)}` : "";
  return `${bet.label} · ${bet.pct}%${quota}`;
}

function buildMessage(matches) {
  matches.sort((a, b) => {
    const pa = a.bets?.[0]?.pct || 0;
    const pb = b.bets?.[0]?.pct || 0;
    return pb - pa;
  });

  const top = matches.slice(0, TOP_LIMIT);

  let msg = "";
  msg += "📊 RINALDO SCOUT — ANALISI CALCIO\n";
  msg += "━━━━━━━━━━━━━━━\n\n";

  msg += `🔥 TOP ${top.length} SCENARI STATISTICI\n\n`;

  for (const m of top) {
    const date = formatDateIT(m.dateUtc);

    msg += `${m.flag} ${m.home} - ${m.away}\n`;
    if (date) msg += `🗓 ${date}\n`;

    msg += `✅ ${formatBet(m.bets[0])}\n`;
    msg += `⚖️ ${formatBet(m.bets[1])}\n`;
    msg += `🔥 ${formatBet(m.bets[2])}\n`;

    if (SHOW_NUMBERS) {
      msg += `📈 1X2: 1 ${m.p1}% · X ${m.px}% · 2 ${m.p2}%\n`;
      msg += `⚽ xG: ${m.xgHome.toFixed(2)} - ${m.xgAway.toFixed(2)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";

  const leaguesMap = {};

  for (const m of matches) {
    if (!leaguesMap[m.league]) leaguesMap[m.league] = [];
    leaguesMap[m.league].push(m);
  }

  for (const leagueName of Object.keys(leaguesMap)) {
    const arr = leaguesMap[leagueName];
    const flag = arr[0]?.flag || "";

    msg += `\n${flag} ${leagueName}\n\n`;

    for (const m of arr) {
      msg += `${m.home}-${m.away} → `;
      msg += `${formatBet(m.bets[0])} | `;
      msg += `${formatBet(m.bets[1])} | `;
      msg += `${formatBet(m.bets[2])}\n`;
    }
  }

  msg += "\n━━━━━━━━━━━━━━━\n";
  msg += "🎯 Metodo: modello Poisson + forma casa/trasferta + media campionato\n";
  msg += "⚠️ Analisi statistica automatica a solo scopo informativo.";

  return msg;
}

// ======================================================
// RUN
// ======================================================
let isRunning = false;

async function run(reason = "manuale") {
  if (isRunning) {
    console.log("⏳ Run già in corso, salto.");
    return;
  }

  isRunning = true;

  try {
    console.log(`🚀 Avvio analisi: ${reason}`);

    const matches = await loadData();

    if (!matches.length) {
      await sendToAll("⚠️ Nessuna partita analizzabile trovata oggi.");
      return;
    }

    const msg = buildMessage(matches);

    await sendToAll(msg);

    console.log(`✅ Analisi completata. Partite: ${matches.length}`);
  } catch (err) {
    console.error("❌ Errore run:", err);

    await sendToAll(
      "⚠️ Errore durante il calcolo automatico delle analisi. Riproverò al prossimo ciclo."
    );
  } finally {
    isRunning = false;
  }
}

// ======================================================
// LONG POLLING TELEGRAM
// ======================================================
let offset = 0;

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  if (!text.startsWith("/")) return;

  if (text.startsWith("/start")) {
    addUser(chatId);

    await sendMessage(
      chatId,
      "✅ Sei registrato a Rinaldo Scout.\n\n" +
      "Riceverai automaticamente le analisi statistiche programmate.\n\n" +
      "Comandi disponibili:\n" +
      "/run — genera subito le analisi\n" +
      "/stop — disattiva gli invii\n" +
      "/help — mostra aiuto"
    );

    return;
  }

  if (text.startsWith("/stop")) {
    removeUser(chatId);

    await sendMessage(
      chatId,
      "🛑 Invii disattivati. Puoi riattivarli in qualsiasi momento con /start."
    );

    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(
      chatId,
      "📊 Rinaldo Scout — Bot Analisi Calcio\n\n" +
      "/start — registrati agli invii\n" +
      "/stop — disattiva gli invii\n" +
      "/run — genera subito le analisi\n\n" +
      "Le analisi sono basate su dati storici, modello Poisson e statistiche casa/trasferta.\n" +
      "Sono contenuti informativi, non consigli finanziari o di gioco."
    );

    return;
  }

  if (text.startsWith("/run")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ Non sei autorizzato a usare questo comando.");
      return;
    }

    await sendMessage(chatId, "⏳ Calcolo analisi in corso...");
    await run(`comando /run da ${chatId}`);

    return;
  }
}

async function pollTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TOKEN}/getUpdates`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getUpdates ${res.status}: ${body}`);
    }

    const data = await res.json();

    if (!data.ok) {
      throw new Error(`getUpdates not ok`);
    }

    for (const update of data.result) {
      offset = update.update_id + 1;

      try {
        await handleUpdate(update);
      } catch (err) {
        console.error("❌ Errore handleUpdate:", err.message);
      }
    }
  } catch (err) {
    console.error("❌ Polling error:", err.message);
    await sleep(3000);
  }

  setTimeout(pollTelegram, 500);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================================================
// SCHEDULER
// ======================================================
let lastRunKey = null;

function startScheduler() {
  if (!ENABLE_SCHEDULE) {
    console.log("ℹ️ Scheduler disattivato.");
    return;
  }

  console.log(
    `🕒 Scheduler attivo: ogni giorno alle ${String(SCHEDULE_HOUR).padStart(2, "0")}:${String(SCHEDULE_MINUTE).padStart(2, "0")} ${TIMEZONE}`
  );

  setInterval(async () => {
    const now = getLocalParts();

    if (
      now.hour === SCHEDULE_HOUR &&
      now.minute === SCHEDULE_MINUTE &&
      lastRunKey !== now.key
    ) {
      lastRunKey = now.key;
      await run("scheduler giornaliero");
    }
  }, 30_000);
}

// ======================================================
// START
// ======================================================
async function main() {
  console.log("🤖 Bot avviato.");
  console.log(`👥 Utenti registrati: ${loadUsers().length}`);
  console.log(`🔢 SHOW_NUMBERS: ${SHOW_NUMBERS ? "true" : "false"}`);

  pollTelegram();
  startScheduler();

  if (RUN_ON_START) {
    await run("startup");
  }
}

main();