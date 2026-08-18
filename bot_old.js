import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const TEST_MODE = process.env.TEST_MODE === "true";
const USERS_FILE = TEST_MODE ? "users_test.json" : "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";
const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);
const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";
const MAX_GOALS = 10;

const LEAGUES = [
  { name: "SERIE A", slug: "serie-a" },
  { name: "PREMIER LEAGUE", slug: "epl" },
  { name: "BUNDESLIGA", slug: "bundesliga" },
  { name: "LA LIGA", slug: "la-liga" },
  { name: "LIGUE 1", slug: "ligue-1" },
  { name: "EREDIVISIE", slug: "eredivisie" }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values, fallback = 0) {
  const valid = values.filter(v => Number.isFinite(v));
  if (!valid.length) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function safeDiv(num, den, fallback = 1) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return fallback;
  return num / den;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function loadUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(users) ? users.filter(Boolean) : [];
  } catch (err) {
    console.log(`Errore lettura ${USERS_FILE}:`, err.message);
    return [];
  }
}

async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });

  if (!res.ok) {
    const body = await res.text();
    console.log(`Errore invio a ${chatId}: ${res.status} ${body}`);
  }
}

async function sendMessagesToAll(messages) {
  if (!TOKEN) {
    console.log("BOT_TOKEN mancante. Invio Telegram non eseguito.");
    return;
  }

  const users = loadUsers();
  if (!users.length) {
    console.log(`Nessun utente trovato in ${USERS_FILE}.`);
    return;
  }

  for (const user of users) {
    for (const message of messages) {
      await sendTelegram(user, message);
      await sleep(900);
    }
  }
}

function getLocalParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};
  for (const part of parts) map[part.type] = part.value;

  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function getSeasonYear() {
  const { year, month } = getLocalParts();
  return month >= 8 ? year : year - 1;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const raw = String(value).trim();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;

  const [, dd, mm, yyyy, hh = "12", min = "00"] = m;
  const parsed = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${min}:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateShort(value) {
  const date = parseDate(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function getRawDate(row) {
  return row.DateUtc || row.MatchDate || row.Date || row.DateTime || row.UtcDate || null;
}

function hasScore(row) {
  return row.HomeTeamScore !== null && row.HomeTeamScore !== undefined && row.HomeTeamScore !== "" &&
    row.AwayTeamScore !== null && row.AwayTeamScore !== undefined && row.AwayTeamScore !== "";
}

function roundNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(row, league) {
  const played = hasScore(row);
  const date = getRawDate(row);

  return {
    league,
    home: row.HomeTeam,
    away: row.AwayTeam,
    hg: played ? Number(row.HomeTeamScore) : null,
    ag: played ? Number(row.AwayTeamScore) : null,
    date,
    parsedDate: parseDate(date),
    round: roundNumber(row.RoundNumber),
    played
  };
}

async function loadFeed(slug) {
  try {
    const res = await fetch(BASE_URL + slug);
    if (!res.ok) {
      console.log(`Feed non disponibile: ${slug} - ${res.status}`);
      return [];
    }

    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.log(`Errore caricamento ${slug}:`, err.message);
    return [];
  }
}

function byDateAsc(a, b) {
  return (a.parsedDate?.getTime() || 0) - (b.parsedDate?.getTime() || 0);
}

function byDateDesc(a, b) {
  return (b.parsedDate?.getTime() || 0) - (a.parsedDate?.getTime() || 0);
}

function selectNextMatchday(upcoming) {
  const future = upcoming
    .filter(m => m.parsedDate && m.parsedDate.getTime() >= Date.now())
    .sort(byDateAsc);

  if (!future.length) return [];

  const withRound = future.filter(m => m.round !== null);
  if (withRound.length) {
    const nextRound = Math.min(...withRound.map(m => m.round));
    return withRound.filter(m => m.round === nextRound).sort(byDateAsc);
  }

  const start = future[0].parsedDate.getTime();
  const end = start + 5 * 24 * 60 * 60 * 1000;

  return future.filter(m => m.parsedDate.getTime() <= end).sort(byDateAsc);
}

function factorial(k) {
  let result = 1;
  for (let i = 2; i <= k; i++) result *= i;
  return result;
}

function poisson(lambda, k) {
  const safeLambda = Math.max(0.1, lambda);
  return (Math.pow(safeLambda, k) * Math.exp(-safeLambda)) / factorial(k);
}

function computeTeamTable(matches) {
  const teams = {};

  for (const m of matches) {
    if (!teams[m.home]) teams[m.home] = { p: 0, gf: 0, ga: 0, pts: 0 };
    if (!teams[m.away]) teams[m.away] = { p: 0, gf: 0, ga: 0, pts: 0 };

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

function computeSurvivalProfile(previousPlayed) {
  const table = computeTeamTable(previousPlayed)
    .filter(t => t.p > 0)
    .sort((a, b) => (a.pts / a.p) - (b.pts / b.p));

  if (!table.length) return { gf: 1.0, ga: 1.65 };

  const bottom = table.slice(0, Math.max(3, Math.ceil(table.length * 0.2)));

  return {
    gf: clamp(average(bottom.map(t => t.gf / t.p), 1.0), 0.6, 1.3),
    ga: clamp(average(bottom.map(t => t.ga / t.p), 1.65), 1.3, 2.2)
  };
}

function rawLeagueAvg(matches) {
  if (!matches.length) {
    return { homeGoals: 1.45, awayGoals: 1.15, btts: 0.52, o15: 0.72, o25: 0.50, u25: 0.50, u35: 0.73 };
  }

  return {
    homeGoals: average(matches.map(m => m.hg), 1.45),
    awayGoals: average(matches.map(m => m.ag), 1.15),
    btts: average(matches.map(m => m.hg > 0 && m.ag > 0 ? 1 : 0), 0.52),
    o15: average(matches.map(m => m.hg + m.ag > 1 ? 1 : 0), 0.72),
    o25: average(matches.map(m => m.hg + m.ag > 2 ? 1 : 0), 0.50),
    u25: average(matches.map(m => m.hg + m.ag <= 2 ? 1 : 0), 0.50),
    u35: average(matches.map(m => m.hg + m.ag <= 3 ? 1 : 0), 0.73)
  };
}

function computeLeagueAvg(currentPlayed, previousPlayed) {
  const currentWeight = currentPlayed.length >= 20 ? 0.70 : 0.45;
  const previousWeight = 1 - currentWeight;
  const current = rawLeagueAvg(currentPlayed);
  const previous = rawLeagueAvg(previousPlayed);

  return {
    homeGoals: clamp(current.homeGoals * currentWeight + previous.homeGoals * previousWeight, 0.8, 2.3),
    awayGoals: clamp(current.awayGoals * currentWeight + previous.awayGoals * previousWeight, 0.6, 2.0),
    btts: clamp(current.btts * currentWeight + previous.btts * previousWeight, 0.25, 0.75),
    o15: clamp(current.o15 * currentWeight + previous.o15 * previousWeight, 0.45, 0.90),
    o25: clamp(current.o25 * currentWeight + previous.o25 * previousWeight, 0.25, 0.75),
    u25: clamp(current.u25 * currentWeight + previous.u25 * previousWeight, 0.25, 0.75),
    u35: clamp(current.u35 * currentWeight + previous.u35 * previousWeight, 0.45, 0.90)
  };
}

function teamGames(team, matches) {
  return matches.filter(m => m.home === team || m.away === team).sort(byDateDesc);
}

function teamVenueGames(team, matches, venue) {
  return matches.filter(m => venue === "home" ? m.home === team : m.away === team).sort(byDateDesc);
}

function valuesFor(team, games) {
  return games.map(m => {
    const isHome = m.home === team;
    const gf = isHome ? m.hg : m.ag;
    const ga = isHome ? m.ag : m.hg;
    const total = gf + ga;

    return {
      gf,
      ga,
      pts: gf > ga ? 3 : gf === ga ? 1 : 0,
      btts: gf > 0 && ga > 0 ? 1 : 0,
      o15: total > 1 ? 1 : 0,
      o25: total > 2 ? 1 : 0,
      u25: total <= 2 ? 1 : 0,
      u35: total <= 3 ? 1 : 0
    };
  });
}

function summarize(values, fallbackGF, fallbackGA) {
  if (!values.length) {
    return { games: 0, gf: fallbackGF, ga: fallbackGA, ppg: 1.0, btts: 0.5, o15: 0.70, o25: 0.50, u25: 0.50, u35: 0.72 };
  }

  return {
    games: values.length,
    gf: average(values.map(v => v.gf), fallbackGF),
    ga: average(values.map(v => v.ga), fallbackGA),
    ppg: average(values.map(v => v.pts), 1.0),
    btts: average(values.map(v => v.btts), 0.5),
    o15: average(values.map(v => v.o15), 0.70),
    o25: average(values.map(v => v.o25), 0.50),
    u25: average(values.map(v => v.u25), 0.50),
    u35: average(values.map(v => v.u35), 0.72)
  };
}

function slope(values) {
  if (values.length < 3) return 0;

  const xs = values.map((_, i) => i + 1);
  const avgX = average(xs, 0);
  const avgY = average(values, 0);
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < values.length; i++) {
    numerator += (xs[i] - avgX) * (values[i] - avgY);
    denominator += Math.pow(xs[i] - avgX, 2);
  }

  return denominator ? numerator / denominator : 0;
}

function trendFactors(team, games) {
  const recent = [...games].sort(byDateAsc).slice(-5);
  const values = valuesFor(team, recent);
  if (values.length < 3) return { attack: 1, defense: 1 };

  return {
    attack: clamp(1 + slope(values.map(v => v.gf)) * 0.04, 0.94, 1.06),
    defense: clamp(1 + slope(values.map(v => v.ga)) * 0.035, 0.94, 1.06)
  };
}

function weighted(parts) {
  const valid = parts.filter(p => Number.isFinite(p.value) && p.weight > 0);
  const totalWeight = valid.reduce((sum, p) => sum + p.weight, 0);
  if (!totalWeight) return 0;
  return valid.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
}

function formFactor(ppg) {
  return clamp(1 + (ppg - 1.3) * 0.07, 0.90, 1.10);
}

function reliability(games) {
  return clamp(games / 10, 0.35, 1);
}

function profile(team, venue, currentPlayed, previousPlayed, survival, leagueAvg) {
  const currentAll = teamGames(team, currentPlayed);
  const previousAll = teamGames(team, previousPlayed);
  const currentVenue = teamVenueGames(team, currentPlayed, venue);
  const previousVenue = teamVenueGames(team, previousPlayed, venue);

  const recent5 = summarize(valuesFor(team, currentAll.slice(0, 5)), survival.gf, survival.ga);
  const recent10 = summarize(valuesFor(team, currentAll.slice(0, TEAM_FORM_N)), survival.gf, survival.ga);
  const currentVenueStats = summarize(valuesFor(team, currentVenue), survival.gf, survival.ga);
  const previousVenueStats = summarize(valuesFor(team, previousVenue), survival.gf, survival.ga);
  const previousAllStats = summarize(valuesFor(team, previousAll), survival.gf, survival.ga);

  const promoted = previousAllStats.games === 0;
  const currentGamesCount = currentAll.length;
  const fallbackWeight = promoted ? clamp(1 - currentGamesCount / 10, 0.10, 1) : clamp(0.20 - currentGamesCount * 0.015, 0.05, 0.20);

  const gf = weighted([
    { value: recent5.gf, weight: currentGamesCount >= 5 ? 0.34 : 0.16 },
    { value: recent10.gf, weight: currentGamesCount >= 8 ? 0.24 : 0.14 },
    { value: currentVenueStats.gf, weight: currentVenueStats.games >= 3 ? 0.26 : 0.12 },
    { value: previousVenueStats.gf, weight: promoted ? 0 : 0.18 },
    { value: previousAllStats.gf, weight: promoted ? 0 : 0.08 },
    { value: survival.gf, weight: fallbackWeight }
  ]);

  const ga = weighted([
    { value: recent5.ga, weight: currentGamesCount >= 5 ? 0.34 : 0.16 },
    { value: recent10.ga, weight: currentGamesCount >= 8 ? 0.24 : 0.14 },
    { value: currentVenueStats.ga, weight: currentVenueStats.games >= 3 ? 0.26 : 0.12 },
    { value: previousVenueStats.ga, weight: promoted ? 0 : 0.18 },
    { value: previousAllStats.ga, weight: promoted ? 0 : 0.08 },
    { value: survival.ga, weight: fallbackWeight }
  ]);

  const ppg = weighted([
    { value: recent5.ppg, weight: 0.55 },
    { value: recent10.ppg, weight: 0.30 },
    { value: previousAllStats.ppg, weight: promoted ? 0 : 0.15 },
    { value: 0.9, weight: promoted ? fallbackWeight : 0 }
  ]);

  const trend = trendFactors(team, currentAll.slice(0, 5));

  const rates = {
    btts: weighted([{ value: recent10.btts, weight: 0.5 }, { value: currentVenueStats.btts, weight: 0.25 }, { value: previousAllStats.btts, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.btts, weight: 0.1 }]),
    o15: weighted([{ value: recent10.o15, weight: 0.5 }, { value: currentVenueStats.o15, weight: 0.25 }, { value: previousAllStats.o15, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.o15, weight: 0.1 }]),
    o25: weighted([{ value: recent10.o25, weight: 0.5 }, { value: currentVenueStats.o25, weight: 0.25 }, { value: previousAllStats.o25, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.o25, weight: 0.1 }]),
    u25: weighted([{ value: recent10.u25, weight: 0.5 }, { value: currentVenueStats.u25, weight: 0.25 }, { value: previousAllStats.u25, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.u25, weight: 0.1 }]),
    u35: weighted([{ value: recent10.u35, weight: 0.5 }, { value: currentVenueStats.u35, weight: 0.25 }, { value: previousAllStats.u35, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.u35, weight: 0.1 }])
  };

  return {
    team,
    venue,
    gf: clamp(gf, 0.35, 3.2),
    ga: clamp(ga, 0.35, 3.2),
    ppg: clamp(ppg, 0, 3),
    formFactor: formFactor(ppg),
    attackTrend: trend.attack,
    defenseTrend: trend.defense,
    reliability: reliability(currentGamesCount + Math.min(previousAllStats.games, 10) * 0.6),
    rates,
    promoted
  };
}

function expectedGoals(home, away, leagueAvg) {
  let lambdaH = leagueAvg.homeGoals * safeDiv(home.gf, leagueAvg.homeGoals) * safeDiv(away.ga, leagueAvg.homeGoals);
  let lambdaA = leagueAvg.awayGoals * safeDiv(away.gf, leagueAvg.awayGoals) * safeDiv(home.ga, leagueAvg.awayGoals);

  lambdaH *= home.formFactor * home.attackTrend * away.defenseTrend;
  lambdaA *= away.formFactor * away.attackTrend * home.defenseTrend;

  return {
    lambdaH: clamp(lambdaH, 0.25, 3.6),
    lambdaA: clamp(lambdaA, 0.20, 3.3)
  };
}

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
      const x2 = awayWin || draw;
      const o15 = total > 1;
      const o25 = total > 2;
      const u25 = total < 3;
      const u35 = total < 4;
      const btts = h > 0 && a > 0;

      if (homeWin) markets["1"] += p;
      if (draw) markets["X"] += p;
      if (awayWin) markets["2"] += p;
      if (oneX) markets["1X"] += p;
      if (x2) markets["X2"] += p;
      if (o15) markets["O1.5"] += p;
      if (o25) markets["O2.5"] += p;
      if (u25) markets["U2.5"] += p;
      if (u35) markets["U3.5"] += p;
      if (btts) markets["BTTS"] += p;

      if (homeWin && o15) markets["1 + O1.5"] += p;
      if (homeWin && o25) markets["1 + O2.5"] += p;
      if (homeWin && u25) markets["1 + U2.5"] += p;
      if (homeWin && u35) markets["1 + U3.5"] += p;
      if (draw && o15) markets["X + O1.5"] += p;
      if (draw && o25) markets["X + O2.5"] += p;
      if (draw && u25) markets["X + U2.5"] += p;
      if (draw && u35) markets["X + U3.5"] += p;
      if (awayWin && o15) markets["2 + O1.5"] += p;
      if (awayWin && o25) markets["2 + O2.5"] += p;
      if (awayWin && u25) markets["2 + U2.5"] += p;
      if (awayWin && u35) markets["2 + U3.5"] += p;
      if (oneX && o15) markets["1X + O1.5"] += p;
      if (oneX && o25) markets["1X + O2.5"] += p;
      if (oneX && u25) markets["1X + U2.5"] += p;
      if (oneX && u35) markets["1X + U3.5"] += p;
      if (x2 && o15) markets["X2 + O1.5"] += p;
      if (x2 && o25) markets["X2 + O2.5"] += p;
      if (x2 && u25) markets["X2 + U2.5"] += p;
      if (x2 && u35) markets["X2 + U3.5"] += p;
      if (btts && o15) markets["BTTS + O1.5"] += p;
      if (btts && o25) markets["BTTS + O2.5"] += p;
    }
  }

  return markets;
}

function marketFamily(label) {
  if (label.includes("BTTS")) return "btts";
  if (label.includes("O") || label.includes("U")) return "goals";
  if (label.includes("1X") || label.includes("X2")) return "doublechance";
  if (["1", "2"].includes(label)) return "result";
  return label;
}

function marketQuality(label) {
  if (["O1.5", "U3.5", "1X", "X2"].includes(label)) return 0.92;
  if (["O2.5", "U2.5", "BTTS", "1", "2"].includes(label)) return 1.03;
  if (label.includes(" + ")) return 1.08;
  return 1;
}

function adjustMarket(label, probability, home, away, leagueAvg) {
  const parts = label.split(" + ");
  let factor = 1;

  for (const part of parts) {
    if (part === "BTTS") factor *= clamp(1 + (((home.rates.btts + away.rates.btts) / 2) - leagueAvg.btts) * 0.22, 0.92, 1.08);
    if (part === "O1.5") factor *= clamp(1 + (((home.rates.o15 + away.rates.o15) / 2) - leagueAvg.o15) * 0.16, 0.94, 1.06);
    if (part === "O2.5") factor *= clamp(1 + (((home.rates.o25 + away.rates.o25) / 2) - leagueAvg.o25) * 0.20, 0.92, 1.08);
    if (part === "U2.5") factor *= clamp(1 + (((home.rates.u25 + away.rates.u25) / 2) - leagueAvg.u25) * 0.18, 0.92, 1.08);
    if (part === "U3.5") factor *= clamp(1 + (((home.rates.u35 + away.rates.u35) / 2) - leagueAvg.u35) * 0.16, 0.94, 1.06);
    if (part === "1" || part === "1X") factor *= clamp(1 + (home.ppg - away.ppg) * 0.035, 0.94, 1.06);
    if (part === "2" || part === "X2") factor *= clamp(1 + (away.ppg - home.ppg) * 0.035, 0.94, 1.06);
  }

  return clamp(probability * factor, 0.01, 0.96);
}

function isSafeMarket(label) {
  if (label === "X") return false;
  if (label.startsWith("X +")) return false;

  const base = new Set(["1X", "X2", "O1.5", "U3.5", "U2.5", "O2.5", "BTTS", "1", "2"]);
  if (base.has(label)) return true;

  const combos = new Set([
    "1X + O1.5", "1X + U3.5", "1X + U2.5",
    "X2 + O1.5", "X2 + U3.5", "X2 + U2.5",
    "1 + O1.5", "1 + U3.5",
    "2 + O1.5", "2 + U3.5",
    "BTTS + O1.5"
  ]);

  return combos.has(label);
}

function minimumSafeProbability(label) {
  if (["1X", "X2", "O1.5", "U3.5"].includes(label)) return 0.64;
  if (["U2.5", "O2.5", "BTTS", "1", "2"].includes(label)) return 0.58;
  if (label.includes(" + ")) return 0.60;
  return 0.62;
}

function calculateSafePicks(lambdaH, lambdaA, home, away, leagueAvg) {
  const markets = calculateMarkets(lambdaH, lambdaA);

  const safeBets = Object.entries(markets)
    .map(([label, p]) => ({ label, pct: adjustMarket(label, p, home, away, leagueAvg), quality: marketQuality(label) }))
    .filter(b => isSafeMarket(b.label))
    .filter(b => b.pct >= minimumSafeProbability(b.label))
    .filter(b => b.pct <= 0.94)
    .sort((a, b) => (b.pct * b.quality) - (a.pct * a.quality));

  const result = [];

  for (const bet of safeBets) {
    if (result.length >= 2) break;
    const sameFamily = result.some(existing => marketFamily(existing.label) === marketFamily(bet.label));
    const sameLabel = result.some(existing => existing.label === bet.label);

    if (!sameFamily && !sameLabel) {
      result.push({ ...bet, type: "safe" });
    }
  }

  if (result.length < 2) {
    for (const bet of safeBets) {
      if (result.length >= 2) break;
      if (!result.some(existing => existing.label === bet.label)) {
        result.push({ ...bet, type: "safe" });
      }
    }
  }

  return result.slice(0, 2);
}

function diversityMultiplier(bets) {
  const familyCount = new Set(bets.map(b => marketFamily(b.label))).size;
  if (familyCount >= 2) return 1.04;
  return 0.96;
}

function topScore(match) {
  const first = match.bets[0]?.pct || 0;
  const second = match.bets[1]?.pct || 0;
  const base = first * 0.65 + second * 0.35;
  const quality = average(match.bets.map(b => marketQuality(b.label)), 1);
  const reliabilityFactor = clamp(0.88 + ((match.homeProfile.reliability + match.awayProfile.reliability) / 2) * 0.18, 0.88, 1.06);
  const genericPenalty = match.bets.every(b => ["O1.5", "U3.5", "1X", "X2"].includes(b.label)) ? 0.94 : 1;
  return base * quality * diversityMultiplier(match.bets) * reliabilityFactor * genericPenalty;
}

async function loadLeagues() {
  const season = getSeasonYear();
  const previous = season - 1;
  const all = [];

  for (const league of LEAGUES) {
    const previousRows = await loadFeed(`${league.slug}-${previous}`);
    const currentRows = await loadFeed(`${league.slug}-${season}`);

    const previousMatches = previousRows.map(row => normalize(row, league.name)).filter(m => m.home && m.away);
    const currentMatches = currentRows.map(row => normalize(row, league.name)).filter(m => m.home && m.away);

    const previousPlayed = previousMatches.filter(m => m.played);
    const currentPlayed = currentMatches.filter(m => m.played);
    const upcoming = currentMatches.filter(m => !m.played && m.parsedDate);
    const targets = selectNextMatchday(upcoming);

    if (!targets.length) {
      console.log(`${league.name}: nessuna partita futura trovata.`);
      continue;
    }

    console.log(`${league.name}: giornata ${targets[0].round ?? "N/D"}, partite ${targets.length}.`);

    const survival = computeSurvivalProfile(previousPlayed);
    const leagueAvg = computeLeagueAvg(currentPlayed, previousPlayed);

    for (const match of targets) {
      const homeProfile = profile(match.home, "home", currentPlayed, previousPlayed, survival, leagueAvg);
      const awayProfile = profile(match.away, "away", currentPlayed, previousPlayed, survival, leagueAvg);
      const { lambdaH, lambdaA } = expectedGoals(homeProfile, awayProfile, leagueAvg);
      const bets = calculateSafePicks(lambdaH, lambdaA, homeProfile, awayProfile, leagueAvg);

      if (bets.length >= 2) {
        const enriched = { ...match, lambdaH, lambdaA, bets, homeProfile, awayProfile, leagueAvg };
        enriched.topScore = topScore(enriched);
        all.push(enriched);
      }
    }
  }

  return all.sort(byDateAsc);
}

function pickLabel(bet) {
  if (!bet) return "N/D";
  return SHOW_NUMBERS ? `${bet.label} (${pct(bet.pct)})` : bet.label;
}

function sortByTopScore(matches) {
  return [...matches].sort((a, b) => b.topScore - a.topScore);
}

function buildSafeTicketMessage(matches) {
  const selected = sortByTopScore(matches).slice(0, TOP_LIMIT);
  let msg = "✅ SCHEDINA SICURA DELLA SETTIMANA\n\n";
  msg += "🎯 10 partite con due pronostici sicuri\n";
  msg += "📌 Criterio: probabilità alta + dati affidabili + mercati non estremi\n\n";

  selected.forEach((m, index) => {
    const date = formatDateShort(m.date);
    msg += `${index + 1}. ${m.home} - ${m.away}\n`;
    if (m.round !== null || date) {
      msg += `📅 ${m.round !== null ? `Giornata ${m.round}` : ""}${m.round !== null && date ? " - " : ""}${date}\n`;
    }
    msg += `➡️ ${pickLabel(m.bets[0])} | ${pickLabel(m.bets[1])}\n`;
    if (SHOW_NUMBERS) msg += `📊 Score: ${m.topScore.toFixed(3)}\n`;
    msg += "\n";
  });

  msg += "━━━━━━━━━━━━━━━\n⚠️ Analisi statistica automatica, non garanzia di risultato.";
  return msg;
}

function formatMatchCompact(m) {
  const date = formatDateShort(m.date);
  let msg = `⚽ ${m.home} - ${m.away}`;
  if (date) msg += `\n🗓 ${date}`;
  if (m.round !== null) msg += ` | Giornata ${m.round}`;
  msg += `\n✅ ${pickLabel(m.bets[0])}`;
  msg += `\n✅ ${pickLabel(m.bets[1])}`;
  if (SHOW_NUMBERS) msg += `\n📊 xG: ${m.lambdaH.toFixed(2)} - ${m.lambdaA.toFixed(2)} | Score: ${m.topScore.toFixed(3)}`;
  return msg;
}

function buildLeagueMessage(league, matches) {
  const sorted = [...matches].sort(byDateAsc);
  const round = sorted.find(m => m.round !== null)?.round;
  let msg = `📊 ${league}`;
  if (round !== undefined && round !== null) msg += ` - Giornata ${round}`;
  msg += "\n\n✅ Due pronostici sicuri per partita\n━━━━━━━━━━━━━━━\n\n";

  for (const m of sorted) {
    msg += `${formatMatchCompact(m)}\n\n`;
  }

  msg += "━━━━━━━━━━━━━━━\n📌 Rimossi i pronostici equilibrati/value. Restano solo pick con soglia di probabilità alta.";
  return msg;
}

function buildMessages(matches, title) {
  const messages = [];
  let intro = `🔥 ${title} 🔥\n\n`;

  if (TEST_MODE) {
    intro += "🧪 Modalità test attiva\n";
    intro += `👥 File utenti: ${USERS_FILE}\n\n`;
  }

  intro += "📌 Invio diviso in più messaggi per evitare tagli Telegram:\n";
  intro += "1️⃣ Schedina sicura\n";
  intro += "2️⃣ Dettaglio per campionato\n\n";
  intro += `Partite analizzate: ${matches.length}`;

  messages.push(intro);
  messages.push(buildSafeTicketMessage(matches));

  const byLeague = {};
  for (const match of matches) {
    if (!byLeague[match.league]) byLeague[match.league] = [];
    byLeague[match.league].push(match);
  }

  for (const league of Object.keys(byLeague)) {
    messages.push(buildLeagueMessage(league, byLeague[league]));
  }

  return messages;
}

async function run() {
  try {
    console.log(`Modalità test: ${TEST_MODE}`);
    console.log(`File utenti utilizzato: ${USERS_FILE}`);

    const matches = await loadLeagues();
    if (!matches.length) {
      console.log("Nessuna partita trovata con almeno due pronostici sicuri. Nessun messaggio inviato.");
      return;
    }

    const title = TEST_MODE ? "TEST GIORNATE CAMPIONATI" : "WEEKEND PICKS";
    const messages = buildMessages(matches, title);
    await sendMessagesToAll(messages);

    console.log(`Messaggi inviati: ${messages.length}. Partite analizzate: ${matches.length}`);
  } catch (err) {
    console.error("Errore esecuzione bot:", err);
    process.exitCode = 1;
  }
}

run();
