import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("BOT_TOKEN mancante. Configuralo nei GitHub Secrets.");
  process.exit(1);
}

const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a" },
  { name: "PREMIER LEAGUE", flag: "🇬🇧", slug: "epl" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1" },
  { name: "EREDIVISIE", flag: "🇳🇱", slug: "eredivisie" }
];

const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";
const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);

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

function getDateKeyInTimezone(date, timeZone = TIMEZONE) {
  if (!date || Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
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
    if (p.type !== "literal") map[p.type] = p.value;
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

  const saturdayKey = new Date(lastSaturday).toISOString().split("T")[0];
  const sundayKey = new Date(lastSunday).toISOString().split("T")[0];

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

    if (!ok) allOk = false;

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
function getMatchDateRaw(r) {
  return r.DateUtc || r.MatchDate || r.Date || "";
}

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
      dateUtc: getMatchDateRaw(r),
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
// PROFILO NEOPROMOSSE
// ======================================================
function computeSurvivalProfile(previousMatches) {
  const teams = {};

  previousMatches.forEach(m => {
    if (!teams[m.home]) teams[m.home] = { p: 0, gf: 0, ga: 0, pts: 0 };
    if (!teams[m.away]) teams[m.away] = { p: 0, gf: 0, ga: 0, pts: 0 };

    teams[m.home].p++;
    teams[m.home].gf += m.hg;
    teams[m.home].ga += m.ag;

    teams[m.away].p++;
    teams[m.away].gf += m.ag;
    teams[m.away].ga += m.hg;

    if (m.hg > m.ag) teams[m.home].pts += 3;
    else if (m.hg < m.ag) teams[m.away].pts += 3;
    else {
      teams[m.home].pts += 1;
      teams[m.away].pts += 1;
    }
  });

  const ranked = Object.values(teams)
    .filter(t => t.p > 0)
    .sort((a, b) => (a.pts / a.p) - (b.pts / b.p));

  if (!ranked.length) {
    return { gf: 1.0, ga: 1.6 };
  }

  const bottomCount = Math.max(3, Math.ceil(ranked.length * 0.2));
  const bottomTeams = ranked.slice(0, bottomCount);

  return {
    gf: bottomTeams.reduce((s, t) => s + (t.gf / t.p), 0) / bottomTeams.length || 1.0,
    ga: bottomTeams.reduce((s, t) => s + (t.ga / t.p), 0) / bottomTeams.length || 1.6
  };
}

// ======================================================
// MODELLO
// ======================================================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) {
    fact *= i;
  }

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function getStats(team, matches, fallbackProfile) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (!games.length) {
    return fallbackProfile || { gf: 1.0, ga: 1.6 };
  }

  const rawGF = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.hg : m.ag);
  }, 0) / games.length;

  const rawGA = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.ag : m.hg);
  }, 0) / games.length;

  if (games.length < 5 && fallbackProfile) {
    const realWeight = games.length / 5;
    const fallbackWeight = 1 - realWeight;

    return {
      gf: rawGF * realWeight + fallbackProfile.gf * fallbackWeight,
      ga: rawGA * realWeight + fallbackProfile.ga * fallbackWeight
    };
  }

  return {
    gf: rawGF,
    ga: rawGA
  };
}

function calculate(lambdaH, lambdaA) {
  let pH = 0;
  let pD = 0;
  let pA = 0;
  let over15 = 0;
  let over25 = 0;
  let under25 = 0;
  let under35 = 0;
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

  Object.entries(base).forEach(([label, pct]) => {
    bets.push({ label, pct });
  });

  ["1", "X", "2"].forEach(result => {
    ["O1.5", "O2.5", "U2.5", "U3.5"].forEach(total => {
      bets.push({
        label: `${result} + ${total}`,
        pct: base[result] * base[total]
      });
    });
  });

  ["1X", "X2"].forEach(dc => {
    ["O1.5", "O2.5", "U2.5", "U3.5"].forEach(total => {
      bets.push({
        label: `${dc} + ${total}`,
        pct: base[dc] * base[total]
      });
    });
  });

  ["O1.5", "O2.5"].forEach(total => {
    bets.push({
      label: `BTTS + ${total}`,
      pct: base["BTTS"] * base[total]
    });
  });

  bets = bets
    .filter(b => b.pct > 0.40 && b.pct < 0.85)
    .sort((a, b) => b.pct - a.pct);

  const safe = bets.find(b => b.pct >= 0.70);
  const mid = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  const value = bets.find(b => b.pct < 0.55);

  const result = [safe, mid, value].filter(Boolean);

  for (const bet of bets) {
    if (result.length >= 3) break;
    if (!result.some(x => x.label === bet.label)) result.push(bet);
  }

  return result.slice(0, 3);
}

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
    return checkBet(comboParts[0], home, away, hg, ag) &&
           checkBet(comboParts[1], home, away, hg, ag);
  }

  return null;
}

// ======================================================
// STATISTICHE REPORT
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
    } catch {
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

    const survivalProfile = computeSurvivalProfile(previousPlayed);
    const allPlayed = previousPlayed.concat(currentPlayed);

    const targetMatches = currentPlayed.filter(m => {
      const d = parseDateValue(m.dateUtc);
      const key = getDateKeyInTimezone(d, TIMEZONE);
      return weekendKeys.has(key);
    });

    result.totalWeekendMatches = targetMatches.length;

    if (!targetMatches.length) {
      return result;
    }

    for (const m of targetMatches) {
      const matchDate = parseDateValue(m.dateUtc);

      const previousForMatch = allPlayed.filter(p => {
        if (p === m) return false;

        const pDate = parseDateValue(p.dateUtc);

        if (matchDate && pDate) {
          return pDate.getTime() < matchDate.getTime();
        }

        return false;
      });

      const h = getStats(m.home, previousForMatch, survivalProfile);
      const a = getStats(m.away, previousForMatch, survivalProfile);

      const bets = calculate(
        (h.gf + a.ga) / 2,
        (a.gf + h.ga) / 2
      );

      if (bets.length < 3) continue;

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
  const { keys, saturdayKey, sundayKey } = getPreviousWeekendKeys();

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
    const levels = ["safe", "balanced", "value"];

    m.bets.slice(0, 3).forEach((bet, idx) => {
      addStat(stats, levels[idx], bet.outcome);
    });
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
  msg += "✅ Sicura - primo pick del modello\n";
  msg += "⚖️ Equilibrata - secondo pick\n";
  msg += "🔥 Value - terzo pick più aggressivo\n\n";

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
    if (date) msg += `🗓 ${date}\n`;

    for (const bet of m.bets.slice(0, 3)) {
      msg += `${bet.icon} ${bet.label} ${resultIcon(bet.outcome)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "⚠️ Report automatico: misura affidabilità del modello, non garantisce esiti futuri.";

  return msg;
}

function buildLeagueReportMessage(leagueResult) {
  const { league, matches, stats, totalWeekendMatches, error } = leagueResult;

  let msg = "";

  msg += `${league.flag} ${league.name} - report risultati\n\n`;

  if (!totalWeekendMatches) {
    msg += "⚠️ Nessuna partita giocata nel weekend precedente.\n";
    return msg;
  }

  if (!matches.length) {
    msg += "⚠️ Partite trovate, ma nessuna verificabile dal modello.\n";
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
      msg += `${bet.icon} ${bet.label} ${resultIcon(bet.outcome)}\n`;
    }

    if (SHOW_NUMBERS) {
      msg += `📊 Picks calcolate su storico precedente alla partita\n`;
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
  console.log("Avvio report mercoledì");

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

  // Se nel weekend precedente non ci sono state partite,
  // non invia nulla.
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

  console.log("Report completato");
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
