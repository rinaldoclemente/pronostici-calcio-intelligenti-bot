import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante. Configuralo nei GitHub Secrets.");
  process.exit(1);
}

const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", flag: "🏴", slug: "epl-2025" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga-2025" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga-2025" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1-2025" },
  { name: "EREDIVISIE", flag: "🇳🇱", slug: "eredivisie-2025" }
];

const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";
const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";

const TELEGRAM_LIMIT = 3000;
const MESSAGE_DELAY_MS = Number(process.env.MESSAGE_DELAY_MS || 2500);
const FETCH_TIMEOUT_MS = 15000;
const TELEGRAM_TIMEOUT_MS = 20000;

// ======================================================
// USERS
// ======================================================
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);

    if (!Array.isArray(users)) {
      console.error("❌ users.json deve essere un array.");
      return [];
    }

    return users.map(String).filter(Boolean);
  } catch (err) {
    console.error("❌ Errore lettura users.json:", err.message);
    return [];
  }
}

// ======================================================
// UTILS
// ======================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseDateValue(value) {
  if (!value) return null;

  let s = String(value).trim().replace(" ", "T");

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

function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (!text) return [""];
  if (text.length <= limit) return [text];

  const parts = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < 800) cut = rest.lastIndexOf("\n", limit);
    if (cut < 800) cut = rest.lastIndexOf(" ", limit);
    if (cut < 800) cut = limit;

    const part = rest.slice(0, cut).trim();
    if (part.length) parts.push(part);

    rest = rest.slice(cut).trim();
  }

  if (rest.length) parts.push(rest);
  return parts;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// TELEGRAM
// ======================================================
function extractRetryAfter(bodyText) {
  try {
    const json = JSON.parse(bodyText);
    return json?.parameters?.retry_after
      ? Number(json.parameters.retry_after)
      : null;
  } catch {
    return null;
  }
}

async function sendTelegramRaw(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    },
    TELEGRAM_TIMEOUT_MS
  );

  const body = await res.text();
  console.log(`📨 Telegram response ${chatId}: ${body}`);

  if (!res.ok) {
    const err = new Error(`Telegram ${res.status}: ${body}`);
    err.status = res.status;
    err.body = body;
    err.retryAfter = extractRetryAfter(body);
    throw err;
  }

  return body;
}

async function sendTelegramWithRetry(chatId, text, label = "messaggio") {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`📤 Invio "${label}" a ${chatId}, tentativo ${attempt}`);
      await sendTelegramRaw(chatId, text);
      return true;
    } catch (err) {
      console.error(`❌ Errore invio "${label}" a ${chatId}:`, err.message);

      if (err.status === 429) {
        const waitSec = err.retryAfter || 10;
        console.log(`⏳ Rate limit Telegram. Attendo ${waitSec + 2}s...`);
        await sleep((waitSec + 2) * 1000);
        continue;
      }

      if (attempt < maxAttempts) {
        const wait = 3000 * attempt;
        console.log(`⏳ Riprovo tra ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      return false;
    }
  }

  return false;
}

async function sendOneLogicalMessage(chatId, text, title) {
  const chunks = splitMessage(text);
  console.log(`📦 "${title}" diviso in ${chunks.length} parte/i`);

  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const prefix =
      chunks.length > 1
        ? `📄 ${title} — Parte ${i + 1}/${chunks.length}\n\n`
        : "";

    const ok = await sendTelegramWithRetry(
      chatId,
      prefix + chunks[i],
      `${title} parte ${i + 1}/${chunks.length}`
    );

    if (!ok) allOk = false;
    await sleep(MESSAGE_DELAY_MS);
  }

  return allOk;
}

async function broadcastAllMessages(messages) {
  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente in users.json.");
    return;
  }

  console.log(`👥 Utenti: ${users.length}`);
  console.log(`📨 Messaggi da inviare a ogni utente: ${messages.length}`);

  for (const chatId of users) {
    console.log(`\n🚀 Inizio invio report a ${chatId}`);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      console.log(`➡️ Invio ${i + 1}/${messages.length}: ${msg.title}`);
      console.log(`📏 Lunghezza: ${msg.text.length} caratteri`);

      const ok = await sendOneLogicalMessage(chatId, msg.text, msg.title);

      if (!ok) {
        console.error(`⚠️ Invio non completato per: ${msg.title}`);
      }

      await sleep(MESSAGE_DELAY_MS);
    }

    console.log(`✅ Fine invio report a ${chatId}`);
  }
}

// ======================================================
// FETCH DATI CAMPIONATI
// ======================================================
async function fetchJsonWithTimeout(url) {
  const res = await fetchWithTimeout(
    url,
    {
      headers: { "User-Agent": "RinaldoScoutReportBot/1.0" }
    },
    FETCH_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

// ======================================================
// PARSE FIXTURES
// ======================================================
function parseFixtureData(json, league) {
  const played = [];

  for (const r of json) {
    if (!r.HomeTeam || !r.AwayTeam) continue;

    const hasScore =
      r.HomeTeamScore !== null &&
      r.HomeTeamScore !== undefined &&
      r.AwayTeamScore !== null &&
      r.AwayTeamScore !== undefined &&
      r.HomeTeamScore !== "" &&
      r.AwayTeamScore !== "";

    if (!hasScore) continue;

    played.push({
      league: league.name,
      flag: league.flag,
      slug: league.slug,
      round: Number(r.RoundNumber || 0),
      dateUtc: r.DateUtc || "",
      home: safeText(r.HomeTeam),
      away: safeText(r.AwayTeam),
      hg: Number(r.HomeTeamScore),
      ag: Number(r.AwayTeamScore)
    });
  }

  played.sort((a, b) => {
    const da = parseDateValue(a.dateUtc)?.getTime() || 0;
    const db = parseDateValue(b.dateUtc)?.getTime() || 0;
    return da - db;
  });

  return played;
}

// ======================================================
// MODELLO POISSON — stessa logica del bot venerdì
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
    h: homeGoals / played.length || 1.35,
    a: awayGoals / played.length || 1.05
  };
}

function teamStats(team, role, n, played) {
  const games = played
    .filter(m => {
      if (role === "home") return m.home === team;
      if (role === "away") return m.away === team;
      return m.home === team || m.away === team;
    })
    .slice(-n);

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
  const homeAvg = av.h || 1.35;
  const awayAvg = av.a || 1.05;

  const lambdaHomeRaw = Math.max(
    0.2,
    (sH.gf / homeAvg) * (sA.ga / awayAvg) * homeAvg
  );

  const lambdaAwayRaw = Math.max(
    0.2,
    (sA.gf / awayAvg) * (sH.ga / homeAvg) * awayAvg
  );

  const adjustByPoints = p => {
    return (p / 3 - 0.333) * 0.18 + 1;
  };

  const lambdaH = Math.max(0.1, lambdaHomeRaw * adjustByPoints(sH.pts));
  const lambdaA = Math.max(0.1, lambdaAwayRaw * adjustByPoints(sA.pts));

  const maxGoals = 6;
  const matrix = [];

  let pH = 0;
  let pD = 0;
  let pA = 0;
  let mass = 0;

  for (let i = 0; i <= maxGoals; i++) {
    matrix[i] = [];

    for (let j = 0; j <= maxGoals; j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      matrix[i][j] = p;
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
    matrix,
    mass
  };
}

function calcQuota(pct) {
  if (!pct || pct <= 2) return null;

  const raw = 1 / (pct / 100);

  let margin;
  if (raw < 1.5) margin = 0.06;
  else if (raw < 2.5) margin = 0.08;
  else if (raw < 4) margin = 0.10;
  else margin = 0.12;

  return Math.max(
    1.01,
    Math.round(raw * (1 - margin) * 20) / 20
  );
}

function buildBets(home, away, res) {
  const sp = res.matrix;
  const maxG = 6;
  const mass = res.mass || 1;

  function acc(fn) {
    let sum = 0;

    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        if (fn(i, j)) sum += sp[i][j];
      }
    }

    return sum / mass;
  }

  const raw = [
    { label: "1", pct: res.pH },
    { label: "X", pct: res.pD },
    { label: "2", pct: res.pA },

    { label: "1X", pct: res.pH + res.pD },
    { label: "X2", pct: res.pD + res.pA },
    { label: "12", pct: res.pH + res.pA },

    { label: "Over 1.5", pct: acc((i, j) => i + j > 1) },
    { label: "Over 2.5", pct: acc((i, j) => i + j > 2) },
    { label: "Over 3.5", pct: acc((i, j) => i + j > 3) },

    { label: "Under 2.5", pct: acc((i, j) => i + j <= 2) },
    { label: "Under 3.5", pct: acc((i, j) => i + j <= 3) },

    { label: "BTTS Sì", pct: acc((i, j) => i > 0 && j > 0) },
    { label: "BTTS No", pct: acc((i, j) => !(i > 0 && j > 0)) },

    { label: `${home} segna`, pct: acc((i, j) => i >= 1) },
    { label: `${away} segna`, pct: acc((i, j) => j >= 1) },

    { label: "Multigol 1-3", pct: acc((i, j) => i + j >= 1 && i + j <= 3) },
    { label: "Multigol 2-3", pct: acc((i, j) => i + j >= 2 && i + j <= 3) },
    { label: "Multigol 1-4", pct: acc((i, j) => i + j >= 1 && i + j <= 4) },

    { label: "1 + Over 1.5", pct: acc((i, j) => i > j && i + j > 1) },
    { label: "1 + Over 2.5", pct: acc((i, j) => i > j && i + j > 2) },
    { label: "2 + Over 1.5", pct: acc((i, j) => j > i && i + j > 1) },
    { label: "2 + Over 2.5", pct: acc((i, j) => j > i && i + j > 2) },

    { label: "X + Under 2.5", pct: acc((i, j) => i === j && i + j <= 2) },
    { label: "BTTS + Over 2.5", pct: acc((i, j) => i > 0 && j > 0 && i + j > 2) },

    { label: "1X + Over 1.5", pct: acc((i, j) => i >= j && i + j > 1) },
    { label: "1X + Under 3.5", pct: acc((i, j) => i >= j && i + j <= 3) },
    { label: "X2 + Over 1.5", pct: acc((i, j) => j >= i && i + j > 1) },
    { label: "X2 + Under 3.5", pct: acc((i, j) => j >= i && i + j <= 3) }
  ];

  const bets = raw
    .map(b => {
      const pct = Math.round(b.pct * 100);
      return {
        label: b.label,
        pct,
        quota: calcQuota(pct)
      };
    })
    .filter(b => b.pct >= 40 && b.pct <= 88)
    .sort((a, b) => b.pct - a.pct);

  return selectThreeLevels(bets);
}

function selectThreeLevels(bets) {
  const result = [];

  const safe = bets.find(b => b.pct >= 70);
  const mid = bets.find(b => b.pct < 70 && b.pct >= 55);
  const value = bets.find(b => b.pct < 55 && b.pct >= 40);

  if (safe) result.push(safe);
  if (mid && !result.some(x => x.label === mid.label)) result.push(mid);
  if (value && !result.some(x => x.label === value.label)) result.push(value);

  for (const bet of bets) {
    if (result.length >= 3) break;
    if (!result.some(x => x.label === bet.label)) result.push(bet);
  }

  return result.slice(0, 3);
}

// ======================================================
// VERIFICA BET
// ======================================================
function checkBet(label, home, away, hg, ag) {
  const total = hg + ag;
  const btts = hg > 0 && ag > 0;

  if (label === "1") return hg > ag;
  if (label === "X") return hg === ag;
  if (label === "2") return ag > hg;

  if (label === "1X") return hg >= ag;
  if (label === "X2") return ag >= hg;
  if (label === "12") return hg !== ag;

  if (label === "Over 1.5") return total > 1;
  if (label === "Over 2.5") return total > 2;
  if (label === "Over 3.5") return total > 3;

  if (label === "Under 2.5") return total <= 2;
  if (label === "Under 3.5") return total <= 3;

  if (label === "BTTS Sì") return btts;
  if (label === "BTTS No") return !btts;

  if (label === `${home} segna`) return hg >= 1;
  if (label === `${away} segna`) return ag >= 1;

  if (label === "Multigol 1-3") return total >= 1 && total <= 3;
  if (label === "Multigol 2-3") return total >= 2 && total <= 3;
  if (label === "Multigol 1-4") return total >= 1 && total <= 4;

  if (label === "1 + Over 1.5") return hg > ag && total > 1;
  if (label === "1 + Over 2.5") return hg > ag && total > 2;

  if (label === "2 + Over 1.5") return ag > hg && total > 1;
  if (label === "2 + Over 2.5") return ag > hg && total > 2;

  if (label === "X + Under 2.5") return hg === ag && total <= 2;
  if (label === "BTTS + Over 2.5") return btts && total > 2;

  if (label === "1X + Over 1.5") return hg >= ag && total > 1;
  if (label === "1X + Under 3.5") return hg >= ag && total <= 3;

  if (label === "X2 + Over 1.5") return ag >= hg && total > 1;
  if (label === "X2 + Under 3.5") return ag >= hg && total <= 3;

  return null;
}

// ======================================================
// ANALISI REPORT
// ======================================================
function emptyStats() {
  return {
    safe: { ok: 0, tot: 0 },
    balanced: { ok: 0, tot: 0 },
    value: { ok: 0, tot: 0 },
    total: { ok: 0, tot: 0 }
  };
}

function addStat(stats, level, outcome) {
  if (outcome === null || outcome === undefined) return;

  stats[level].tot++;
  stats.total.tot++;

  if (outcome) {
    stats[level].ok++;
    stats.total.ok++;
  }
}

function pct(ok, tot) {
  if (!tot) return 0;
  return Math.round((ok / tot) * 100);
}

function statsLine(icon, label, s) {
  return `${icon} ${label}: ${s.ok}/${s.tot} — ${pct(s.ok, s.tot)}%`;
}

function formatStatsBlock(stats) {
  return [
    statsLine("✅", "Sicure", stats.safe),
    statsLine("⚖️", "Equilibrate", stats.balanced),
    statsLine("🔥", "Value", stats.value),
    statsLine("📌", "Totale", stats.total)
  ].join("\n");
}

function latestRoundMatches(played) {
  const valid = played.filter(m => Number.isFinite(m.round) && m.round > 0);

  if (!valid.length) return [];

  const maxRound = Math.max(...valid.map(m => m.round));
  return valid.filter(m => m.round === maxRound);
}

async function analyzeLeagueReport(league) {
  const result = {
    league,
    status: "pending",
    round: null,
    matches: [],
    stats: emptyStats(),
    error: null
  };

  try {
    console.log(`\n📥 Report: carico ${league.name}`);

    const json = await fetchJsonWithTimeout(BASE_URL + league.slug);

    if (!Array.isArray(json) || !json.length) {
      result.status = "empty";
      result.error = "Feed vuoto";
      return result;
    }

    const played = parseFixtureData(json, league);

    if (!played.length) {
      result.status = "no_played";
      result.error = "Nessuna partita giocata";
      return result;
    }

    const targetMatches = latestRoundMatches(played);

    if (!targetMatches.length) {
      result.status = "no_round";
      result.error = "Nessuna ultima giornata trovata";
      return result;
    }

    result.round = targetMatches[0]?.round || null;

    console.log(
      `🎯 ${league.name}: ultima giornata giocata=${result.round}, partite=${targetMatches.length}`
    );

    for (const m of targetMatches) {
      const matchDate = parseDateValue(m.dateUtc);

      const previousPlayed = played.filter(p => {
        if (p === m) return false;

        const pDate = parseDateValue(p.dateUtc);

        if (matchDate && pDate) {
          return pDate.getTime() < matchDate.getTime();
        }

        // fallback se mancano date: usa round precedente
        return p.round < m.round;
      });

      if (previousPlayed.length < 5) {
        console.log(`⚠️ Dati precedenti insufficienti: ${m.home} - ${m.away}`);
        continue;
      }

      const sH =
        teamStats(m.home, "home", TEAM_FORM_N, previousPlayed) ||
        teamStats(m.home, "both", TEAM_FORM_N, previousPlayed);

      const sA =
        teamStats(m.away, "away", TEAM_FORM_N, previousPlayed) ||
        teamStats(m.away, "both", TEAM_FORM_N, previousPlayed);

      if (!sH || !sA) {
        console.log(`⚠️ Stats insufficienti: ${m.home} - ${m.away}`);
        continue;
      }

      const av = leagueAverage(previousPlayed);
      const model = calculateMatch(sH, sA, av);
      const bets = buildBets(m.home, m.away, model);

      if (bets.length < 3) {
        console.log(`⚠️ Meno di 3 picks: ${m.home} - ${m.away}`);
        continue;
      }

      const levels = ["safe", "balanced", "value"];
      const icons = ["✅", "⚖️", "🔥"];

      const checkedBets = bets.slice(0, 3).map((bet, idx) => {
        const outcome = checkBet(bet.label, m.home, m.away, m.hg, m.ag);
        addStat(result.stats, levels[idx], outcome);

        return {
          ...bet,
          level: levels[idx],
          icon: icons[idx],
          outcome
        };
      });

      result.matches.push({
        ...m,
        bets: checkedBets,
        p1: Math.round(model.pH * 100),
        px: Math.round(model.pD * 100),
        p2: Math.round(model.pA * 100),
        xgHome: model.lambdaH,
        xgAway: model.lambdaA,
        topScore: `${m.hg}-${m.ag}`
      });
    }

    result.status = "ok";
    return result;
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    console.error(`❌ Report errore ${league.name}:`, err.message);
    return result;
  }
}

async function loadReportData() {
  const leagueResults = [];

  for (const league of LEAGUES) {
    const res = await analyzeLeagueReport(league);
    leagueResults.push(res);
    await sleep(500);
  }

  const allMatches = leagueResults.flatMap(r => r.matches);

  console.log(`\n📊 Report totale partite verificate: ${allMatches.length}`);

  return { leagueResults, allMatches };
}

// ======================================================
// MESSAGGI REPORT
// ======================================================
function resultIcon(outcome) {
  if (outcome === true) return "✓";
  if (outcome === false) return "✗";
  return "?";
}

function resultIconEmoji(outcome) {
  if (outcome === true) return "✅";
  if (outcome === false) return "❌";
  return "❔";
}

function buildTopStats(matches) {
  const stats = emptyStats();

  for (const m of matches) {
    const levels = ["safe", "balanced", "value"];

    m.bets.slice(0, 3).forEach((bet, idx) => {
      addStat(stats, levels[idx], bet.outcome);
    });
  }

  return stats;
}

function buildMainReportMessage(allMatches) {
  const sorted = [...allMatches].sort((a, b) => {
    const pa = a.bets?.[0]?.pct || 0;
    const pb = b.bets?.[0]?.pct || 0;
    return pb - pa;
  });

  const top = sorted.slice(0, TOP_LIMIT);
  const topStats = buildTopStats(top);

  let msg = "";

  msg += "📊 Report risultati — bilancio del weekend\n\n";
  msg += "Ho ricalcolato il modello sulla giornata appena giocata usando solo i dati disponibili prima di ogni partita.\n";
  msg += "Qui trovi quali picks sarebbero stati presi e la percentuale di riuscita.\n\n";

  msg += "📌 LEGENDA\n";
  msg += "✅ Sicura → primo pick del modello\n";
  msg += "⚖️ Equilibrata → secondo pick\n";
  msg += "🔥 Value → terzo pick, più aggressivo\n";
  msg += "✓ preso | ✗ non preso\n\n";

  msg += "━━━━━━━━━━━━━━━\n\n";
  msg += `🏆 TOP ${top.length} VALUE BET — RISULTATI\n\n`;
  msg += formatStatsBlock(topStats);
  msg += "\n\n";

  if (!top.length) {
    msg += "⚠️ Nessuna partita verificabile trovata.\n";
  }

  for (const m of top) {
    const date = formatDateIT(m.dateUtc);

    msg += `${m.flag} ${m.home} - ${m.away} ${m.hg}-${m.ag}\n`;
    if (date) msg += `🗓 ${date}\n`;

    for (const bet of m.bets.slice(0, 3)) {
      msg += `${bet.icon} ${bet.label} ${resultIcon(bet.outcome)}\n`;
    }

    if (SHOW_NUMBERS) {
      msg += `📈 1X2 stimato: 1 ${m.p1}% · X ${m.px}% · 2 ${m.p2}%\n`;
      msg += `⚽ xG stimati: ${m.xgHome.toFixed(2)} - ${m.xgAway.toFixed(2)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "⚠️ Report statistico automatico: misura affidabilità del modello, non garantisce esiti futuri.";

  return msg;
}

function buildLeagueReportMessage(leagueResult) {
  const { league, matches, stats, status, round, error } = leagueResult;

  let msg = "";

  msg += `${league.flag} ${league.name} — report risultati`;
  if (round) msg += ` G${round}`;
  msg += "\n\n";

  if (!matches.length) {
    msg += "⚠️ Nessuna partita verificabile per questo campionato.\n";
    msg += `Stato: ${status}\n`;
    if (error) msg += `Motivo: ${error}\n`;
    return msg;
  }

  msg += formatStatsBlock(stats);
  msg += "\n\n";
  msg += "━━━━━━━━━━━━━━━\n\n";

  const sorted = [...matches].sort((a, b) => {
    const da = parseDateValue(a.dateUtc)?.getTime() || 0;
    const db = parseDateValue(b.dateUtc)?.getTime() || 0;
    return da - db;
  });

  for (const m of sorted) {
    const date = formatDateIT(m.dateUtc);

    msg += `⚽ ${m.home} - ${m.away} ${m.hg}-${m.ag}\n`;
    if (date) msg += `🗓 ${date}\n`;

    for (const bet of m.bets.slice(0, 3)) {
      msg += `${bet.icon} ${bet.label} ${resultIconEmoji(bet.outcome)}\n`;
    }

    if (SHOW_NUMBERS) {
      msg += `📈 1X2: 1 ${m.p1}% · X ${m.px}% · 2 ${m.p2}%\n`;
      msg += `⚽ xG: ${m.xgHome.toFixed(2)} - ${m.xgAway.toFixed(2)}\n`;
    }

    msg += "\n";
  }

  msg += "⚠️ Verifica automatica su ultima giornata giocata.";

  return msg;
}

function buildSummaryReportMessage(leagueResults) {
  const global = emptyStats();

  for (const lr of leagueResults) {
    for (const k of ["safe", "balanced", "value", "total"]) {
      global[k].ok += lr.stats[k].ok;
      global[k].tot += lr.stats[k].tot;
    }
  }

  let msg = "";

  msg += "📋 Riepilogo affidabilità modello\n\n";
  msg += formatStatsBlock(global);
  msg += "\n\n";
  msg += "━━━━━━━━━━━━━━━\n\n";

  for (const lr of leagueResults) {
    const total = lr.stats.total;
    const icon = total.tot ? "✅" : "⚠️";
    msg += `${icon} ${lr.league.flag} ${lr.league.name}: ${total.ok}/${total.tot} — ${pct(total.ok, total.tot)}%`;
    if (!total.tot && lr.error) msg += ` (${lr.error})`;
    msg += "\n";
  }

  return msg;
}

function buildAllReportMessages(leagueResults, allMatches) {
  const messages = [];

  messages.push({
    title: "REPORT TOP 10",
    text: buildMainReportMessage(allMatches)
  });

  for (const league of LEAGUES) {
    const lr = leagueResults.find(x => x.league.slug === league.slug);

    if (!lr) {
      messages.push({
        title: league.name,
        text: `${league.flag} ${league.name} — report risultati\n\n⚠️ Campionato non processato.`
      });
      continue;
    }

    messages.push({
      title: `${league.name} REPORT`,
      text: buildLeagueReportMessage(lr)
    });
  }

  messages.push({
    title: "RIEPILOGO REPORT",
    text: buildSummaryReportMessage(leagueResults)
  });

  return messages;
}

// ======================================================
// MAIN
// ======================================================
async function main() {
  console.log("🚀 Avvio report mercoledì GitHub Actions");

  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente trovato in users.json.");
    return;
  }

  console.log(`👥 Utenti destinatari: ${users.length}`);

  const { leagueResults, allMatches } = await loadReportData();
  const messages = buildAllReportMessages(leagueResults, allMatches);

  console.log(`\n📦 Messaggi report generati: ${messages.length}`);
  messages.forEach((m, idx) => {
    console.log(`${idx + 1}. ${m.title} — ${m.text.length} caratteri`);
  });

  await broadcastAllMessages(messages);

  console.log("✅ Report completato");
}

main().catch(async err => {
  console.error("❌ Errore fatale report:", err);

  try {
    await broadcastAllMessages([
      {
        title: "ERRORE REPORT",
        text: "⚠️ Errore durante il report automatico dei risultati."
      }
    ]);
  } catch {}

  process.exit(1);
});
