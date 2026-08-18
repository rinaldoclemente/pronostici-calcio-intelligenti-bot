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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function avg(values, fallback = 0) { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : fallback; }
function safeDiv(a, b, fb = 1) { return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : fb; }
function pct(v) { return `${Math.round(v * 100)}%`; }

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
  if (!res.ok) console.log(`Errore invio a ${chatId}: ${res.status} ${await res.text()}`);
}

async function sendMessagesToAll(messages) {
  if (!TOKEN) return console.log("BOT_TOKEN mancante. Invio Telegram non eseguito.");
  const users = loadUsers();
  if (!users.length) return console.log(`Nessun utente trovato in ${USERS_FILE}.`);
  for (const user of users) {
    for (const message of messages) {
      await sendTelegram(user, message);
      await sleep(900);
    }
  }
}

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return { year: Number(m.year), month: Number(m.month), day: Number(m.day) };
}
function seasonYear() { const { year, month } = localParts(); return month >= 8 ? year : year - 1; }

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
  return new Intl.DateTimeFormat("it-IT", { timeZone: TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function rawDate(row) { return row.DateUtc || row.MatchDate || row.Date || row.DateTime || row.UtcDate || null; }
function hasScore(row) { return row.HomeTeamScore !== null && row.HomeTeamScore !== undefined && row.HomeTeamScore !== "" && row.AwayTeamScore !== null && row.AwayTeamScore !== undefined && row.AwayTeamScore !== ""; }
function roundNumber(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalize(row, league) {
  const played = hasScore(row);
  const date = rawDate(row);
  return { league, home: row.HomeTeam, away: row.AwayTeam, hg: played ? Number(row.HomeTeamScore) : null, ag: played ? Number(row.AwayTeamScore) : null, date, parsedDate: parseDate(date), round: roundNumber(row.RoundNumber), played };
}

async function loadFeed(slug) {
  try {
    const res = await fetch(BASE_URL + slug);
    if (!res.ok) { console.log(`Feed non disponibile: ${slug} - ${res.status}`); return []; }
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) { console.log(`Errore caricamento ${slug}:`, err.message); return []; }
}

function byDateAsc(a, b) { return (a.parsedDate?.getTime() || 0) - (b.parsedDate?.getTime() || 0); }
function byDateDesc(a, b) { return (b.parsedDate?.getTime() || 0) - (a.parsedDate?.getTime() || 0); }

function selectNextMatchday(upcoming) {
  const future = upcoming.filter(m => m.parsedDate && m.parsedDate.getTime() >= Date.now()).sort(byDateAsc);
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

function factorial(k) { let r = 1; for (let i = 2; i <= k; i++) r *= i; return r; }
function poisson(lambda, k) { const l = Math.max(0.1, lambda); return (Math.pow(l, k) * Math.exp(-l)) / factorial(k); }

function teamTable(matches) {
  const teams = {};
  for (const m of matches) {
    if (!teams[m.home]) teams[m.home] = { p: 0, gf: 0, ga: 0, pts: 0 };
    if (!teams[m.away]) teams[m.away] = { p: 0, gf: 0, ga: 0, pts: 0 };
    teams[m.home].p++; teams[m.home].gf += m.hg; teams[m.home].ga += m.ag;
    teams[m.away].p++; teams[m.away].gf += m.ag; teams[m.away].ga += m.hg;
    if (m.hg > m.ag) teams[m.home].pts += 3;
    else if (m.hg < m.ag) teams[m.away].pts += 3;
    else { teams[m.home].pts++; teams[m.away].pts++; }
  }
  return Object.values(teams);
}

function survivalProfile(previousPlayed) {
  const table = teamTable(previousPlayed).filter(t => t.p > 0).sort((a, b) => (a.pts / a.p) - (b.pts / b.p));
  if (!table.length) return { gf: 1.0, ga: 1.65 };
  const bottom = table.slice(0, Math.max(3, Math.ceil(table.length * 0.2)));
  return { gf: clamp(avg(bottom.map(t => t.gf / t.p), 1.0), 0.6, 1.3), ga: clamp(avg(bottom.map(t => t.ga / t.p), 1.65), 1.3, 2.2) };
}

function rawLeagueAvg(matches) {
  if (!matches.length) return { homeGoals: 1.45, awayGoals: 1.15, btts: 0.52, o15: 0.72, o25: 0.50, u25: 0.50, u35: 0.73 };
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

function leagueAvg(currentPlayed, previousPlayed) {
  const cw = currentPlayed.length >= 20 ? 0.70 : 0.45;
  const pw = 1 - cw;
  const c = rawLeagueAvg(currentPlayed), p = rawLeagueAvg(previousPlayed);
  return { homeGoals: clamp(c.homeGoals * cw + p.homeGoals * pw, 0.8, 2.3), awayGoals: clamp(c.awayGoals * cw + p.awayGoals * pw, 0.6, 2.0), btts: clamp(c.btts * cw + p.btts * pw, 0.25, 0.75), o15: clamp(c.o15 * cw + p.o15 * pw, 0.45, 0.90), o25: clamp(c.o25 * cw + p.o25 * pw, 0.25, 0.75), u25: clamp(c.u25 * cw + p.u25 * pw, 0.25, 0.75), u35: clamp(c.u35 * cw + p.u35 * pw, 0.45, 0.90) };
}

function teamGames(team, matches) { return matches.filter(m => m.home === team || m.away === team).sort(byDateDesc); }
function teamVenueGames(team, matches, venue) { return matches.filter(m => venue === "home" ? m.home === team : m.away === team).sort(byDateDesc); }

function valuesFor(team, games) {
  return games.map(m => {
    const isHome = m.home === team;
    const gf = isHome ? m.hg : m.ag;
    const ga = isHome ? m.ag : m.hg;
    const total = gf + ga;
    return { gf, ga, pts: gf > ga ? 3 : gf === ga ? 1 : 0, btts: gf > 0 && ga > 0 ? 1 : 0, o15: total > 1 ? 1 : 0, o25: total > 2 ? 1 : 0, u25: total <= 2 ? 1 : 0, u35: total <= 3 ? 1 : 0 };
  });
}

function summarize(values, fGF, fGA) {
  if (!values.length) return { games: 0, gf: fGF, ga: fGA, ppg: 1.0, btts: 0.5, o15: 0.70, o25: 0.50, u25: 0.50, u35: 0.72 };
  return { games: values.length, gf: avg(values.map(v => v.gf), fGF), ga: avg(values.map(v => v.ga), fGA), ppg: avg(values.map(v => v.pts), 1.0), btts: avg(values.map(v => v.btts), 0.5), o15: avg(values.map(v => v.o15), 0.70), o25: avg(values.map(v => v.o25), 0.50), u25: avg(values.map(v => v.u25), 0.50), u35: avg(values.map(v => v.u35), 0.72) };
}

function slope(values) {
  if (values.length < 3) return 0;
  const xs = values.map((_, i) => i + 1), ax = avg(xs, 0), ay = avg(values, 0);
  let n = 0, d = 0;
  for (let i = 0; i < values.length; i++) { n += (xs[i] - ax) * (values[i] - ay); d += Math.pow(xs[i] - ax, 2); }
  return d ? n / d : 0;
}

function trendFactors(team, games) {
  const recent = [...games].sort(byDateAsc).slice(-5), vals = valuesFor(team, recent);
  if (vals.length < 3) return { attack: 1, defense: 1 };
  return { attack: clamp(1 + slope(vals.map(v => v.gf)) * 0.04, 0.94, 1.06), defense: clamp(1 + slope(vals.map(v => v.ga)) * 0.035, 0.94, 1.06) };
}

function weighted(parts) {
  const valid = parts.filter(p => Number.isFinite(p.value) && p.weight > 0);
  const tw = valid.reduce((s, p) => s + p.weight, 0);
  return tw ? valid.reduce((s, p) => s + p.value * p.weight, 0) / tw : 0;
}

function formFactor(ppg) { return clamp(1 + (ppg - 1.3) * 0.07, 0.90, 1.10); }
function reliability(games) { return clamp(games / 10, 0.35, 1); }

function profile(team, venue, currentPlayed, previousPlayed, survival, la) {
  const currentAll = teamGames(team, currentPlayed);
  const previousAll = teamGames(team, previousPlayed);
  const currentVenue = teamVenueGames(team, currentPlayed, venue);
  const previousVenue = teamVenueGames(team, previousPlayed, venue);

  const r5 = summarize(valuesFor(team, currentAll.slice(0, 5)), survival.gf, survival.ga);
  const r10 = summarize(valuesFor(team, currentAll.slice(0, TEAM_FORM_N)), survival.gf, survival.ga);
  const cv = summarize(valuesFor(team, currentVenue), survival.gf, survival.ga);
  const pv = summarize(valuesFor(team, previousVenue), survival.gf, survival.ga);
  const pa = summarize(valuesFor(team, previousAll), survival.gf, survival.ga);

  const promoted = pa.games === 0;
  const cg = currentAll.length;
  const previousPpg = pa.games ? pa.ppg : 0.70;

  let gf;
  let ga;
  let ppg;

  if (promoted && cg === 0) {
    gf = survival.gf * 0.90;
    ga = survival.ga * 1.08;
    ppg = 0.70;
  } else if (!promoted && cg === 0) {
    gf = weighted([
      { value: pv.gf, weight: 0.70 },
      { value: pa.gf, weight: 0.25 },
      { value: survival.gf, weight: 0.05 }
    ]);
    ga = weighted([
      { value: pv.ga, weight: 0.70 },
      { value: pa.ga, weight: 0.25 },
      { value: survival.ga, weight: 0.05 }
    ]);
    ppg = pa.ppg;
  } else if (promoted) {
    const realWeight = clamp(cg / 10, 0.20, 0.80);
    const fallbackWeight = 1 - realWeight;
    gf = weighted([
      { value: r5.gf, weight: realWeight * 0.55 },
      { value: r10.gf, weight: realWeight * 0.25 },
      { value: cv.gf, weight: realWeight * 0.20 },
      { value: survival.gf * 0.90, weight: fallbackWeight }
    ]);
    ga = weighted([
      { value: r5.ga, weight: realWeight * 0.55 },
      { value: r10.ga, weight: realWeight * 0.25 },
      { value: cv.ga, weight: realWeight * 0.20 },
      { value: survival.ga * 1.08, weight: fallbackWeight }
    ]);
    ppg = weighted([
      { value: r5.ppg, weight: realWeight * 0.70 },
      { value: r10.ppg, weight: realWeight * 0.30 },
      { value: 0.70, weight: fallbackWeight }
    ]);
  } else {
    const currentWeight = clamp(cg / 10, 0.20, 0.65);
    const previousWeight = 1 - currentWeight;
    gf = weighted([
      { value: r5.gf, weight: currentWeight * 0.45 },
      { value: r10.gf, weight: currentWeight * 0.30 },
      { value: cv.gf, weight: currentWeight * 0.25 },
      { value: pv.gf, weight: previousWeight * 0.70 },
      { value: pa.gf, weight: previousWeight * 0.30 }
    ]);
    ga = weighted([
      { value: r5.ga, weight: currentWeight * 0.45 },
      { value: r10.ga, weight: currentWeight * 0.30 },
      { value: cv.ga, weight: currentWeight * 0.25 },
      { value: pv.ga, weight: previousWeight * 0.70 },
      { value: pa.ga, weight: previousWeight * 0.30 }
    ]);
    ppg = weighted([
      { value: r5.ppg, weight: currentWeight * 0.60 },
      { value: r10.ppg, weight: currentWeight * 0.40 },
      { value: pa.ppg, weight: previousWeight }
    ]);
  }

  const trend = trendFactors(team, currentAll.slice(0, 5));
  const rates = {
    btts: weighted([{ value: r10.btts, weight: cg ? 0.45 : 0 }, { value: cv.btts, weight: cg ? 0.20 : 0 }, { value: pa.btts, weight: promoted ? 0 : 0.25 }, { value: la.btts, weight: 0.10 }, { value: survival.btts || 0.48, weight: promoted ? 0.25 : 0 }]),
    o15: weighted([{ value: r10.o15, weight: cg ? 0.45 : 0 }, { value: cv.o15, weight: cg ? 0.20 : 0 }, { value: pa.o15, weight: promoted ? 0 : 0.25 }, { value: la.o15, weight: 0.10 }, { value: 0.68, weight: promoted ? 0.25 : 0 }]),
    o25: weighted([{ value: r10.o25, weight: cg ? 0.45 : 0 }, { value: cv.o25, weight: cg ? 0.20 : 0 }, { value: pa.o25, weight: promoted ? 0 : 0.25 }, { value: la.o25, weight: 0.10 }, { value: 0.42, weight: promoted ? 0.25 : 0 }]),
    u25: weighted([{ value: r10.u25, weight: cg ? 0.45 : 0 }, { value: cv.u25, weight: cg ? 0.20 : 0 }, { value: pa.u25, weight: promoted ? 0 : 0.25 }, { value: la.u25, weight: 0.10 }, { value: 0.58, weight: promoted ? 0.25 : 0 }]),
    u35: weighted([{ value: r10.u35, weight: cg ? 0.45 : 0 }, { value: cv.u35, weight: cg ? 0.20 : 0 }, { value: pa.u35, weight: promoted ? 0 : 0.25 }, { value: la.u35, weight: 0.10 }, { value: 0.72, weight: promoted ? 0.25 : 0 }])
  };

  return {
    team,
    venue,
    gf: clamp(gf, 0.30, 3.3),
    ga: clamp(ga, 0.30, 3.4),
    ppg: clamp(ppg, 0, 3),
    previousPpg: clamp(previousPpg, 0, 3),
    formFactor: formFactor(ppg),
    attackTrend: trend.attack,
    defenseTrend: trend.defense,
    reliability: reliability(cg + Math.min(pa.games, 10) * 0.8),
    currentGames: cg,
    previousGames: pa.games,
    rates,
    promoted
  };
}

function expectedGoals(home, away, la) {
  let h = la.homeGoals * safeDiv(home.gf, la.homeGoals) * safeDiv(away.ga, la.homeGoals);
  let a = la.awayGoals * safeDiv(away.gf, la.awayGoals) * safeDiv(home.ga, la.awayGoals);
  h *= home.formFactor * home.attackTrend * away.defenseTrend;
  a *= away.formFactor * away.attackTrend * home.defenseTrend;
  return { lambdaH: clamp(h, 0.25, 3.6), lambdaA: clamp(a, 0.20, 3.3) };
}

function calculateMarkets(lambdaH, lambdaA) {
  const labels = ["1", "X", "2", "1X", "X2", "O1.5", "O2.5", "U2.5", "U3.5", "BTTS", "1 + O1.5", "1 + O2.5", "1 + U2.5", "1 + U3.5", "2 + O1.5", "2 + O2.5", "2 + U2.5", "2 + U3.5", "1X + O1.5", "1X + O2.5", "1X + U2.5", "1X + U3.5", "X2 + O1.5", "X2 + O2.5", "X2 + U2.5", "X2 + U3.5", "BTTS + O1.5", "BTTS + O2.5"];
  const m = Object.fromEntries(labels.map(label => [label, 0]));
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poisson(lambdaH, h) * poisson(lambdaA, a), t = h + a;
      const hw = h > a, dr = h === a, aw = h < a, x1 = hw || dr, x2 = aw || dr, o15 = t > 1, o25 = t > 2, u25 = t < 3, u35 = t < 4, btts = h > 0 && a > 0;
      if (hw) m["1"] += p; if (dr) m["X"] += p; if (aw) m["2"] += p; if (x1) m["1X"] += p; if (x2) m["X2"] += p; if (o15) m["O1.5"] += p; if (o25) m["O2.5"] += p; if (u25) m["U2.5"] += p; if (u35) m["U3.5"] += p; if (btts) m["BTTS"] += p;
      if (hw && o15) m["1 + O1.5"] += p; if (hw && o25) m["1 + O2.5"] += p; if (hw && u25) m["1 + U2.5"] += p; if (hw && u35) m["1 + U3.5"] += p;
      if (aw && o15) m["2 + O1.5"] += p; if (aw && o25) m["2 + O2.5"] += p; if (aw && u25) m["2 + U2.5"] += p; if (aw && u35) m["2 + U3.5"] += p;
      if (x1 && o15) m["1X + O1.5"] += p; if (x1 && o25) m["1X + O2.5"] += p; if (x1 && u25) m["1X + U2.5"] += p; if (x1 && u35) m["1X + U3.5"] += p;
      if (x2 && o15) m["X2 + O1.5"] += p; if (x2 && o25) m["X2 + O2.5"] += p; if (x2 && u25) m["X2 + U2.5"] += p; if (x2 && u35) m["X2 + U3.5"] += p;
      if (btts && o15) m["BTTS + O1.5"] += p; if (btts && o25) m["BTTS + O2.5"] += p;
    }
  }
  return m;
}

function marketFamily(label) { if (label.includes("BTTS")) return "btts"; if (label.includes("O") || label.includes("U")) return "goals"; if (label.includes("1X") || label.includes("X2")) return "doublechance"; if (["1", "2"].includes(label)) return "result"; return label; }
function marketQuality(label) { if (["O1.5", "U3.5", "1X", "X2"].includes(label)) return 0.92; if (["O2.5", "U2.5", "BTTS", "1", "2"].includes(label)) return 1.03; if (label.includes(" + ")) return 1.08; return 1; }

function adjustMarket(label, probability, home, away, la) {
  let f = 1;
  for (const part of label.split(" + ")) {
    if (part === "BTTS") f *= clamp(1 + (((home.rates.btts + away.rates.btts) / 2) - la.btts) * 0.22, 0.92, 1.08);
    if (part === "O1.5") f *= clamp(1 + (((home.rates.o15 + away.rates.o15) / 2) - la.o15) * 0.16, 0.94, 1.06);
    if (part === "O2.5") f *= clamp(1 + (((home.rates.o25 + away.rates.o25) / 2) - la.o25) * 0.20, 0.92, 1.08);
    if (part === "U2.5") f *= clamp(1 + (((home.rates.u25 + away.rates.u25) / 2) - la.u25) * 0.18, 0.92, 1.08);
    if (part === "U3.5") f *= clamp(1 + (((home.rates.u35 + away.rates.u35) / 2) - la.u35) * 0.16, 0.94, 1.06);
    if (part === "1" || part === "1X") f *= clamp(1 + (home.ppg - away.ppg) * 0.035, 0.94, 1.06);
    if (part === "2" || part === "X2") f *= clamp(1 + (away.ppg - home.ppg) * 0.035, 0.94, 1.06);
  }
  return clamp(probability * f, 0.01, 0.96);
}

function isSafeMarket(label) {
  if (label === "X" || label.startsWith("X +")) return false;
  const base = new Set(["1X", "X2", "O1.5", "U3.5", "U2.5", "O2.5", "BTTS", "1", "2"]);
  const combos = new Set(["1X + O1.5", "1X + U3.5", "1X + U2.5", "X2 + O1.5", "X2 + U3.5", "X2 + U2.5", "1 + O1.5", "1 + U3.5", "2 + O1.5", "2 + U3.5", "BTTS + O1.5"]);
  return base.has(label) || combos.has(label);
}

function minimumSafeProbability(label, round) {
  const early = round !== null && round <= 5;
  let base;
  if (["1X", "X2", "O1.5", "U3.5"].includes(label)) base = 0.68;
  else if (["U2.5", "O2.5", "BTTS", "1", "2"].includes(label)) base = 0.61;
  else if (label.includes(" + ")) base = 0.64;
  else base = 0.65;
  return early ? base + 0.03 : base;
}

function isContradictory(a, b) {
  const pair = new Set([a, b]);
  if (pair.has("1X") && pair.has("X2")) return true;
  if (pair.has("1") && pair.has("X2")) return true;
  if (pair.has("2") && pair.has("1X")) return true;
  if (pair.has("O2.5") && pair.has("U3.5")) return true;
  if (pair.has("BTTS") && pair.has("U2.5")) return true;
  return false;
}

function contextualMarketAllowed(label, home, away) {
  const strongHomeVsPromotedAway = away.promoted && home.previousPpg >= 1.75;
  const promotedHomeVsStrongAway = home.promoted && away.previousPpg >= 1.75;

  if (strongHomeVsPromotedAway && (label === "X2" || label === "2" || label.startsWith("X2 +") || label.startsWith("2 +"))) return false;
  if (promotedHomeVsStrongAway && (label === "1X" || label === "1" || label.startsWith("1X +") || label.startsWith("1 +"))) return false;

  const homeMuchStronger = home.previousPpg - away.previousPpg >= 0.90 && !home.promoted;
  const awayMuchStronger = away.previousPpg - home.previousPpg >= 0.90 && !away.promoted;

  if (homeMuchStronger && (label === "X2" || label.startsWith("X2 +"))) return false;
  if (awayMuchStronger && (label === "1X" || label.startsWith("1X +"))) return false;

  return true;
}

function calculateSafePicks(lambdaH, lambdaA, home, away, la, round) {
  const markets = calculateMarkets(lambdaH, lambdaA);
  const safeBets = Object.entries(markets)
    .map(([label, p]) => ({ label, pct: adjustMarket(label, p, home, away, la), quality: marketQuality(label) }))
    .filter(b => isSafeMarket(b.label))
    .filter(b => contextualMarketAllowed(b.label, home, away))
    .filter(b => b.pct >= minimumSafeProbability(b.label, round))
    .filter(b => b.pct <= 0.94)
    .sort((a, b) => (b.pct * b.quality) - (a.pct * a.quality));

  const result = [];
  for (const bet of safeBets) {
    if (result.length >= 2) break;
    const badPair = result.some(x => isContradictory(x.label, bet.label));
    const sameLabel = result.some(x => x.label === bet.label);
    const sameFamily = result.some(x => marketFamily(x.label) === marketFamily(bet.label));
    if (!badPair && !sameLabel && !sameFamily) result.push({ ...bet, type: "safe" });
  }
  if (result.length < 2) {
    for (const bet of safeBets) {
      if (result.length >= 2) break;
      const badPair = result.some(x => isContradictory(x.label, bet.label));
      if (!badPair && !result.some(x => x.label === bet.label)) result.push({ ...bet, type: "safe" });
    }
  }
  return result.slice(0, 2);
}

function confidence(match) {
  const p1 = match.bets[0]?.pct || 0, p2 = match.bets[1]?.pct || 0;
  const rel = (match.homeProfile.reliability + match.awayProfile.reliability) / 2;
  const quality = avg(match.bets.map(b => marketQuality(b.label)), 1);
  return clamp(Math.round(((p1 * 0.60 + p2 * 0.40) * 70 + rel * 20 + quality * 10)), 0, 100);
}
function confidenceLabel(score) { if (score >= 78) return "Alta"; if (score >= 68) return "Media"; return "Bassa"; }
function diversityMultiplier(bets) { return new Set(bets.map(b => marketFamily(b.label))).size >= 2 ? 1.04 : 0.96; }
function topScore(match) { const base = (match.bets[0]?.pct || 0) * 0.65 + (match.bets[1]?.pct || 0) * 0.35; const q = avg(match.bets.map(b => marketQuality(b.label)), 1); const r = clamp(0.88 + ((match.homeProfile.reliability + match.awayProfile.reliability) / 2) * 0.18, 0.88, 1.06); return base * q * diversityMultiplier(match.bets) * r; }


function checkBet(label, hg, ag) {
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

  const parts = label.split(" + ");
  if (parts.length === 2) return checkBet(parts[0], hg, ag) && checkBet(parts[1], hg, ag);

  return null;
}

function emptyStats() {
  return {
    ok: 0,
    tot: 0,
    noBetMatches: 0,
    checkedMatches: 0,
    byMarket: {}
  };
}

function addStat(stats, label, outcome) {
  if (outcome === null || outcome === undefined) return;

  stats.tot += 1;
  if (outcome) stats.ok += 1;

  if (!stats.byMarket[label]) {
    stats.byMarket[label] = { ok: 0, tot: 0 };
  }

  stats.byMarket[label].tot += 1;
  if (outcome) stats.byMarket[label].ok += 1;
}

function mergeStats(target, source) {
  target.ok += source.ok;
  target.tot += source.tot;
  target.noBetMatches += source.noBetMatches;
  target.checkedMatches += source.checkedMatches;

  for (const [label, s] of Object.entries(source.byMarket)) {
    if (!target.byMarket[label]) target.byMarket[label] = { ok: 0, tot: 0 };
    target.byMarket[label].ok += s.ok;
    target.byMarket[label].tot += s.tot;
  }
}

function pctLine(ok, tot) {
  return `${ok}/${tot} - ${tot ? Math.round((ok / tot) * 100) : 0}%`;
}

function latestCompletedRound(currentMatches) {
  const rounds = [...new Set(currentMatches.filter(m => m.round !== null).map(m => m.round))]
    .sort((a, b) => b - a);

  for (const round of rounds) {
    const matches = currentMatches.filter(m => m.round === round);
    if (matches.length && matches.every(m => m.played)) return round;
  }

  return null;
}

function marketStatsLine(stats, limit = 8) {
  const markets = Object.entries(stats.byMarket)
    .filter(([, s]) => s.tot > 0)
    .sort((a, b) => b[1].tot - a[1].tot || b[1].ok - a[1].ok)
    .slice(0, limit);

  if (!markets.length) return "N/D";

  return markets
    .map(([label, s]) => `${label}: ${pctLine(s.ok, s.tot)}`)
    .join("\n");
}

function formatLeagueLine(result, mode) {
  const stats = result[mode];
  if (result.latestRound === null) return `⚠️ ${result.league}: nessuna giornata conclusa`;
  return `• ${result.league}: ${pctLine(stats.ok, stats.tot)} (${stats.checkedMatches} partite, no bet ${stats.noBetMatches})`;
}

function evaluateMatch(match, currentPlayed, previousPlayed, survival) {
  const matchTime = match.parsedDate?.getTime() || 0;
  const currentBefore = currentPlayed.filter(m => (m.parsedDate?.getTime() || 0) < matchTime);
  const la = leagueAvg(currentBefore, previousPlayed);
  const homeProfile = profile(match.home, "home", currentBefore, previousPlayed, survival, la);
  const awayProfile = profile(match.away, "away", currentBefore, previousPlayed, survival, la);
  const { lambdaH, lambdaA } = expectedGoals(homeProfile, awayProfile, la);
  const bets = calculateSafePicks(lambdaH, lambdaA, homeProfile, awayProfile, la, match.round);

  if (!bets.length) return null;

  const enriched = { ...match, lambdaH, lambdaA, bets, homeProfile, awayProfile, leagueAvg: la };
  enriched.confidence = confidence(enriched);

  if (enriched.confidence < 66) return null;

  return bets.map(bet => ({
    label: bet.label,
    outcome: checkBet(bet.label, match.hg, match.ag)
  }));
}

function evaluateMatches(matches, currentPlayed, previousPlayed, survival) {
  const stats = emptyStats();

  for (const match of matches.sort(byDateAsc)) {
    const checked = evaluateMatch(match, currentPlayed, previousPlayed, survival);

    if (!checked) {
      stats.noBetMatches += 1;
      continue;
    }

    stats.checkedMatches += 1;
    for (const bet of checked) {
      addStat(stats, bet.label, bet.outcome);
    }
  }

  return stats;
}

async function analyzeLeague(league) {
  const season = seasonYear();
  const previous = season - 1;

  const previousRows = await loadFeed(`${league.slug}-${previous}`);
  const currentRows = await loadFeed(`${league.slug}-${season}`);

  const previousMatches = previousRows.map(row => normalize(row, league.name)).filter(m => m.home && m.away);
  const currentMatches = currentRows.map(row => normalize(row, league.name)).filter(m => m.home && m.away);

  const previousPlayed = previousMatches.filter(m => m.played);
  const currentPlayed = currentMatches.filter(m => m.played);
  const latestRound = latestCompletedRound(currentMatches);
  const survival = survivalProfile(previousPlayed);

  const result = {
    league: league.name,
    latestRound,
    lastRound: emptyStats(),
    season: emptyStats()
  };

  if (latestRound === null) return result;

  const lastRoundMatches = currentPlayed.filter(m => m.round === latestRound);
  const seasonMatches = currentPlayed.filter(m => m.round !== null && m.round <= latestRound);

  result.lastRound = evaluateMatches(lastRoundMatches, currentPlayed, previousPlayed, survival);
  result.season = evaluateMatches(seasonMatches, currentPlayed, previousPlayed, survival);

  return result;
}

async function loadReport() {
  const results = [];

  for (const league of LEAGUES) {
    const result = await analyzeLeague(league);
    results.push(result);
    await sleep(500);
  }

  return results;
}

function globalStats(results, mode) {
  const global = emptyStats();
  for (const result of results) mergeStats(global, result[mode]);
  return global;
}

function buildSingleReportMessage(results) {
  const lastGlobal = globalStats(results, "lastRound");
  const seasonGlobal = globalStats(results, "season");
  const rounds = results
    .filter(r => r.latestRound !== null)
    .map(r => `${r.league} G${r.latestRound}`)
    .join(" | ");

  let msg = "📊 REPORT PRONOSTICI\n\n";

  msg += "🗓 Ultime giornate concluse\n";
  msg += `${rounds || "N/D"}\n\n`;

  msg += "📌 PASSATA GIORNATA\n";
  msg += `Totale: ${pctLine(lastGlobal.ok, lastGlobal.tot)}\n`;
  msg += `Partite verificate: ${lastGlobal.checkedMatches} | No bet: ${lastGlobal.noBetMatches}\n\n`;
  msg += "Per campionato\n";
  for (const result of results) msg += `${formatLeagueLine(result, "lastRound")}\n`;

  msg += "\nMercati principali\n";
  msg += `${marketStatsLine(lastGlobal, 8)}\n`;

  msg += "\n━━━━━━━━━━━━━━━\n";

  msg += "📈 DA INIZIO CAMPIONATO\n";
  msg += `Totale: ${pctLine(seasonGlobal.ok, seasonGlobal.tot)}\n`;
  msg += `Partite verificate: ${seasonGlobal.checkedMatches} | No bet: ${seasonGlobal.noBetMatches}\n\n`;
  msg += "Per campionato\n";
  for (const result of results) msg += `${formatLeagueLine(result, "season")}\n`;

  msg += "\nMercati principali\n";
  msg += `${marketStatsLine(seasonGlobal, 10)}\n`;

  msg += "\n📌 Report aggregato: nessuna singola partita mostrata. Il modello ricalcola i pick usando solo dati disponibili prima del match.";

  if (msg.length > 3900) {
    msg = `${msg.slice(0, 3850)}\n\nMessaggio accorciato per limite Telegram.`;
  }

  return msg;
}

async function run() {
  try {
    const results = await loadReport();
    const lastGlobal = globalStats(results, "lastRound");
    const seasonGlobal = globalStats(results, "season");

    if (!lastGlobal.tot && !seasonGlobal.tot) {
      console.log("Nessun pronostico aggregato verificabile. Nessun messaggio inviato.");
      return;
    }

    await sendMessagesToAll([buildSingleReportMessage(results)]);
    console.log(`Report aggregato inviato. Pronostici ultima giornata: ${lastGlobal.tot}. Pronostici stagione: ${seasonGlobal.tot}.`);
  } catch (err) {
    console.error("Errore report:", err);
    process.exitCode = 1;
  }
}

run();
