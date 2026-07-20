import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";
const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);

const MAX_GOALS = 10;
const TELEGRAM_LIMIT = 3000;
const MESSAGE_DELAY_MS = Number(process.env.MESSAGE_DELAY_MS || 2500);
const FETCH_TIMEOUT_MS = 15000;
const TELEGRAM_TIMEOUT_MS = 20000;

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a" },
  { name: "PREMIER LEAGUE", flag: "🇬🇧", slug: "epl" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1" },
  { name: "EREDIVISIE", flag: "🇳🇱", slug: "eredivisie" }
];

// ======================================================
// USERS
// ======================================================
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);

    if (!Array.isArray(users)) {
      console.error("users.json deve essere un array.");
      return [];
    }

    return users.map(String).filter(Boolean);
  } catch (err) {
    console.error("Errore lettura users.json:", err.message);
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

function average(values, fallback = 0) {
  if (!values.length) return fallback;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pct(ok, tot) {
  if (!tot) return 0;

  return Math.round((ok / tot) * 100);
}

function probabilityPct(value) {
  return `${Math.round(value * 100)}%`;
}

function pickLabel(bet) {
  if (!bet) return "N/D";

  if (!SHOW_NUMBERS) return bet.label;

  return `${bet.label} (${probabilityPct(bet.pct)})`;
}

function parseDateValue(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const raw = String(value).trim();

  if (!raw) return null;

  const direct = new Date(raw);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const italianDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);

  if (italianDateMatch) {
    const [, dd, mm, yyyy, hh = "12", min = "00"] = italianDateMatch;

    const parsed = new Date(
      `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${min}:00Z`
    );

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function getDateKeyInTimezone(date, timeZone = TIMEZONE) {
  if (!date || Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function getLocalDateInfo(date = new Date(), timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: weekdayMap[map.weekday]
  };
}

function getPreviousWeekendKeys(referenceDate = new Date()) {
  const info = getLocalDateInfo(referenceDate, TIMEZONE);

  const localMidnightAsUtc = Date.UTC(
    info.year,
    info.month - 1,
    info.day
  );

  const MS_DAY = 24 * 60 * 60 * 1000;

  const lastSunday = localMidnightAsUtc - info.weekday * MS_DAY;
  const lastSaturday = lastSunday - MS_DAY;

  const saturdayDate = new Date(lastSaturday);
  const sundayDate = new Date(lastSunday);

  const saturdayKey = saturdayDate.toISOString().split("T")[0];
  const sundayKey = sundayDate.toISOString().split("T")[0];

  return {
    saturdayKey,
    sundayKey,
    keys: new Set([saturdayKey, sundayKey])
  };
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

    if (part.length) {
      parts.push(part);
    }

    rest = rest.slice(cut).trim();
  }

  if (rest.length) {
    parts.push(rest);
  }

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

async function fetchJsonWithTimeout(url) {
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "RinaldoScoutReportBot/1.0"
      }
    },
    FETCH_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();

  if (!Array.isArray(json)) {
    return [];
  }

  return json;
}

function getSeasonYear(referenceDate = new Date()) {
  const info = getLocalDateInfo(referenceDate, TIMEZONE);

  return info.month >= 8 ? info.year : info.year - 1;
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
  if (!TOKEN) {
    throw new Error("BOT_TOKEN mancante.");
  }

  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    },
    TELEGRAM_TIMEOUT_MS
  );

  const body = await res.text();

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
      console.log(`Invio "${label}" a ${chatId}, tentativo ${attempt}`);
      await sendTelegramRaw(chatId, text);
      return true;
    } catch (err) {
      console.error(`Errore invio "${label}" a ${chatId}:`, err.message);

      if (err.status === 429) {
        const waitSec = err.retryAfter || 10;
        await sleep((waitSec + 2) * 1000);
        continue;
      }

      if (attempt < maxAttempts) {
        await sleep(3000 * attempt);
        continue;
      }

      return false;
    }
  }

  return false;
}

async function sendOneLogicalMessage(chatId, text, title) {
  const chunks = splitMessage(text);

  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const prefix =
      chunks.length > 1
        ? `📄 ${title} - Parte ${i + 1}/${chunks.length}\n\n`
        : "";

    const ok = await sendTelegramWithRetry(
      chatId,
      prefix + chunks[i],
      `${title} parte ${i + 1}/${chunks.length}`
    );

    if (!ok) {
      allOk = false;
    }

    await sleep(MESSAGE_DELAY_MS);
  }

  return allOk;
}

async function broadcastAllMessages(messages) {
  const users = loadUsers();

  if (!users.length) {
    console.log("Nessun utente in users.json.");
    return;
  }

  for (const chatId of users) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      await sendOneLogicalMessage(chatId, msg.text, msg.title);
      await sleep(MESSAGE_DELAY_MS);
    }
  }
}

// ======================================================
// PARSE FIXTURES
// ======================================================
function getMatchDateRaw(row) {
  return (
    row.DateUtc ||
    row.MatchDate ||
    row.Date ||
    row.DateTime ||
    row.UtcDate ||
    ""
  );
}

function hasScore(row) {
  return (
    row.HomeTeamScore !== null &&
    row.HomeTeamScore !== undefined &&
    row.HomeTeamScore !== "" &&
    row.AwayTeamScore !== null &&
    row.AwayTeamScore !== undefined &&
    row.AwayTeamScore !== ""
  );
}

function parseFixtureData(json, league) {
  const played = [];

  for (const row of json) {
    if (!row.HomeTeam || !row.AwayTeam) continue;
    if (!hasScore(row)) continue;

    const dateUtc = getMatchDateRaw(row);
    const parsedDate = parseDateValue(dateUtc);

    played.push({
      league: league.name,
      flag: league.flag,
      slug: league.slug,
      round: Number(row.RoundNumber || 0),
      dateUtc,
      parsedDate,
      home: safeText(row.HomeTeam),
      away: safeText(row.AwayTeam),
      hg: Number(row.HomeTeamScore),
      ag: Number(row.AwayTeamScore)
    });
  }

  played.sort((a, b) => {
    const da = a.parsedDate?.getTime() || 0;
    const db = b.parsedDate?.getTime() || 0;

    return da - db;
  });

  return played;
}

// ======================================================
// PROFILO SALVEZZA / NEOPROMOSSE
// ======================================================
function computeTeamTable(matches) {
  const teams = {};

  for (const m of matches) {
    if (!m.home || !m.away) continue;
    if (m.hg === null || m.ag === null) continue;

    if (!teams[m.home]) {
      teams[m.home] = {
        team: m.home,
        p: 0,
        gf: 0,
        ga: 0,
        pts: 0
      };
    }

    if (!teams[m.away]) {
      teams[m.away] = {
        team: m.away,
        p: 0,
        gf: 0,
        ga: 0,
        pts: 0
      };
    }

    teams[m.home].p += 1;
    teams[m.home].gf += m.hg;
    teams[m.home].ga += m.ag;

    teams[m.away].p += 1;
    teams[m.away].gf += m.ag;
    teams[m.away].ga += m.hg;

    if (m.hg > m.ag) {
      teams[m.home].pts += 3;
    } else if (m.hg < m.ag) {
      teams[m.away].pts += 3;
    } else {
      teams[m.home].pts += 1;
      teams[m.away].pts += 1;
    }
  }

  return Object.values(teams);
}

function computeSurvivalProfile(previousMatches) {
  const table = computeTeamTable(previousMatches);

  const ranked = table
    .filter(t => t.p > 0)
    .sort((a, b) => {
      const ppgA = a.pts / a.p;
      const ppgB = b.pts / b.p;

      return ppgA - ppgB;
    });

  if (!ranked.length) {
    return {
      gf: 1.0,
      ga: 1.65
    };
  }

  const bottomCount = Math.max(3, Math.ceil(ranked.length * 0.2));
  const bottomTeams = ranked.slice(0, bottomCount);

  const gf = average(bottomTeams.map(t => t.gf / t.p), 1.0);
  const ga = average(bottomTeams.map(t => t.ga / t.p), 1.65);

  return {
    gf: clamp(gf, 0.6, 1.3),
    ga: clamp(ga, 1.3, 2.2)
  };
}

// ======================================================
// STATISTICHE SQUADRA
// ======================================================
function getTeamGames(team, matches) {
  return matches
    .filter(m => m.home === team || m.away === team)
    .filter(m => m.hg !== null && m.ag !== null)
    .sort((a, b) => {
      const da = a.parsedDate?.getTime() || 0;
      const db = b.parsedDate?.getTime() || 0;

      return db - da;
    });
}

function getRawStats(team, games) {
  if (!games.length) return null;

  const gf = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.hg : m.ag);
  }, 0) / games.length;

  const ga = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.ag : m.hg);
  }, 0) / games.length;

  return {
    games: games.length,
    gf,
    ga
  };
}

function blendStats(primary, secondary, primaryWeight) {
  const w1 = clamp(primaryWeight, 0, 1);
  const w2 = 1 - w1;

  return {
    games: primary.games || 0,
    gf: primary.gf * w1 + secondary.gf * w2,
    ga: primary.ga * w1 + secondary.ga * w2
  };
}

function getStats(team, currentPlayedBeforeMatch, previousPlayed, survivalProfile) {
  const currentGames = getTeamGames(team, currentPlayedBeforeMatch).slice(0, TEAM_FORM_N);
  const previousGames = getTeamGames(team, previousPlayed);

  const currentStats = getRawStats(team, currentGames);
  const previousStats = getRawStats(team, previousGames);

  const fallback = {
    games: 0,
    gf: survivalProfile.gf,
    ga: survivalProfile.ga
  };

  if (!currentStats && !previousStats) {
    return {
      ...fallback,
      isPromoted: true
    };
  }

  if (!previousStats && currentStats) {
    const realWeight = clamp(currentStats.games / 6, 0.15, 1);

    return {
      ...blendStats(currentStats, fallback, realWeight),
      isPromoted: true
    };
  }

  if (previousStats && !currentStats) {
    return {
      ...previousStats,
      isPromoted: false
    };
  }

  const currentWeight = clamp(currentStats.games / 8, 0.25, 0.85);

  return {
    ...blendStats(currentStats, previousStats, currentWeight),
    isPromoted: false
  };
}

// ======================================================
// MODELLO POISSON
// ======================================================
function factorial(k) {
  let result = 1;

  for (let i = 2; i <= k; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, k) {
  const safeLambda = Math.max(0.1, lambda);

  return (Math.pow(safeLambda, k) * Math.exp(-safeLambda)) / factorial(k);
}

function calculateMarkets(lambdaH, lambdaA) {
  const markets = {
    "1": 0,
    "X": 0,
    "2": 0,
    "1X": 0,
    "X2": 0,
    "O1.5": 0,
    "O2.5": 0,
    "U2.5": 0,
    "U3.5": 0,
    "BTTS": 0,

    "1 + O1.5": 0,
    "1 + O2.5": 0,
    "1 + U2.5": 0,
    "1 + U3.5": 0,

    "X + O1.5": 0,
    "X + O2.5": 0,
    "X + U2.5": 0,
    "X + U3.5": 0,

    "2 + O1.5": 0,
    "2 + O2.5": 0,
    "2 + U2.5": 0,
    "2 + U3.5": 0,

    "1X + O1.5": 0,
    "1X + O2.5": 0,
    "1X + U2.5": 0,
    "1X + U3.5": 0,

    "X2 + O1.5": 0,
    "X2 + O2.5": 0,
    "X2 + U2.5": 0,
    "X2 + U3.5": 0,

    "BTTS + O1.5": 0,
    "BTTS + O2.5": 0
  };

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poisson(lambdaH, h) * poisson(lambdaA, a);
      const total = h + a;

      const homeWin = h > a;
      const draw = h === a;
      const awayWin = h < a;
      const oneX = homeWin || draw;
      const x2 = draw || awayWin;
      const over15 = total > 1;
      const over25 = total > 2;
      const under25 = total < 3;
      const under35 = total < 4;
      const btts = h > 0 && a > 0;

      if (homeWin) markets["1"] += p;
      if (draw) markets["X"] += p;
      if (awayWin) markets["2"] += p;
      if (oneX) markets["1X"] += p;
      if (x2) markets["X2"] += p;
      if (over15) markets["O1.5"] += p;
      if (over25) markets["O2.5"] += p;
      if (under25) markets["U2.5"] += p;
      if (under35) markets["U3.5"] += p;
      if (btts) markets["BTTS"] += p;

      if (homeWin && over15) markets["1 + O1.5"] += p;
      if (homeWin && over25) markets["1 + O2.5"] += p;
      if (homeWin && under25) markets["1 + U2.5"] += p;
      if (homeWin && under35) markets["1 + U3.5"] += p;

      if (draw && over15) markets["X + O1.5"] += p;
      if (draw && over25) markets["X + O2.5"] += p;
      if (draw && under25) markets["X + U2.5"] += p;
      if (draw && under35) markets["X + U3.5"] += p;

      if (awayWin && over15) markets["2 + O1.5"] += p;
      if (awayWin && over25) markets["2 + O2.5"] += p;
      if (awayWin && under25) markets["2 + U2.5"] += p;
      if (awayWin && under35) markets["2 + U3.5"] += p;

      if (oneX && over15) markets["1X + O1.5"] += p;
      if (oneX && over25) markets["1X + O2.5"] += p;
      if (oneX && under25) markets["1X + U2.5"] += p;
      if (oneX && under35) markets["1X + U3.5"] += p;

      if (x2 && over15) markets["X2 + O1.5"] += p;
      if (x2 && over25) markets["X2 + O2.5"] += p;
      if (x2 && under25) markets["X2 + U2.5"] += p;
      if (x2 && under35) markets["X2 + U3.5"] += p;

      if (btts && over15) markets["BTTS + O1.5"] += p;
      if (btts && over25) markets["BTTS + O2.5"] += p;
    }
  }

  return markets;
}

function calculatePicks(lambdaH, lambdaA) {
  const markets = calculateMarkets(lambdaH, lambdaA);

  const bets = Object.entries(markets)
    .map(([label, pctValue]) => ({
      label,
      pct: pctValue
    }))
    .filter(b => b.pct >= 0.35 && b.pct <= 0.90)
    .sort((a, b) => b.pct - a.pct);

  const safe = bets.find(b => b.pct >= 0.70);
  const balanced = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  const value = bets.find(b => b.pct < 0.55 && b.pct >= 0.40);

  const result = [];

  if (safe) {
    result.push({
      ...safe,
      level: "safe",
      icon: "✅"
    });
  }

  if (balanced) {
    result.push({
      ...balanced,
      level: "balanced",
      icon: "⚖️"
    });
  }

  if (value) {
    result.push({
      ...value,
      level: "value",
      icon: "🔥"
    });
  }

  for (const bet of bets) {
    if (result.length >= 3) break;

    const alreadyUsed = result.some(r => r.label === bet.label);

    if (!alreadyUsed) {
      const level =
        result.length === 0
          ? "safe"
          : result.length === 1
            ? "balanced"
            : "value";

      const icon =
        level === "safe"
          ? "✅"
          : level === "balanced"
            ? "⚖️"
            : "🔥";

      result.push({
        ...bet,
        level,
        icon
      });
    }
  }

  return result.slice(0, 3);
}

// ======================================================
// CHECK RISULTATI
// ======================================================
function checkBet(label, home, away, hg, ag) {
  const total = hg + ag;
  const btts = hg > 0 && ag > 0;

  if (label === "1") return hg > ag;
  if (label === "X") return hg === ag;
  if (label === "2") return ag > hg;

  if (label === "1X") return hg >= ag;
  if (label === "X2") return ag >= hg;

  if (label === "O1.5") return total > 1;
  if (label === "O2.5") return total > 2;
  if (label === "U2.5") return total <= 2;
  if (label === "U3.5") return total <= 3;

  if (label === "BTTS") return btts;

  const comboParts = label.split(" + ");

  if (comboParts.length === 2) {
    return (
      checkBet(comboParts[0], home, away, hg, ag) &&
      checkBet(comboParts[1], home, away, hg, ag)
    );
  }

  return null;
}

// ======================================================
// STATISTICHE REPORT
// ======================================================
function emptyStats() {
  return {
    safe: {
      ok: 0,
      tot: 0
    },
    balanced: {
      ok: 0,
      tot: 0
    },
    value: {
      ok: 0,
      tot: 0
    },
    total: {
      ok: 0,
      tot: 0
    }
  };
}

function addStat(stats, level, outcome) {
  if (outcome === null || outcome === undefined) return;

  stats[level].tot += 1;
  stats.total.tot += 1;

  if (outcome) {
    stats[level].ok += 1;
    stats.total.ok += 1;
  }
}

function statsLine(icon, label, s) {
  return `${icon} ${label}: ${s.ok}/${s.tot} - ${pct(s.ok, s.tot)}%`;
}

function formatStatsBlock(stats) {
  return [
    statsLine("✅", "Sicure", stats.safe),
    statsLine("⚖️", "Equilibrate", stats.balanced),
    statsLine("🔥", "Value", stats.value),
    statsLine("📌", "Totale", stats.total)
  ].join("\n");
}

// ======================================================
// ANALISI CAMPIONATO
// ======================================================
async function analyzeLeagueReport(league, weekendKeys) {
  const result = {
    league,
    matches: [],
    stats: emptyStats(),
    totalWeekendMatches: 0,
    error: null
  };

  try {
    const seasonYear = getSeasonYear();
    const previousSeasonYear = seasonYear - 1;

    const currentSlug = `${league.slug}-${seasonYear}`;
    const previousSlug = `${league.slug}-${previousSeasonYear}`;

    const currentJson = await fetchJsonWithTimeout(BASE_URL + currentSlug);

    let previousJson = [];

    try {
      previousJson = await fetchJsonWithTimeout(BASE_URL + previousSlug);
    } catch (err) {
      console.log(`Storico precedente non disponibile per ${league.name}: ${err.message}`);
      previousJson = [];
    }

    const currentPlayed = parseFixtureData(currentJson, {
      ...league,
      slug: currentSlug
    });

    const previousPlayed = parseFixtureData(previousJson, {
      ...league,
      slug: previousSlug
    });

    const targetMatches = currentPlayed.filter(m => {
      const key = getDateKeyInTimezone(m.parsedDate, TIMEZONE);
      return weekendKeys.has(key);
    });

    result.totalWeekendMatches = targetMatches.length;

    if (!targetMatches.length) {
      return result;
    }

    const survivalProfile = computeSurvivalProfile(previousPlayed);

    for (const m of targetMatches) {
      const matchDateMs = m.parsedDate?.getTime() || 0;

      const currentPlayedBeforeMatch = currentPlayed.filter(p => {
        if (p === m) return false;

        const pDateMs = p.parsedDate?.getTime() || 0;

        return pDateMs > 0 && pDateMs < matchDateMs;
      });

      const homeStats = getStats(
        m.home,
        currentPlayedBeforeMatch,
        previousPlayed,
        survivalProfile
      );

      const awayStats = getStats(
        m.away,
        currentPlayedBeforeMatch,
        previousPlayed,
        survivalProfile
      );

      const lambdaH = clamp((homeStats.gf + awayStats.ga) / 2, 0.25, 3.5);
      const lambdaA = clamp((awayStats.gf + homeStats.ga) / 2, 0.25, 3.5);

      const bets = calculatePicks(lambdaH, lambdaA);

      if (bets.length < 3) {
        continue;
      }

      const checkedBets = bets.slice(0, 3).map(bet => {
        const outcome = checkBet(bet.label, m.home, m.away, m.hg, m.ag);

        addStat(result.stats, bet.level, outcome);

        return {
          ...bet,
          outcome
        };
      });

      result.matches.push({
        ...m,
        lambdaH,
        lambdaA,
        bets: checkedBets
      });
    }

    return result;
  } catch (err) {
    result.error = err.message;
    return result;
  }
}

async function loadReportData() {
  const {
    keys,
    saturdayKey,
    sundayKey
  } = getPreviousWeekendKeys();

  console.log(`Weekend precedente: ${saturdayKey}, ${sundayKey}`);

  const leagueResults = [];

  for (const league of LEAGUES) {
    const res = await analyzeLeagueReport(league, keys);
    leagueResults.push(res);
    await sleep(500);
  }

  const totalWeekendMatches = leagueResults.reduce(
    (sum, r) => sum + r.totalWeekendMatches,
    0
  );

  const allMatches = leagueResults.flatMap(r => r.matches);

  return {
    leagueResults,
    allMatches,
    totalWeekendMatches,
    saturdayKey,
    sundayKey
  };
}

// ======================================================
// MESSAGGI REPORT
// ======================================================
function resultIcon(outcome) {
  if (outcome === true) return "✅";
  if (outcome === false) return "❌";

  return "❔";
}

function buildTopStats(matches) {
  const stats = emptyStats();

  for (const m of matches) {
    for (const bet of m.bets.slice(0, 3)) {
      addStat(stats, bet.level, bet.outcome);
    }
  }

  return stats;
}

function buildMainReportMessage(allMatches, saturdayKey, sundayKey) {
  const sorted = [...allMatches].sort((a, b) => {
    const pa = a.bets?.[0]?.pct || 0;
    const pb = b.bets?.[0]?.pct || 0;

    return pb - pa;
  });

  const top = sorted.slice(0, TOP_LIMIT);
  const topStats = buildTopStats(top);

  let msg = "";

  msg += "📊 Report risultati - weekend precedente\n\n";
  msg += `Periodo analizzato: ${saturdayKey} / ${sundayKey}\n\n`;

  msg += "📌 LEGENDA\n";
  msg += "✅ Sicura - pick più prudente del modello\n";
  msg += "⚖️ Equilibrata - pick intermedio\n";
  msg += "🔥 Value - pick più aggressivo\n\n";

  msg += "━━━━━━━━━━━━━━━\n\n";
  msg += `🏆 TOP ${top.length} PICKS - RISULTATI\n\n`;
  msg += formatStatsBlock(topStats);
  msg += "\n\n";

  if (!top.length) {
    msg += "⚠️ Nessuna partita verificabile trovata.\n";
  }

  for (const m of top) {
    const date = formatDateIT(m.dateUtc);

    msg += `${m.flag} ${m.home} - ${m.away} ${m.hg}-${m.ag}\n`;

    if (date) {
      msg += `🗓 ${date}\n`;
    }

    for (const bet of m.bets.slice(0, 3)) {
      msg += `${bet.icon} ${pickLabel(bet)} ${resultIcon(bet.outcome)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "⚠️ Report automatico: misura l'affidabilità del modello, non garantisce esiti futuri.";

  return msg;
}

function buildLeagueReportMessage(leagueResult) {
  const {
    league,
    matches,
    stats,
    totalWeekendMatches,
    error
  } = leagueResult;

  let msg = "";

  msg += `${league.flag} ${league.name} - report risultati\n\n`;

  if (!totalWeekendMatches) {
    msg += "⚠️ Nessuna partita giocata nel weekend precedente.\n";
    return msg;
  }

  if (!matches.length) {
    msg += "⚠️ Partite trovate, ma nessuna verificabile dal modello.\n";

    if (error) {
      msg += `Motivo: ${error}\n`;
    }

    return msg;
  }

  msg += formatStatsBlock(stats);
  msg += "\n\n";
  msg += "━━━━━━━━━━━━━━━\n\n";

  const sorted = [...matches].sort((a, b) => {
    const da = a.parsedDate?.getTime() || 0;
    const db = b.parsedDate?.getTime() || 0;

    return da - db;
  });

  for (const m of sorted) {
    const date = formatDateIT(m.dateUtc);

    msg += `⚽ ${m.home} - ${m.away} ${m.hg}-${m.ag}\n`;

    if (date) {
      msg += `🗓 ${date}\n`;
    }

    for (const bet of m.bets.slice(0, 3)) {
      msg += `${bet.icon} ${pickLabel(bet)} ${resultIcon(bet.outcome)}\n`;
    }

    if (SHOW_NUMBERS) {
      msg += `📊 Lambda: ${m.lambdaH.toFixed(2)} - ${m.lambdaA.toFixed(2)}\n`;
    }

    msg += "\n";
  }

  msg += "⚠️ Verifica automatica sul weekend precedente.";

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
    const played = lr.totalWeekendMatches;

    if (!played) {
      msg += `⚠️ ${lr.league.flag} ${lr.league.name}: nessuna partita\n`;
    } else if (!total.tot) {
      msg += `⚠️ ${lr.league.flag} ${lr.league.name}: partite non verificabili\n`;
    } else {
      msg += `✅ ${lr.league.flag} ${lr.league.name}: ${total.ok}/${total.tot} - ${pct(total.ok, total.tot)}%\n`;
    }
  }

  return msg;
}

function buildAllReportMessages(leagueResults, allMatches, saturdayKey, sundayKey) {
  const messages = [];

  messages.push({
    title: "REPORT TOP 10",
    text: buildMainReportMessage(allMatches, saturdayKey, sundayKey)
  });

  for (const lr of leagueResults) {
    if (!lr.totalWeekendMatches) continue;

    messages.push({
      title: `${lr.league.name} REPORT`,
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
  console.log("Avvio report statistiche passate");

  if (!TOKEN) {
    console.error("BOT_TOKEN mancante. Configuralo nei GitHub Secrets.");
    process.exit(1);
  }

  const users = loadUsers();

  if (!users.length) {
    console.log("Nessun utente trovato in users.json.");
    return;
  }

  const {
    leagueResults,
    allMatches,
    totalWeekendMatches,
    saturdayKey,
    sundayKey
  } = await loadReportData();

  if (!totalWeekendMatches) {
    console.log("Nessuna partita giocata nel weekend precedente. Nessun invio.");
    return;
  }

  const messages = buildAllReportMessages(
    leagueResults,
    allMatches,
    saturdayKey,
    sundayKey
  );

  await broadcastAllMessages(messages);

  console.log(`Report completato. Partite weekend: ${totalWeekendMatches}. Partite verificate: ${allMatches.length}.`);
}

main().catch(async err => {
  console.error("Errore fatale report:", err);

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
