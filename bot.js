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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(values, fallback = 0) {
  const valid = values.filter(v => Number.isFinite(v));
  if (!valid.length) return fallback;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function safeDiv(a, b, fallback = 1) {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : fallback;
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
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
  for (const p of parts) map[p.type] = p.value;
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
  const d = parseDate(value);
  if (!d) return "";

  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function getRawDate(row) {
  return row.DateUtc || row.MatchDate || row.Date || row.DateTime || row.UtcDate || null;
}

function hasScore(row) {
  return row.HomeTeamScore !== null && row.HomeTeamScore !== undefined && row.HomeTeamScore !== "" &&
         row.AwayTeamScore !== null && row.AwayTeamScore !== undefined && row.AwayTeamScore !== "";
}

function roundNum(value) {
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
    round: roundNum(row.RoundNumber),
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
  let r = 1;
  for (let i = 2; i <= k; i++) r *= i;
  return r;
}

function poisson(lambda, k) {
  const l = Math.max(0.1, lambda);
  return (Math.pow(l, k) * Math.exp(-l)) / factorial(k);
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
    gf: clamp(avg(bottom.map(t => t.gf / t.p), 1.0), 0.6, 1.3),
    ga: clamp(avg(bottom.map(t => t.ga / t.p), 1.65), 1.3, 2.2)
  };
}

function rawLeagueAvg(matches) {
  if (!matches.length) {
    return { homeGoals: 1.45, awayGoals: 1.15, btts: 0.52, o15: 0.72, o25: 0.50, u25: 0.50, u35: 0.73 };
  }

  return {
    homeGoals: avg(matches.map(m => m.hg), 1.45),
    awayGoals: avg(matches.map(m => m.ag), 1.15),
    btts: avg(matches.map(m => m.hg > 0 && m.ag > 0 ? 1 : 0), 0.52),
    o15: avg(matches.map(m => m.hg + m.ag > 1 ? 1 : 0), 0.72),
    o25: avg(matches.map(m => m.hg + m.ag > 2 ? 1 : 0), 0.50),
    u25: avg(matches.map(m => m.hg + m.ag <= 2 ? 1 : 0), 0.50),
    u35: avg(matches.map(m => m.hg + m.ag <= 3 ? 1 : 0), 0.73)
  };
}

function computeLeagueAvg(currentPlayed, previousPlayed) {
  const cw = currentPlayed.length >= 20 ? 0.7 : 0.45;
  const pw = 1 - cw;
  const c = rawLeagueAvg(currentPlayed);
  const p = rawLeagueAvg(previousPlayed);

  return {
    homeGoals: clamp(c.homeGoals * cw + p.homeGoals * pw, 0.8, 2.3),
    awayGoals: clamp(c.awayGoals * cw + p.awayGoals * pw, 0.6, 2.0),
    btts: clamp(c.btts * cw + p.btts * pw, 0.25, 0.75),
    o15: clamp(c.o15 * cw + p.o15 * pw, 0.45, 0.90),
    o25: clamp(c.o25 * cw + p.o25 * pw, 0.25, 0.75),
    u25: clamp(c.u25 * cw + p.u25 * pw, 0.25, 0.75),
    u35: clamp(c.u35 * cw + p.u35 * pw, 0.45, 0.90)
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
    const home = m.home === team;
    const gf = home ? m.hg : m.ag;
    const ga = home ? m.ag : m.hg;
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
    gf: avg(values.map(v => v.gf), fallbackGF),
    ga: avg(values.map(v => v.ga), fallbackGA),
    ppg: avg(values.map(v => v.pts), 1.0),
    btts: avg(values.map(v => v.btts), 0.5),
    o15: avg(values.map(v => v.o15), 0.70),
    o25: avg(values.map(v => v.o25), 0.50),
    u25: avg(values.map(v => v.u25), 0.50),
    u35: avg(values.map(v => v.u35), 0.72)
  };
}

function slope(values) {
  if (values.length < 3) return 0;
  const xs = values.map((_, i) => i + 1);
  const ax = avg(xs, 0);
  const ay = avg(values, 0);
  let num = 0;
  let den = 0;

  for (let i = 0; i < values.length; i++) {
    num += (xs[i] - ax) * (values[i] - ay);
    den += Math.pow(xs[i] - ax, 2);
  }

  return den ? num / den : 0;
}

function trendFactors(team, games) {
  const recent = [...games].sort(byDateAsc).slice(-5);
  const vals = valuesFor(team, recent);
  if (vals.length < 3) return { attack: 1, defense: 1 };

  return {
    attack: clamp(1 + slope(vals.map(v => v.gf)) * 0.04, 0.94, 1.06),
    defense: clamp(1 + slope(vals.map(v => v.ga)) * 0.035, 0.94, 1.06)
  };
}

function weighted(parts) {
  const valid = parts.filter(p => Number.isFinite(p.value) && p.weight > 0);
  const sw = valid.reduce((s, p) => s + p.weight, 0);
  if (!sw) return 0;
  return valid.reduce((s, p) => s + p.value * p.weight, 0) / sw;
}

function formFactor(ppg) {
  return clamp(1 + (ppg - 1.3) * 0.07, 0.90, 1.10);
}

function reliability(games) {
  return clamp(games / 10, 0.35, 1);
}

function profile(team, venue, currentPlayed, previousPlayed, survival, leagueAvg) {
  const curAll = teamGames(team, currentPlayed);
  const prevAll = teamGames(team, previousPlayed);
  const curVenue = teamVenueGames(team, currentPlayed, venue);
  const prevVenue = teamVenueGames(team, previousPlayed, venue);

  const r5 = summarize(valuesFor(team, curAll.slice(0, 5)), survival.gf, survival.ga);
  const r10 = summarize(valuesFor(team, curAll.slice(0, TEAM_FORM_N)), survival.gf, survival.ga);
  const cv = summarize(valuesFor(team, curVenue), survival.gf, survival.ga);
  const pv = summarize(valuesFor(team, prevVenue), survival.gf, survival.ga);
  const pa = summarize(valuesFor(team, prevAll), survival.gf, survival.ga);

  const promoted = pa.games === 0;
  const cg = curAll.length;
  const fallbackW = promoted ? clamp(1 - cg / 10, 0.10, 1) : clamp(0.20 - cg * 0.015, 0.05, 0.20);

  const gf = weighted([
    { value: r5.gf, weight: cg >= 5 ? 0.34 : 0.16 },
    { value: r10.gf, weight: cg >= 8 ? 0.24 : 0.14 },
    { value: cv.gf, weight: cv.games >= 3 ? 0.26 : 0.12 },
    { value: pv.gf, weight: promoted ? 0 : 0.18 },
    { value: pa.gf, weight: promoted ? 0 : 0.08 },
    { value: survival.gf, weight: fallbackW }
  ]);

  const ga = weighted([
    { value: r5.ga, weight: cg >= 5 ? 0.34 : 0.16 },
    { value: r10.ga, weight: cg >= 8 ? 0.24 : 0.14 },
    { value: cv.ga, weight: cv.games >= 3 ? 0.26 : 0.12 },
    { value: pv.ga, weight: promoted ? 0 : 0.18 },
    { value: pa.ga, weight: promoted ? 0 : 0.08 },
    { value: survival.ga, weight: fallbackW }
  ]);

  const ppg = weighted([
    { value: r5.ppg, weight: 0.55 },
    { value: r10.ppg, weight: 0.30 },
    { value: pa.ppg, weight: promoted ? 0 : 0.15 },
    { value: 0.9, weight: promoted ? fallbackW : 0 }
  ]);

  const trend = trendFactors(team, curAll.slice(0, 5));

  const rates = {
    btts: weighted([{ value: r10.btts, weight: 0.5 }, { value: cv.btts, weight: 0.25 }, { value: pa.btts, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.btts, weight: 0.1 }]),
    o15: weighted([{ value: r10.o15, weight: 0.5 }, { value: cv.o15, weight: 0.25 }, { value: pa.o15, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.o15, weight: 0.1 }]),
    o25: weighted([{ value: r10.o25, weight: 0.5 }, { value: cv.o25, weight: 0.25 }, { value: pa.o25, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.o25, weight: 0.1 }]),
    u25: weighted([{ value: r10.u25, weight: 0.5 }, { value: cv.u25, weight: 0.25 }, { value: pa.u25, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.u25, weight: 0.1 }]),
    u35: weighted([{ value: r10.u35, weight: 0.5 }, { value: cv.u35, weight: 0.25 }, { value: pa.u35, weight: promoted ? 0 : 0.15 }, { value: leagueAvg.u35, weight: 0.1 }])
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
    reliability: reliability(cg + Math.min(pa.games, 10) * 0.6),
    rates,
    promoted
  };
}

function expectedGoals(home, away, leagueAvg) {
  let h = leagueAvg.homeGoals * safeDiv(home.gf, leagueAvg.homeGoals) * safeDiv(away.ga, leagueAvg.homeGoals);
  let a = leagueAvg.awayGoals * safeDiv(away.gf, leagueAvg.awayGoals) * safeDiv(home.ga, leagueAvg.awayGoals);

  h *= home.formFactor * home.attackTrend * away.defenseTrend;
  a *= away.formFactor * away.attackTrend * home.defenseTrend;

  return { lambdaH: clamp(h, 0.25, 3.6), lambdaA: clamp(a, 0.20, 3.3) };
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
  const m = Object.fromEntries(labels.map(l => [l, 0]));

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poisson(lambdaH, h) * poisson(lambdaA, a);
      const total = h + a;
      const hw = h > a;
      const dr = h === a;
      const aw = h < a;
      const x1 = hw || dr;
      const x2 = aw || dr;
      const o15 = total > 1;
      const o25 = total > 2;
      const u25 = total < 3;
      const u35 = total < 4;
      const btts = h > 0 && a > 0;

      if (hw) m["1"] += p;
      if (dr) m["X"] += p;
      if (aw) m["2"] += p;
      if (x1) m["1X"] += p;
      if (x2) m["X2"] += p;
      if (o15) m["O1.5"] += p;
      if (o25) m["O2.5"] += p;
      if (u25) m["U2.5"] += p;
      if (u35) m["U3.5"] += p;
      if (btts) m["BTTS"] += p;

      if (hw && o15) m["1 + O1.5"] += p;
      if (hw && o25) m["1 + O2.5"] += p;
      if (hw && u25) m["1 + U2.5"] += p;
      if (hw && u35) m["1 + U3.5"] += p;
      if (dr && o15) m["X + O1.5"] += p;
      if (dr && o25) m["X + O2.5"] += p;
      if (dr && u25) m["X + U2.5"] += p;
      if (dr && u35) m["X + U3.5"] += p;
      if (aw && o15) m["2 + O1.5"] += p;
      if (aw && o25) m["2 + O2.5"] += p;
      if (aw && u25) m["2 + U2.5"] += p;
      if (aw && u35) m["2 + U3.5"] += p;
      if (x1 && o15) m["1X + O1.5"] += p;
      if (x1 && o25) m["1X + O2.5"] += p;
      if (x1 && u25) m["1X + U2.5"] += p;
      if (x1 && u35) m["1X + U3.5"] += p;
      if (x2 && o15) m["X2 + O1.5"] += p;
      if (x2 && o25) m["X2 + O2.5"] += p;
      if (x2 && u25) m["X2 + U2.5"] += p;
      if (x2 && u35) m["X2 + U3.5"] += p;
      if (btts && o15) m["BTTS + O1.5"] += p;
      if (btts && o25) m["BTTS + O2.5"] += p;
    }
  }

  return m;
}

function marketQuality(label) {
  if (["O1.5", "U3.5", "1X", "X2"].includes(label)) return 0.90;
  if (["O2.5", "U2.5", "BTTS", "1", "2"].includes(label)) return 1.03;
  if (label.includes(" + ")) return 1.13;
  if (label === "X") return 0.96;
  return 1;
}

function adjustMarket(label, p, home, away, leagueAvg) {
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
    if (part === "X") factor *= clamp(1 - Math.abs(home.ppg - away.ppg) * 0.035, 0.94, 1.04);
  }

  return clamp(p * factor, 0.01, 0.96);
}

function calculatePicks(lambdaH, lambdaA, home, away, leagueAvg) {
  const markets = calculateMarkets(lambdaH, lambdaA);
  const bets = Object.entries(markets)
    .map(([label, p]) => ({ label, pct: adjustMarket(label, p, home, away, leagueAvg), quality: marketQuality(label) }))
    .filter(b => b.pct >= 0.35 && b.pct <= 0.92)
    .sort((a, b) => (b.pct * b.quality) - (a.pct * a.quality));

  const result = [];
  const safe = bets.find(b => b.pct >= 0.70);
  const mid = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  const value = bets.find(b => b.pct < 0.55 && b.pct >= 0.40);
  if (safe) result.push({ ...safe, type: "safe" });
  if (mid) result.push({ ...mid, type: "mid" });
  if (value) result.push({ ...value, type: "value" });

  for (const b of bets) {
    if (result.length >= 3) break;
    if (!result.some(x => x.label === b.label)) result.push({ ...b, type: result.length === 0 ? "safe" : result.length === 1 ? "mid" : "value" });
  }

  return result.slice(0, 3);
}

function family(label) {
  if (label.includes("BTTS")) return "btts";
  if (label.includes("O") || label.includes("U")) return "goals";
  if (label.includes("1X") || label.includes("X2")) return "doublechance";
  if (["1", "X", "2"].includes(label)) return "result";
  return label;
}

function diversity(bets) {
  const n = new Set(bets.map(b => family(b.label))).size;
  return n >= 3 ? 1.06 : n === 2 ? 1 : 0.94;
}

function topScore(match) {
  const base = (match.bets[0].pct * 0.5) + (match.bets[1].pct * 0.3) + (match.bets[2].pct * 0.2);
  const q = avg(match.bets.map(b => marketQuality(b.label)), 1);
  const r = clamp(0.88 + ((match.homeProfile.reliability + match.awayProfile.reliability) / 2) * 0.18, 0.88, 1.06);
  const genericPenalty = match.bets.every(b => ["O1.5", "U3.5", "1X", "X2"].includes(b.label)) ? 0.92 : 1;
  return base * q * diversity(match.bets) * r * genericPenalty;
}

async function loadLeagues() {
  const season = getSeasonYear();
  const previous = season - 1;
  const all = [];

  for (const league of LEAGUES) {
    const prevRows = await loadFeed(`${league.slug}-${previous}`);
    const curRows = await loadFeed(`${league.slug}-${season}`);

    const prevMatches = prevRows.map(r => normalize(r, league.name)).filter(m => m.home && m.away);
    const curMatches = curRows.map(r => normalize(r, league.name)).filter(m => m.home && m.away);
    const previousPlayed = prevMatches.filter(m => m.played);
    const currentPlayed = curMatches.filter(m => m.played);
    const upcoming = curMatches.filter(m => !m.played && m.parsedDate);
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
      const bets = calculatePicks(lambdaH, lambdaA, homeProfile, awayProfile, leagueAvg);

      if (bets.length >= 3) {
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

function sortByValueScore(matches) {
  return [...matches].sort((a, b) => {
    const av = a.bets[2]?.pct || 0;
    const bv = b.bets[2]?.pct || 0;
    return (bv * marketQuality(b.bets[2]?.label || "") * b.topScore) - (av * marketQuality(a.bets[2]?.label || "") * a.topScore);
  });
}

function buildSafeTicketMessage(matches) {
  const selected = sortByTopScore(matches).slice(0, TOP_LIMIT);
  let msg = "✅ SCHEDINA SICURA DELLA SETTIMANA\n\n";
  msg += "🎯 10 eventi più solidi secondo il modello\n";
  msg += "📌 Criterio: probabilità + affidabilità dati + qualità mercato\n\n";

  selected.forEach((m, i) => {
    msg += `${i + 1}. ${m.home} - ${m.away}\n`;
    const d = formatDateShort(m.date);
    if (m.round !== null || d) msg += `📅 ${m.round !== null ? `Giornata ${m.round}` : ""}${m.round !== null && d ? " - " : ""}${d}\n`;
    msg += `➡️ ${pickLabel(m.bets[0])}\n`;
    if (SHOW_NUMBERS) msg += `📊 Probabilità: ${pct(m.bets[0].pct)} | Score: ${m.topScore.toFixed(3)}\n`;
    msg += "\n";
  });

  msg += "━━━━━━━━━━━━━━━\n⚠️ Analisi statistica automatica, non garanzia di risultato.";
  return msg;
}

function buildBombTicketMessage(matches) {
  const selected = sortByValueScore(matches).slice(0, TOP_LIMIT);
  let msg = "🔥 SCHEDINA BOMBA DELLA SETTIMANA\n\n";
  msg += "🚀 10 eventi più spinti e interessanti\n";
  msg += "📌 Criterio: pick value + combo + qualità mercato\n\n";

  selected.forEach((m, i) => {
    msg += `${i + 1}. ${m.home} - ${m.away}\n`;
    const d = formatDateShort(m.date);
    if (m.round !== null || d) msg += `📅 ${m.round !== null ? `Giornata ${m.round}` : ""}${m.round !== null && d ? " - " : ""}${d}\n`;
    msg += `➡️ ${pickLabel(m.bets[2])}\n`;
    if (SHOW_NUMBERS) msg += `📊 Probabilità: ${pct(m.bets[2].pct)} | Score: ${m.topScore.toFixed(3)}\n`;
    msg += "\n";
  });

  msg += "━━━━━━━━━━━━━━━\n⚠️ Selezione più aggressiva: rischio più alto, valore teorico maggiore.";
  return msg;
}

function formatMatchCompact(m) {
  const d = formatDateShort(m.date);
  let msg = `⚽ ${m.home} - ${m.away}`;
  if (d) msg += `\n🗓 ${d}`;
  if (m.round !== null) msg += ` | Giornata ${m.round}`;
  msg += `\n✅ ${pickLabel(m.bets[0])}`;
  msg += `\n⚖️ ${pickLabel(m.bets[1])}`;
  msg += `\n🔥 ${pickLabel(m.bets[2])}`;
  if (SHOW_NUMBERS) msg += `\n📊 xG: ${m.lambdaH.toFixed(2)} - ${m.lambdaA.toFixed(2)} | Score: ${m.topScore.toFixed(3)}`;
  return msg;
}

function buildLeagueMessage(league, matches) {
  const sorted = [...matches].sort(byDateAsc);
  const round = sorted.find(m => m.round !== null)?.round;
  let msg = `📊 ${league}`;
  if (round !== undefined && round !== null) msg += ` - Giornata ${round}`;
  msg += "\n\n✅ Sicuro | ⚖️ Bilanciato | 🔥 Value\n━━━━━━━━━━━━━━━\n\n";

  for (const m of sorted) msg += `${formatMatchCompact(m)}\n\n`;

  msg += "━━━━━━━━━━━━━━━\n📌 Modello: forma recente, casa/trasferta, media campionato, trend gol e Poisson.";
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
  intro += "1️⃣ Schedina sicura\n2️⃣ Schedina bomba\n3️⃣ Dettaglio per campionato\n\n";
  intro += `Partite analizzate: ${matches.length}`;

  messages.push(intro, buildSafeTicketMessage(matches), buildBombTicketMessage(matches));

  const byLeague = {};
  for (const m of matches) {
    if (!byLeague[m.league]) byLeague[m.league] = [];
    byLeague[m.league].push(m);
  }

  for (const league of Object.keys(byLeague)) messages.push(buildLeagueMessage(league, byLeague[league]));
  return messages;
}

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
    const messages = buildMessages(matches, title);
    await sendMessagesToAll(messages);

    console.log(`Messaggi inviati: ${messages.length}. Partite analizzate: ${matches.length}`);
  } catch (err) {
    console.error("Errore esecuzione bot:", err);
    process.exitCode = 1;
  }
}

run();
