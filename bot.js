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
  if (!Number.isNaN(direct.getTime())) return direct;

  const italianDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);

  if (italianDateMatch) {
    const [, dd, mm, yyyy, hh = "12", min = "00"] = italianDateMatch;
    const parsed = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${min}:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
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
  const valid = values.filter(v => Number.isFinite(v));
  if (!valid.length) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(num, den, fallback = 1) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return fallback;
  return num / den;
}

function getRoundNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function chronological(matches) {
  return [...matches].sort((a, b) => {
    const da = a.parsedDate ? a.parsedDate.getTime() : 0;
    const db = b.parsedDate ? b.parsedDate.getTime() : 0;
    return da - db;
  });
}

function recentFirst(matches) {
  return [...matches].sort((a, b) => {
    const da = a.parsedDate ? a.parsedDate.getTime() : 0;
    const db = b.parsedDate ? b.parsedDate.getTime() : 0;
    return db - da;
  });
}

// =============================
// POISSON
// =============================
function factorial(k) {
  let result = 1;
  for (let i = 2; i <= k; i++) result *= i;
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

    if (!teams[m.home]) teams[m.home] = { team: m.home, p: 0, gf: 0, ga: 0, pts: 0 };
    if (!teams[m.away]) teams[m.away] = { team: m.away, p: 0, gf: 0, ga: 0, pts: 0 };

    teams[m.home].p += 1;
    teams[m.home].gf += m.hg;
    teams[m.home].ga += m.ag;

    teams[m.away].p += 1;
    teams[m.away].gf += m.ag;
    teams[m.away].ga += m.hg;

    if (m.hg > m.ag) teams[m.home].pts += 3;
    else if (m.hg < m.ag) teams[m.away].pts += 3;
    else {
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

  if (!ranked.length) return { gf: 1.0, ga: 1.65 };

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
// STATISTICHE CAMPIONATO
// =============================
function computeLeagueAverages(currentPlayed, previousPlayed) {
  const currentWeight = currentPlayed.length >= 20 ? 0.70 : 0.45;
  const previousWeight = 1 - currentWeight;

  const current = computeRawLeagueAverages(currentPlayed);
  const previous = computeRawLeagueAverages(previousPlayed);

  return {
    homeGoals: clamp((current.homeGoals * currentWeight) + (previous.homeGoals * previousWeight), 0.8, 2.3),
    awayGoals: clamp((current.awayGoals * currentWeight) + (previous.awayGoals * previousWeight), 0.6, 2.0),
    totalGoals: clamp((current.totalGoals * currentWeight) + (previous.totalGoals * previousWeight), 1.6, 4.0),
    bttsRate: clamp((current.bttsRate * currentWeight) + (previous.bttsRate * previousWeight), 0.25, 0.75),
    over15Rate: clamp((current.over15Rate * currentWeight) + (previous.over15Rate * previousWeight), 0.45, 0.90),
    over25Rate: clamp((current.over25Rate * currentWeight) + (previous.over25Rate * previousWeight), 0.25, 0.75),
    under25Rate: clamp((current.under25Rate * currentWeight) + (previous.under25Rate * previousWeight), 0.25, 0.75),
    under35Rate: clamp((current.under35Rate * currentWeight) + (previous.under35Rate * previousWeight), 0.45, 0.90)
  };
}

function computeRawLeagueAverages(matches) {
  if (!matches.length) {
    return {
      homeGoals: 1.45,
      awayGoals: 1.15,
      totalGoals: 2.60,
      bttsRate: 0.52,
      over15Rate: 0.72,
      over25Rate: 0.50,
      under25Rate: 0.50,
      under35Rate: 0.73
    };
  }

  const homeGoals = average(matches.map(m => m.hg), 1.45);
  const awayGoals = average(matches.map(m => m.ag), 1.15);
  const totalGoals = average(matches.map(m => m.hg + m.ag), 2.60);

  return {
    homeGoals,
    awayGoals,
    totalGoals,
    bttsRate: average(matches.map(m => (m.hg > 0 && m.ag > 0 ? 1 : 0)), 0.52),
    over15Rate: average(matches.map(m => (m.hg + m.ag > 1 ? 1 : 0)), 0.72),
    over25Rate: average(matches.map(m => (m.hg + m.ag > 2 ? 1 : 0)), 0.50),
    under25Rate: average(matches.map(m => (m.hg + m.ag <= 2 ? 1 : 0)), 0.50),
    under35Rate: average(matches.map(m => (m.hg + m.ag <= 3 ? 1 : 0)), 0.73)
  };
}

// =============================
// STATISTICHE SQUADRA EVOLUTE
// =============================
function getTeamGames(team, matches) {
  return recentFirst(
    matches
      .filter(m => m.home === team || m.away === team)
      .filter(m => m.hg !== null && m.ag !== null)
  );
}

function getTeamVenueGames(team, matches, venue) {
  return recentFirst(
    matches
      .filter(m => venue === "home" ? m.home === team : m.away === team)
      .filter(m => m.hg !== null && m.ag !== null)
  );
}

function extractTeamGameValues(team, games) {
  return games.map(m => {
    const isHome = m.home === team;
    const gf = isHome ? m.hg : m.ag;
    const ga = isHome ? m.ag : m.hg;
    const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
    const total = gf + ga;

    return {
      gf,
      ga,
      pts,
      total,
      btts: gf > 0 && ga > 0 ? 1 : 0,
      over15: total > 1 ? 1 : 0,
      over25: total > 2 ? 1 : 0,
      under25: total <= 2 ? 1 : 0,
      under35: total <= 3 ? 1 : 0
    };
  });
}

function summarizeTeamValues(values, fallbackGF, fallbackGA) {
  if (!values.length) {
    return {
      games: 0,
      gf: fallbackGF,
      ga: fallbackGA,
      ppg: 1.0,
      bttsRate: 0.50,
      over15Rate: 0.70,
      over25Rate: 0.50,
      under25Rate: 0.50,
      under35Rate: 0.72
    };
  }

  return {
    games: values.length,
    gf: average(values.map(v => v.gf), fallbackGF),
    ga: average(values.map(v => v.ga), fallbackGA),
    ppg: average(values.map(v => v.pts), 1.0),
    bttsRate: average(values.map(v => v.btts), 0.50),
    over15Rate: average(values.map(v => v.over15), 0.70),
    over25Rate: average(values.map(v => v.over25), 0.50),
    under25Rate: average(values.map(v => v.under25), 0.50),
    under35Rate: average(values.map(v => v.under35), 0.72)
  };
}

function slope(values) {
  if (values.length < 3) return 0;

  const n = values.length;
  const xs = values.map((_, i) => i + 1);
  const avgX = average(xs, 0);
  const avgY = average(values, 0);

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - avgX) * (values[i] - avgY);
    denominator += Math.pow(xs[i] - avgX, 2);
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

function computeTrendFactor(team, recentGames) {
  const games = chronological(recentGames).slice(-5);
  const values = extractTeamGameValues(team, games);

  if (values.length < 3) return { attack: 1, defense: 1 };

  const gfSlope = slope(values.map(v => v.gf));
  const gaSlope = slope(values.map(v => v.ga));

  return {
    attack: clamp(1 + gfSlope * 0.04, 0.94, 1.06),
    defense: clamp(1 + gaSlope * 0.035, 0.94, 1.06)
  };
}

function formFactor(ppg) {
  return clamp(1 + ((ppg - 1.3) * 0.07), 0.90, 1.10);
}

function reliabilityFromGames(games) {
  return clamp(games / 10, 0.35, 1.0);
}

function weightedMetric(parts) {
  const valid = parts.filter(p => Number.isFinite(p.value) && p.weight > 0);
  const weightSum = valid.reduce((sum, p) => sum + p.weight, 0);
  if (!weightSum) return 0;
  return valid.reduce((sum, p) => sum + p.value * p.weight, 0) / weightSum;
}

function computeTeamProfile(team, venue, currentPlayed, previousPlayed, survivalProfile, leagueAvg) {
  const currentAllGames = getTeamGames(team, currentPlayed);
  const previousAllGames = getTeamGames(team, previousPlayed);
  const currentVenueGames = getTeamVenueGames(team, currentPlayed, venue);
  const previousVenueGames = getTeamVenueGames(team, previousPlayed, venue);

  const recent5 = summarizeTeamValues(
    extractTeamGameValues(team, currentAllGames.slice(0, 5)),
    survivalProfile.gf,
    survivalProfile.ga
  );

  const recent10 = summarizeTeamValues(
    extractTeamGameValues(team, currentAllGames.slice(0, TEAM_FORM_N)),
    survivalProfile.gf,
    survivalProfile.ga
  );

  const currentVenue = summarizeTeamValues(
    extractTeamGameValues(team, currentVenueGames),
    survivalProfile.gf,
    survivalProfile.ga
  );

  const previousVenue = summarizeTeamValues(
    extractTeamGameValues(team, previousVenueGames),
    survivalProfile.gf,
    survivalProfile.ga
  );

  const previousAll = summarizeTeamValues(
    extractTeamGameValues(team, previousAllGames),
    survivalProfile.gf,
    survivalProfile.ga
  );

  const isPromoted = previousAll.games === 0;
  const currentGamesCount = currentAllGames.length;

  const fallbackWeight = isPromoted
    ? clamp(1 - (currentGamesCount / 10), 0.10, 1.0)
    : clamp(0.20 - (currentGamesCount * 0.015), 0.05, 0.20);

  const recent5Weight = currentGamesCount >= 5 ? 0.34 : 0.16;
  const recent10Weight = currentGamesCount >= 8 ? 0.24 : 0.14;
  const currentVenueWeight = currentVenue.games >= 3 ? 0.26 : 0.12;
  const previousVenueWeight = isPromoted ? 0.00 : 0.18;
  const previousAllWeight = isPromoted ? 0.00 : 0.08;

  const gf = weightedMetric([
    { value: recent5.gf, weight: recent5Weight },
    { value: recent10.gf, weight: recent10Weight },
    { value: currentVenue.gf, weight: currentVenueWeight },
    { value: previousVenue.gf, weight: previousVenueWeight },
    { value: previousAll.gf, weight: previousAllWeight },
    { value: survivalProfile.gf, weight: fallbackWeight }
  ]);

  const ga = weightedMetric([
    { value: recent5.ga, weight: recent5Weight },
    { value: recent10.ga, weight: recent10Weight },
    { value: currentVenue.ga, weight: currentVenueWeight },
    { value: previousVenue.ga, weight: previousVenueWeight },
    { value: previousAll.ga, weight: previousAllWeight },
    { value: survivalProfile.ga, weight: fallbackWeight }
  ]);

  const ppg = weightedMetric([
    { value: recent5.ppg, weight: 0.55 },
    { value: recent10.ppg, weight: 0.30 },
    { value: previousAll.ppg, weight: isPromoted ? 0.00 : 0.15 },
    { value: 0.9, weight: isPromoted ? fallbackWeight : 0.00 }
  ]);

  const trend = computeTrendFactor(team, currentAllGames.slice(0, 5));

  const rates = {
    bttsRate: weightedMetric([
      { value: recent10.bttsRate, weight: 0.50 },
      { value: currentVenue.bttsRate, weight: 0.25 },
      { value: previousAll.bttsRate, weight: isPromoted ? 0.00 : 0.15 },
      { value: leagueAvg.bttsRate, weight: 0.10 }
    ]),
    over15Rate: weightedMetric([
      { value: recent10.over15Rate, weight: 0.50 },
      { value: currentVenue.over15Rate, weight: 0.25 },
      { value: previousAll.over15Rate, weight: isPromoted ? 0.00 : 0.15 },
      { value: leagueAvg.over15Rate, weight: 0.10 }
    ]),
    over25Rate: weightedMetric([
      { value: recent10.over25Rate, weight: 0.50 },
      { value: currentVenue.over25Rate, weight: 0.25 },
      { value: previousAll.over25Rate, weight: isPromoted ? 0.00 : 0.15 },
      { value: leagueAvg.over25Rate, weight: 0.10 }
    ]),
    under25Rate: weightedMetric([
      { value: recent10.under25Rate, weight: 0.50 },
      { value: currentVenue.under25Rate, weight: 0.25 },
      { value: previousAll.under25Rate, weight: isPromoted ? 0.00 : 0.15 },
      { value: leagueAvg.under25Rate, weight: 0.10 }
    ]),
    under35Rate: weightedMetric([
      { value: recent10.under35Rate, weight: 0.50 },
      { value: currentVenue.under35Rate, weight: 0.25 },
      { value: previousAll.under35Rate, weight: isPromoted ? 0.00 : 0.15 },
      { value: leagueAvg.under35Rate, weight: 0.10 }
    ])
  };

  return {
    team,
    venue,
    gf: clamp(gf, 0.35, 3.20),
    ga: clamp(ga, 0.35, 3.20),
    ppg: clamp(ppg, 0, 3),
    formFactor: formFactor(ppg),
    attackTrendFactor: trend.attack,
    defenseTrendFactor: trend.defense,
    games: currentGamesCount + previousAll.games,
    currentGames: currentGamesCount,
    venueGames: currentVenue.games,
    previousGames: previousAll.games,
    isPromoted,
    reliability: reliabilityFromGames(currentGamesCount + Math.min(previousAll.games, 10) * 0.6),
    rates
  };
}

function computeExpectedGoals(homeProfile, awayProfile, leagueAvg) {
  const homeAttackStrength = safeDiv(homeProfile.gf, leagueAvg.homeGoals, 1);
  const homeDefenseWeakness = safeDiv(homeProfile.ga, leagueAvg.awayGoals, 1);
  const awayAttackStrength = safeDiv(awayProfile.gf, leagueAvg.awayGoals, 1);
  const awayDefenseWeakness = safeDiv(awayProfile.ga, leagueAvg.homeGoals, 1);

  let lambdaH = leagueAvg.homeGoals * homeAttackStrength * awayDefenseWeakness;
  let lambdaA = leagueAvg.awayGoals * awayAttackStrength * homeDefenseWeakness;

  lambdaH *= homeProfile.formFactor;
  lambdaA *= awayProfile.formFactor;

  lambdaH *= homeProfile.attackTrendFactor;
  lambdaA *= awayProfile.attackTrendFactor;

  lambdaH *= awayProfile.defenseTrendFactor;
  lambdaA *= homeProfile.defenseTrendFactor;

  return {
    lambdaH: clamp(lambdaH, 0.25, 3.60),
    lambdaA: clamp(lambdaA, 0.20, 3.30)
  };
}

// =============================
// CALCOLO MERCATI
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

function marketComponents(label) {
  return label.split(" + ");
}

function getRateAdjustmentForComponent(component, homeProfile, awayProfile, leagueAvg) {
  const homeRates = homeProfile.rates;
  const awayRates = awayProfile.rates;

  if (component === "BTTS") {
    const teamRate = (homeRates.bttsRate + awayRates.bttsRate) / 2;
    return clamp(1 + (teamRate - leagueAvg.bttsRate) * 0.22, 0.92, 1.08);
  }

  if (component === "O1.5") {
    const teamRate = (homeRates.over15Rate + awayRates.over15Rate) / 2;
    return clamp(1 + (teamRate - leagueAvg.over15Rate) * 0.16, 0.94, 1.06);
  }

  if (component === "O2.5") {
    const teamRate = (homeRates.over25Rate + awayRates.over25Rate) / 2;
    return clamp(1 + (teamRate - leagueAvg.over25Rate) * 0.20, 0.92, 1.08);
  }

  if (component === "U2.5") {
    const teamRate = (homeRates.under25Rate + awayRates.under25Rate) / 2;
    return clamp(1 + (teamRate - leagueAvg.under25Rate) * 0.18, 0.92, 1.08);
  }

  if (component === "U3.5") {
    const teamRate = (homeRates.under35Rate + awayRates.under35Rate) / 2;
    return clamp(1 + (teamRate - leagueAvg.under35Rate) * 0.16, 0.94, 1.06);
  }

  if (component === "1" || component === "1X") {
    return clamp(1 + (homeProfile.ppg - awayProfile.ppg) * 0.035, 0.94, 1.06);
  }

  if (component === "2" || component === "X2") {
    return clamp(1 + (awayProfile.ppg - homeProfile.ppg) * 0.035, 0.94, 1.06);
  }

  if (component === "X") {
    const ppgGap = Math.abs(homeProfile.ppg - awayProfile.ppg);
    return clamp(1 - ppgGap * 0.035, 0.94, 1.04);
  }

  return 1;
}

function applyMarketAdjustments(markets, homeProfile, awayProfile, leagueAvg) {
  const adjusted = {};

  for (const [label, probability] of Object.entries(markets)) {
    const components = marketComponents(label);
    const factor = components.reduce((acc, component) => {
      return acc * getRateAdjustmentForComponent(component, homeProfile, awayProfile, leagueAvg);
    }, 1);

    adjusted[label] = clamp(probability * factor, 0.01, 0.96);
  }

  return adjusted;
}

function marketQualityMultiplier(label) {
  const generic = new Set(["O1.5", "U3.5", "1X", "X2"]);
  const medium = new Set(["O2.5", "U2.5", "BTTS", "1", "2"]);

  if (generic.has(label)) return 0.90;
  if (medium.has(label)) return 1.03;
  if (label.includes(" + ")) return 1.13;
  if (label === "X") return 0.96;

  return 1.00;
}

function marketFamily(label) {
  if (label.includes("BTTS")) return "btts";
  if (label.includes("O") || label.includes("U")) return "goals";
  if (label.includes("1X") || label.includes("X2")) return "doublechance";
  if (label === "1" || label === "X" || label === "2") return "result";
  return label;
}

function diversityMultiplier(bets) {
  const families = new Set(bets.map(b => marketFamily(b.label)));
  if (families.size >= 3) return 1.06;
  if (families.size === 2) return 1.00;
  return 0.94;
}

function dataReliabilityMultiplier(homeProfile, awayProfile) {
  const reliability = (homeProfile.reliability + awayProfile.reliability) / 2;
  return clamp(0.88 + reliability * 0.18, 0.88, 1.06);
}

function calculatePicks(lambdaH, lambdaA, homeProfile, awayProfile, leagueAvg) {
  const baseMarkets = calculateMarkets(lambdaH, lambdaA);
  const adjustedMarkets = applyMarketAdjustments(baseMarkets, homeProfile, awayProfile, leagueAvg);

  const bets = Object.entries(adjustedMarkets)
    .map(([label, pctValue]) => ({
      label,
      pct: pctValue,
      quality: marketQualityMultiplier(label)
    }))
    .filter(b => b.pct >= 0.35 && b.pct <= 0.92)
    .sort((a, b) => {
      const scoreA = a.pct * a.quality;
      const scoreB = b.pct * b.quality;
      return scoreB - scoreA;
    });

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

function calculateTopScore(match) {
  const safe = match.bets[0]?.pct || 0;
  const mid = match.bets[1]?.pct || 0;
  const value = match.bets[2]?.pct || 0;

  const baseScore = (safe * 0.50) + (mid * 0.30) + (value * 0.20);
  const quality = average(match.bets.map(b => marketQualityMultiplier(b.label)), 1);
  const diversity = diversityMultiplier(match.bets);
  const reliability = dataReliabilityMultiplier(match.homeProfile, match.awayProfile);

  const tooGenericPenalty = match.bets.every(b => ["O1.5", "U3.5", "1X", "X2"].includes(b.label)) ? 0.92 : 1;

  return baseScore * quality * diversity * reliability * tooGenericPenalty;
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
    const leagueAvg = computeLeagueAverages(currentPlayed, previousPlayed);

    for (const match of targetMatches) {
      const homeProfile = computeTeamProfile(
        match.home,
        "home",
        currentPlayed,
        previousPlayed,
        survivalProfile,
        leagueAvg
      );

      const awayProfile = computeTeamProfile(
        match.away,
        "away",
        currentPlayed,
        previousPlayed,
        survivalProfile,
        leagueAvg
      );

      const { lambdaH, lambdaA } = computeExpectedGoals(homeProfile, awayProfile, leagueAvg);
      const bets = calculatePicks(lambdaH, lambdaA, homeProfile, awayProfile, leagueAvg);

      if (bets.length >= 3) {
        const enrichedMatch = {
          league: league.name,
          home: match.home,
          away: match.away,
          date: match.date,
          parsedDate: match.parsedDate,
          round: match.round,
          lambdaH,
          lambdaA,
          homeProfile,
          awayProfile,
          leagueAvg,
          bets
        };

        enrichedMatch.topScore = calculateTopScore(enrichedMatch);
        allMatches.push(enrichedMatch);
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
    .sort((a, b) => b.topScore - a.topScore)
    .slice(0, TOP_LIMIT);

  msg += `🏆 TOP ${topMatches.length} PICKS\n`;
  msg += "📌 Ranking: probabilità + qualità mercato + forma + affidabilità dati\n\n";

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
    msg += `🔥 ${pickLabel(m.bets[2])}\n`;

    if (SHOW_NUMBERS) {
      msg += `📊 xG stimati: ${m.lambdaH.toFixed(2)} - ${m.lambdaA.toFixed(2)} | Score: ${m.topScore.toFixed(3)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";

  const byLeague = {};

  for (const m of matches) {
    if (!byLeague[m.league]) byLeague[m.league] = [];
    byLeague[m.league].push(m);
  }

  for (const league of Object.keys(byLeague)) {
    const leagueMatches = byLeague[league];
    const round = leagueMatches.find(m => m.round !== null)?.round;

    msg += `\n📊 ${league}`;
    if (round !== undefined && round !== null) msg += ` - Giornata ${round}`;
    msg += "\n\n";

    for (const m of leagueMatches.sort((a, b) => a.parsedDate.getTime() - b.parsedDate.getTime())) {
      const date = formatDateShort(m.date);
      msg += `${m.home}-${m.away}`;
      if (date) msg += ` (${date})`;
      msg += ` → ${pickLabel(m.bets[0])} | ${pickLabel(m.bets[1])} | ${pickLabel(m.bets[2])}`;
      if (SHOW_NUMBERS) msg += ` [${m.topScore.toFixed(3)}]`;
      msg += "\n";
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
