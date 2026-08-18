import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const TEST_MODE = process.env.TEST_MODE === "true";
const USERS_FILE = TEST_MODE ? "users_test.json" : "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";
const MAX_GOALS = 10;
const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";

const LEAGUES = [
  { name: "SERIE A", slug: "serie-a" },
  { name: "PREMIER LEAGUE", slug: "epl" },
  { name: "BUNDESLIGA", slug: "bundesliga" },
  { name: "LA LIGA", slug: "la-liga" },
  { name: "LIGUE 1", slug: "ligue-1" },
  { name: "EREDIVISIE", slug: "eredivisie" }
];

// =============================
// UTENTI
// =============================
function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(data);

    if (!Array.isArray(users)) {
      console.log(`${USERS_FILE} deve essere un array.`);
      return [];
    }

    return users.filter(Boolean);
  } catch (err) {
    console.log(`Errore lettura ${USERS_FILE}:`, err.message);
    return [];
  }
}

async function sendToAll(text) {
  if (!TOKEN) {
    console.log("BOT_TOKEN mancante. Invio Telegram non eseguito.");
    return;
  }

  const users = loadUsers();

  if (!users.length) {
    console.log(`Nessun utente trovato in ${USERS_FILE}.`);
    return;
  }

  for (const id of users) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text,
          disable_web_page_preview: true
        })
      });

      if (!res.ok) {
        const body = await res.text();
        console.log(`Errore invio a ${id}: ${res.status} ${body}`);
      }
    } catch (err) {
      console.log(`Errore invio Telegram a ${id}:`, err.message);
    }
  }
}

// =============================
// DATE / STAGIONE
// =============================
function getDatePartsInTimezone(date = new Date(), timezone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);

  const map = {};

  for (const part of parts) {
    map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday
  };
}

function getSeasonYear() {
  const { year, month } = getDatePartsInTimezone();
  return month >= 8 ? year : year - 1;
}

function parseMatchDate(value) {
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

function getMatchDate(row) {
  return row.DateUtc || row.MatchDate || row.Date || row.DateTime || row.UtcDate || null;
}

function isFutureMatch(matchDate) {
  const parsed = parseMatchDate(matchDate);
  return parsed ? parsed.getTime() >= Date.now() : false;
}

function formatDateShort(date) {
  const parsed = parseMatchDate(date);

  if (!parsed) return "";

  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

// =============================
// UTILITY
// =============================
function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function pickLabel(bet) {
  if (!bet) return "N/D";

  return SHOW_NUMBERS ? `${bet.label} (${pct(bet.pct)})` : bet.label;
}

function average(values, fallback = 0) {
  if (!values.length) return fallback;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRoundNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

// =============================
// POISSON
// =============================
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

// =============================
// NORMALIZZAZIONE PARTITE
// =============================
function hasResult(row) {
  return (
    row.HomeTeamScore !== null &&
    row.HomeTeamScore !== undefined &&
    row.HomeTeamScore !== "" &&
    row.AwayTeamScore !== null &&
    row.AwayTeamScore !== undefined &&
    row.AwayTeamScore !== ""
  );
}

function normalizeMatch(row, leagueName, sourceType) {
  const played = hasResult(row);
  const date = getMatchDate(row);

  return {
    league: leagueName,
    home: row.HomeTeam,
    away: row.AwayTeam,
    hg: played ? Number(row.HomeTeamScore) : null,
    ag: played ? Number(row.AwayTeamScore) : null,
    date,
    parsedDate: parseMatchDate(date),
    round: getRoundNumber(row.RoundNumber),
    sourceType,
    played
  };
}

// =============================
// PROFILO SALVEZZA
// =============================
function computeTeamTable(matches) {
  const teams = {};

  for (const m of matches) {
    if (!m.home || !m.away) continue;
    if (m.hg === null || m.ag === null) continue;

    if (!teams[m.home]) {
      teams[m.home] = { team: m.home, p: 0, gf: 0, ga: 0, pts: 0 };
    }

    if (!teams[m.away]) {
      teams[m.away] = { team: m.away, p: 0, gf: 0, ga: 0, pts: 0 };
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
    .sort((a, b) => (a.pts / a.p) - (b.pts / b.p));

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

// =============================
// STATISTICHE SQUADRA
// =============================
function getTeamGames(team, matches) {
  return matches
    .filter(m => m.home === team || m.away === team)
    .filter(m => m.hg !== null && m.ag !== null)
    .sort((a, b) => {
      const da = a.parsedDate ? a.parsedDate.getTime() : 0;
      const db = b.parsedDate ? b.parsedDate.getTime() : 0;

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

function getStats(team, currentPlayed, previousPlayed, survivalProfile) {
  const currentGames = getTeamGames(team, currentPlayed).slice(0, TEAM_FORM_N);
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

// =============================
// CALCOLO PRONOSTICI
// =============================
function calculateMarkets(lambdaH, lambdaA) {
  const labels = [
    "1", "X", "2", "1X", "X2", "O1.5", "O2.5", "U2.5", "U3.5", "BTTS",
    "1 + O1.5", "1 + O2.5", "1 + U2.5", "1 + U3.5",
    "X + O1.5", "X + O2.5", "X + U2.5", "X + U3.5",
    "2 + O1.5", "2 + O2.5", "2 + U2.5", "2 + U3.5",
    "1X + O1.5", "1X + O2.5", "1X + U2.5", "1X + U3.5",
    "X2 + O1.5", "X2 + O2.5", "X2 + U2.5", "X2 + U3.5",
    "BTTS + O1.5", "BTTS + O2.5"
  ];

  const markets = Object.fromEntries(labels.map(label => [label, 0]));

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
  const mid = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  const value = bets.find(b => b.pct < 0.55 && b.pct >= 0.40);

  const result = [];

  if (safe) result.push({ ...safe, type: "safe" });
  if (mid) result.push({ ...mid, type: "mid" });
  if (value) result.push({ ...value, type: "value" });

  for (const bet of bets) {
    if (result.length >= 3) break;

    const alreadyUsed = result.some(r => r.label === bet.label);

    if (!alreadyUsed) {
      result.push({
        ...bet,
        type: result.length === 0 ? "safe" : result.length === 1 ? "mid" : "value"
      });
    }
  }

  return result.slice(0, 3);
}

// =============================
// SELEZIONE GIORNATA
// =============================
function selectNextMatchdayMatches(upcomingMatches) {
  const futureMatches = upcomingMatches
    .filter(m => m.parsedDate)
    .filter(m => isFutureMatch(m.date))
    .sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime());

  if (!futureMatches.length) return [];

  const matchesWithRound = futureMatches.filter(m => m.round !== null);

  if (matchesWithRound.length) {
    const nextRound = Math.min(...matchesWithRound.map(m => m.round));

    return matchesWithRound
      .filter(m => m.round === nextRound)
      .sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime());
  }

  const firstMatchDate = futureMatches[0].parsedDate;
  const maxWindowMs = 5 * 24 * 60 * 60 * 1000;
  const endDate = new Date(firstMatchDate.getTime() + maxWindowMs);

  return futureMatches
    .filter(m => m.parsedDate >= firstMatchDate && m.parsedDate <= endDate)
    .sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime());
}

// =============================
// LOAD CAMPIONATI
// =============================
async function loadFeed(slug) {
  try {
    const res = await fetch(BASE_URL + slug);

    if (!res.ok) {
      console.log(`Feed non disponibile: ${slug} - status ${res.status}`);
      return [];
    }

    const json = await res.json();

    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.log(`Errore caricamento feed ${slug}:`, err.message);
    return [];
  }
}

async function loadLeagues() {
  const seasonYear = getSeasonYear();
  const previousSeasonYear = seasonYear - 1;
  const allMatches = [];

  for (const league of LEAGUES) {
    const currentSlug = `${league.slug}-${seasonYear}`;
    const previousSlug = `${league.slug}-${previousSeasonYear}`;

    const previousRows = await loadFeed(previousSlug);
    const currentRows = await loadFeed(currentSlug);

    const previousMatches = previousRows
      .map(row => normalizeMatch(row, league.name, "previous"))
      .filter(m => m.home && m.away);

    const currentMatches = currentRows
      .map(row => normalizeMatch(row, league.name, "current"))
      .filter(m => m.home && m.away);

    const previousPlayed = previousMatches.filter(m => m.played);
    const currentPlayed = currentMatches.filter(m => m.played);

    const currentUpcoming = currentMatches
      .filter(m => !m.played)
      .filter(m => m.home && m.away)
      .filter(m => m.parsedDate);

    const targetMatches = selectNextMatchdayMatches(currentUpcoming);

    if (!targetMatches.length) {
      console.log(`${league.name}: nessuna partita futura trovata.`);
      continue;
    }

    const selectedRound = targetMatches[0].round !== null
      ? `giornata ${targetMatches[0].round}`
      : "prossima finestra partite";

    console.log(`${league.name}: selezionata ${selectedRound}, partite ${targetMatches.length}.`);

    const survivalProfile = computeSurvivalProfile(previousPlayed);

    for (const match of targetMatches) {
      const homeStats = getStats(match.home, currentPlayed, previousPlayed, survivalProfile);
      const awayStats = getStats(match.away, currentPlayed, previousPlayed, survivalProfile);

      const lambdaH = clamp((homeStats.gf + awayStats.ga) / 2, 0.25, 3.5);
      const lambdaA = clamp((awayStats.gf + homeStats.ga) / 2, 0.25, 3.5);
      const bets = calculatePicks(lambdaH, lambdaA);

      if (bets.length >= 3) {
        allMatches.push({
          league: league.name,
          home: match.home,
          away: match.away,
          date: match.date,
          parsedDate: match.parsedDate,
          round: match.round,
          lambdaH,
          lambdaA,
          bets
        });
      }
    }
  }

  return allMatches.sort((a, b) => {
    const da = a.parsedDate ? a.parsedDate.getTime() : 0;
    const db = b.parsedDate ? b.parsedDate.getTime() : 0;

    return da - db;
  });
}

// =============================
// MESSAGGIO
// =============================
function buildMessage(matches, title) {
  let msg = `🔥 ${title} 🔥\n\n`;

  if (TEST_MODE) {
    msg += "🧪 Modalità test attiva\n";
    msg += `👥 File utenti: ${USERS_FILE}\n\n`;
  }

  const topMatches = [...matches]
    .sort((a, b) => b.bets[0].pct - a.bets[0].pct)
    .slice(0, TOP_LIMIT);

  msg += `🏆 TOP ${topMatches.length} PICKS\n\n`;

  for (const m of topMatches) {
    msg += `${m.home} - ${m.away}\n`;

    const date = formatDateShort(m.date);

    if (m.round !== null) {
      msg += `📅 Giornata ${m.round}`;
      if (date) msg += ` - ${date}`;
      msg += "\n";
    } else if (date) {
      msg += `📅 ${date}\n`;
    }

    msg += `✅ ${pickLabel(m.bets[0])}\n`;
    msg += `⚖️ ${pickLabel(m.bets[1])}\n`;
    msg += `🔥 ${pickLabel(m.bets[2])}\n\n`;
  }

  msg += "━━━━━━━━━━━━━━━\n";

  const byLeague = {};

  for (const m of matches) {
    if (!byLeague[m.league]) {
      byLeague[m.league] = [];
    }

    byLeague[m.league].push(m);
  }

  for (const league of Object.keys(byLeague)) {
    const leagueMatches = byLeague[league];
    const round = leagueMatches.find(m => m.round !== null)?.round;

    msg += `\n📊 ${league}`;

    if (round !== undefined && round !== null) {
      msg += ` - Giornata ${round}`;
    }

    msg += "\n\n";

    for (const m of leagueMatches) {
      const date = formatDateShort(m.date);

      msg += `${m.home}-${m.away}`;

      if (date) {
        msg += ` (${date})`;
      }

      msg += ` → ${pickLabel(m.bets[0])} | ${pickLabel(m.bets[1])} | ${pickLabel(m.bets[2])}\n`;
    }
  }

  if (msg.length > 3900) {
    msg = `${msg.substring(0, 3850)}\n\nMessaggio accorciato per limite Telegram.`;
  }

  return msg;
}

// =============================
// MAIN
// =============================
async function run() {
  try {
    console.log(`Modalità test: ${TEST_MODE}`);
    console.log(`File utenti utilizzato: ${USERS_FILE}`);

    const matches = await loadLeagues();

    if (!matches.length) {
      console.log("Nessuna partita trovata. Nessun messaggio inviato.");
      return;
    }

    const title = TEST_MODE ? "TEST GIORNATE CAMPIONATI" : "WEEKEND PICKS";
    const message = buildMessage(matches, title);

    await sendToAll(message);

    console.log(`Messaggio inviato. Partite analizzate: ${matches.length}`);
  } catch (err) {
    console.error("Errore esecuzione bot:", err);
    process.exitCode = 1;
  }
}

run();
