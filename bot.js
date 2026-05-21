import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante.");
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

const TEAM_FORM_N = 10;
const TOP_LIMIT = 10;
const SHOW_NUMBERS = false;
const TIMEZONE = "Europe/Rome";

// ======================================================
// USERS
// ======================================================
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);

    if (!Array.isArray(users)) return [];

    return users.map(String);
  } catch (err) {
    console.error("❌ Errore users.json:", err.message);
    return [];
  }
}

// ======================================================
// TELEGRAM
// ======================================================
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

async function sendTelegram(chatId, text) {
  console.log(`📤 Invio a ${chatId}`);

  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    };

    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const body = await res.text();

    console.log("Telegram response:", body);

    if (!res.ok) {
      throw new Error(`Telegram error ${res.status}: ${body}`);
    }
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente trovato");
    return;
  }

  for (const id of users) {
    try {
      await sendTelegram(id, text);
      console.log(`✅ Inviato a ${id}`);
    } catch (err) {
      console.error(`❌ Errore invio ${id}:`, err.message);
    }
  }
}

// ======================================================
// DATE
// ======================================================
function parseDateValue(value) {
  if (!value) return null;

  let s = String(value).trim();

  s = s.replace(" ", "T");

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

// ======================================================
// FETCH
// ======================================================
async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

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
    if (a.round !== b.round) {
      return a.round - b.round;
    }

    const da = parseDateValue(a.dateUtc)?.getTime() || 0;
    const db = parseDateValue(b.dateUtc)?.getTime() || 0;

    return da - db;
  });

  return { played, upcoming };
}

// ======================================================
// POISSON
// ======================================================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) {
    fact *= i;
  }

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

// ======================================================
// STATS
// ======================================================
function leagueAverage(played) {
  if (!played.length) {
    return {
      h: 1.35,
      a: 1.05
    };
  }

  let hg = 0;
  let ag = 0;

  for (const m of played) {
    hg += m.hg;
    ag += m.ag;
  }

  return {
    h: hg / played.length,
    a: ag / played.length
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

  for (const m of games) {
    const isHome = m.home === team;

    const mygf = isHome ? m.hg : m.ag;
    const myga = isHome ? m.ag : m.hg;

    gf += mygf;
    ga += myga;

    if (mygf > myga) pts += 3;
    else if (mygf === myga) pts += 1;
  }

  return {
    gf: gf / games.length,
    ga: ga / games.length,
    pts: pts / games.length
  };
}

// ======================================================
// CALCOLO MATCH
// ======================================================
function calculateMatch(sH, sA, av) {
  const lambdaHomeRaw = Math.max(
    0.2,
    (sH.gf / av.h) * (sA.ga / av.a) * av.h
  );

  const lambdaAwayRaw = Math.max(
    0.2,
    (sA.gf / av.a) * (sH.ga / av.h) * av.a
  );

  const adjustByPoints = p => {
    return (p / 3 - 0.333) * 0.18 + 1;
  };

  const lambdaH = Math.max(
    0.1,
    lambdaHomeRaw * adjustByPoints(sH.pts)
  );

  const lambdaA = Math.max(
    0.1,
    lambdaAwayRaw * adjustByPoints(sA.pts)
  );

  const maxGoals = 6;
  const scoreMatrix = [];

  let pH = 0;
  let pD = 0;
  let pA = 0;
  let mass = 0;

  for (let i = 0; i <= maxGoals; i++) {
    scoreMatrix[i] = [];

    for (let j = 0; j <= maxGoals; j++) {
      const p =
        poisson(lambdaH, i) *
        poisson(lambdaA, j);

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
// QUOTA
// ======================================================
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

// ======================================================
// BETS
// ======================================================
function buildBets(home, away, res) {
  const sp = res.scoreMatrix;
  const maxG = 6;
  const mass = res.mass || 1;

  function acc(fn) {
    let sum = 0;

    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        if (fn(i, j)) {
          sum += sp[i][j];
        }
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

    { label: "Over 1.5", pct: acc((i, j) => i + j > 1) },
    { label: "Over 2.5", pct: acc((i, j) => i + j > 2) },

    { label: "Under 2.5", pct: acc((i, j) => i + j <= 2) },
    { label: "Under 3.5", pct: acc((i, j) => i + j <= 3) },

    { label: "BTTS Sì", pct: acc((i, j) => i > 0 && j > 0) },

    { label: "1 + Over 1.5", pct: acc((i, j) => i > j && i + j > 1) },

    { label: "BTTS + Over 2.5", pct: acc((i, j) => i > 0 && j > 0 && i + j > 2) }
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

  if (mid && !result.some(x => x.label === mid.label)) {
    result.push(mid);
  }

  if (risk && !result.some(x => x.label === risk.label)) {
    result.push(risk);
  }

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

      const json = await fetchJsonWithTimeout(
        BASE_URL + lg.slug
      );

      const { played, upcoming } =
        parseFixtureData(json, lg);

      if (!played.length || !upcoming.length) {
        console.log(`⚠️ Nessun dato per ${lg.name}`);
        continue;
      }

      const av = leagueAverage(played);

      const nextRound = Math.min(
        ...upcoming
          .map(m => m.round || 999)
          .filter(Boolean)
      );

      const targetMatches = upcoming.filter(
        m => m.round === nextRound
      );

      for (const m of targetMatches) {
        const sH =
          teamStats(m.home, "home", TEAM_FORM_N, played) ||
          teamStats(m.home, "both", TEAM_FORM_N, played);

        const sA =
          teamStats(m.away, "away", TEAM_FORM_N, played) ||
          teamStats(m.away, "both", TEAM_FORM_N, played);

        if (!sH || !sA) continue;

        const res = calculateMatch(sH, sA, av);

        const bets = buildBets(
          m.home,
          m.away,
          res
        );

        if (!bets.length) continue;

        matches.push({
          league: lg.name,
          flag: lg.flag,
          dateUtc: m.dateUtc,
          home: m.home,
          away: m.away,
          p1: Math.round(res.pH * 100),
          px: Math.round(res.pD * 100),
          p2: Math.round(res.pA * 100),
          xgHome: res.lambdaH,
          xgAway: res.lambdaA,
          bets
        });
      }

      console.log(`✅ ${lg.name} completato`);
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

  const quota = bet.quota
    ? ` @${bet.quota.toFixed(2)}`
    : "";

  return `${bet.label} ${bet.pct}%${quota}`;
}

function buildMessage(matches) {
  matches.sort((a, b) => {
    const pa = a.bets?.[0]?.pct || 0;
    const pb = b.bets?.[0]?.pct || 0;

    return pb - pa;
  });

  const top = matches.slice(0, TOP_LIMIT);

  let msg = "";

  msg += "📊 RINALDO SCOUT\n";
  msg += "━━━━━━━━━━━━━━━\n\n";

  msg += `🔥 TOP ${top.length} PICKS\n\n`;

  for (const m of top) {
    const date = formatDateIT(m.dateUtc);

    msg += `${m.flag} ${m.home} - ${m.away}\n`;

    if (date) {
      msg += `🗓 ${date}\n`;
    }

    msg += `✅ ${formatBet(m.bets[0])}\n`;
    msg += `⚖️ ${formatBet(m.bets[1])}\n`;
    msg += `🔥 ${formatBet(m.bets[2])}\n\n`;
  }

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "🎯 Modello Poisson + forma squadre\n";
  msg += "⚠️ Analisi automatica a scopo informativo";

  return msg;
}

// ======================================================
// MAIN
// ======================================================
async function main() {
  console.log("🚀 Avvio bot");

  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente");
    return;
  }

  const matches = await loadData();

  if (!matches.length) {
    await sendToAll(
      "⚠️ Nessuna partita trovata oggi"
    );

    return;
  }

  const msg = buildMessage(matches);

  console.log("📏 Lunghezza messaggio:", msg.length);

  await sendToAll(msg);

  console.log("✅ Invio completato");
}

main().catch(async err => {
  console.error("❌ Errore fatale:", err);

  try {
    await sendToAll(
      "⚠️ Errore durante l'elaborazione automatica."
    );
  } catch {}

  process.exit(1);
});
