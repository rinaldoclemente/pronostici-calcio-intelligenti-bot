import fs from "fs";

// ======================================================
// DATE UTILS
// ======================================================

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


// ======================================================
// FETCH
// ======================================================
async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    clearTimeout(timer);
  }
}

// ======================================================
// PARSE FIXTURES
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
// MODELLO POISSON
// ======================================================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) {
    fact *= i;
  }

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

function leagueAverage(played) {
  if (!played.length) {
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
// QUOTA STIMATA
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

  function acc(fn) {
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

  const bets = [
    { label: "1", pct: pH },
    { label: "X", pct: pD },
    { label: "2", pct: pA },

    { label: "1X", pct: pH + pD },
    { label: "X2", pct: pD + pA },
    { label: "12", pct: pH + pA },

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

  const clean = bets
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

  return selectThreeLevels(clean);
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
// LOAD DATA
// ======================================================
async function loadData() {
  const matches = [];

  for (const lg of LEAGUES) {
    try {
      console.log(`📥 Carico ${lg.name}`);

      const json = await fetchJsonWithTimeout(BASE_URL + lg.slug);

      if (!Array.isArray(json) || !json.length) {
        console.warn(`⚠️ Dati vuoti per ${lg.name}`);
        continue;
      }

      const { played, upcoming } = parseFixtureData(json, lg);

      if (!played.length || !upcoming.length) {
        console.warn(`⚠️ Dati insufficienti per ${lg.name}`);
        continue;
      }

      const av = leagueAverage(played);

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

        const res = calculateMatch(sH, sA, av);
        const bets = buildBets(m.home, m.away, res);

        if (!bets.length) continue;

        matches.push({
          league: lg.name,
          flag: lg.flag,
          round: m.round,
          dateUtc: m.dateUtc,
          home: m.home,
          away: m.away,
          xgHome: res.lambdaH,
          xgAway: res.lambdaA,
          p1: Math.round(res.pH * 100),
          px: Math.round(res.pD * 100),
          p2: Math.round(res.pA * 100),
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
// MESSAGE
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
// MAIN
// ======================================================
async function main() {
  console.log("🚀 Avvio job GitHub Actions");

  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente in users.json. Termino.");
    return;
  }

  const matches = await loadData();

  if (!matches.length) {
    await sendToAll("⚠️ Nessuna partita analizzabile trovata oggi.");
    return;
  }

  const msg = buildMessage(matches);

  await sendToAll(msg);

  console.log("✅ Job completato");
}

main().catch(async err => {
  console.error("❌ Errore fatale:", err);

  try {
    await sendToAll("⚠️ Errore durante il calcolo automatico delle analisi.");
  } catch {}

  process.exit(1);
});
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante. Configura il secret BOT_TOKEN su GitHub.");
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

// ======================================================
// USERS
// ======================================================
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);

    if (!Array.isArray(users)) return [];

    return users.map(String).filter(Boolean);
  } catch (err) {
    console.error("❌ Errore lettura users.json:", err.message);
    return [];
  }
}

// ======================================================
// TELEGRAM
// ======================================================
async function sendTelegram(chatId, text) {
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram error ${res.status}: ${body}`);
    }
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente presente in users.json");
    return;
  }

  for (const id of users) {
    try {
      await sendTelegram(id, text);
      console.log(`✅ Inviato a ${id}`);
    } catch (err) {
      console.error(`❌ Errore invio a ${id}:`, err.message);
    }
  }
}

function splitMessage(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  let rest = text;

  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < 500) cut = maxLen;

    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }

  if (rest.length) parts.push(rest);

  return parts;
}

// ======================================================
// DATE UTILS
// ======================================================
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

