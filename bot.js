import fs from "fs";

// ======================================================
// CONFIG
// ======================================================
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN mancante. Aggiungilo nei GitHub Secrets.");
  process.exit(1);
}

const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", flag: "🇮🇹", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", flag: "🇬🇧", slug: "epl-2025" },
  { name: "BUNDESLIGA", flag: "🇩🇪", slug: "bundesliga-2025" },
  { name: "LA LIGA", flag: "🇪🇸", slug: "la-liga-2025" },
  { name: "LIGUE 1", flag: "🇫🇷", slug: "ligue-1-2025" },
  { name: "EREDIVISIE", flag: "🇳🇱", slug: "eredivisie-2025" }
];

const TEAM_FORM_N = Number(process.env.TEAM_FORM_N || 10);
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);
const SHOW_NUMBERS = process.env.SHOW_NUMBERS === "true";
const TIMEZONE = process.env.TIMEZONE || "Europe/Rome";

// Telegram consente max 4096 caratteri.
// Usiamo 3300 per sicurezza.
const TELEGRAM_SAFE_LIMIT = 3300;

// Delay tra invii per evitare rate limit.
const SEND_DELAY_MS = 850;

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

function parseDateValue(value) {
  if (!value) return null;

  let s = String(value).trim().replace(" ", "T");

  const hasTimezone =
    s.endsWith("Z") ||
    /[+-]\d{2}:?\d{2}$/.test(s);

  if (!hasTimezone) {
    s += "Z";
  }

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

function splitMessage(text, maxLen = TELEGRAM_SAFE_LIMIT) {
  if (!text || text.length <= maxLen) {
    return [text || ""];
  }

  const parts = [];
  let rest = text;

  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);

    if (cut < 800) {
      cut = rest.lastIndexOf(" ", maxLen);
    }

    if (cut < 800) {
      cut = maxLen;
    }

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

// ======================================================
// TELEGRAM
// ======================================================
async function sendTelegramRaw(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const body = await res.text();

  console.log(`📨 Telegram response for ${chatId}:`, body);

  if (!res.ok) {
    throw new Error(`Telegram error ${res.status}: ${body}`);
  }

  return body;
}

async function sendTelegramWithRetry(chatId, text, attempt = 1) {
  try {
    await sendTelegramRaw(chatId, text);
  } catch (err) {
    console.error(`❌ Errore invio a ${chatId}, tentativo ${attempt}:`, err.message);

    if (attempt < 3) {
      await sleep(1500 * attempt);
      return sendTelegramWithRetry(chatId, text, attempt + 1);
    }

    throw err;
  }
}

async function sendMessageToUser(chatId, text, label = "messaggio") {
  const chunks = splitMessage(text);

  console.log(`📤 Invio ${label} a ${chatId}. Parti: ${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const prefix =
      chunks.length > 1
        ? `Parte ${i + 1}/${chunks.length}\n\n`
        : "";

    await sendTelegramWithRetry(chatId, prefix + chunks[i]);

    await sleep(SEND_DELAY_MS);
  }
}

async function broadcastMessages(messages) {
  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ Nessun utente trovato in users.json.");
    return;
  }

  console.log(`👥 Utenti caricati: ${users.length}`);
  console.log(`📦 Messaggi da inviare a ogni utente: ${messages.length}`);

  for (const userId of users) {
    console.log(`\n🚀 Inizio invio completo a ${userId}`);

    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];

      try {
        await sendMessageToUser(
          userId,
          item.text,
          item.title || `messaggio ${i + 1}`
        );
      } catch (err) {
        console.error(
          `❌ Messaggio "${item.title}" non inviato a ${userId}:`,
          err.message
        );
      }

      await sleep(SEND_DELAY_MS);
    }

    console.log(`✅ Invio completo terminato per ${userId}\n`);
  }
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
      slug: league.slug,
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

        if (onlyDate < today) {
          continue;
        }
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
  if (!played || !played.length) {
    return {
      h: 1.35,
      a: 1.05
    };
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

// ======================================================
// MATCH MODEL
// ======================================================
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

// ======================================================
// QUOTA STIMATA INTERNA
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
  const sp = res.matrix;
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

  const rawBets = [
    { label: "1", pct: pH, type: "1x2" },
    { label: "X", pct: pD, type: "1x2" },
    { label: "2", pct: pA, type: "1x2" },

    { label: "1X", pct: pH + pD, type: "safe" },
    { label: "X2", pct: pD + pA, type: "safe" },
    { label: "12", pct: pH + pA, type: "safe" },

    { label: "Over 1.5", pct: acc((i, j) => i + j > 1), type: "goals" },
    { label: "Over 2.5", pct: acc((i, j) => i + j > 2), type: "goals" },
    { label: "Over 3.5", pct: acc((i, j) => i + j > 3), type: "goals" },

    { label: "Under 2.5", pct: acc((i, j) => i + j <= 2), type: "goals" },
    { label: "Under 3.5", pct: acc((i, j) => i + j <= 3), type: "goals" },

    { label: "BTTS Sì", pct: acc((i, j) => i > 0 && j > 0), type: "btts" },
    { label: "BTTS No", pct: acc((i, j) => !(i > 0 && j > 0)), type: "btts" },

    { label: `${home} segna`, pct: acc((i, j) => i >= 1), type: "team" },
    { label: `${away} segna`, pct: acc((i, j) => j >= 1), type: "team" },

    { label: "Multigol 1-3", pct: acc((i, j) => i + j >= 1 && i + j <= 3), type: "multi" },
    { label: "Multigol 2-3", pct: acc((i, j) => i + j >= 2 && i + j <= 3), type: "multi" },
    { label: "Multigol 1-4", pct: acc((i, j) => i + j >= 1 && i + j <= 4), type: "multi" },

    { label: "1 + Over 1.5", pct: acc((i, j) => i > j && i + j > 1), type: "combo" },
    { label: "1 + Over 2.5", pct: acc((i, j) => i > j && i + j > 2), type: "combo" },
    { label: "2 + Over 1.5", pct: acc((i, j) => j > i && i + j > 1), type: "combo" },
    { label: "2 + Over 2.5", pct: acc((i, j) => j > i && i + j > 2), type: "combo" },

    { label: "X + Under 2.5", pct: acc((i, j) => i === j && i + j <= 2), type: "combo" },
    { label: "BTTS + Over 2.5", pct: acc((i, j) => i > 0 && j > 0 && i + j > 2), type: "combo" },

    { label: "1X + Over 1.5", pct: acc((i, j) => i >= j && i + j > 1), type: "combo" },
    { label: "1X + Under 3.5", pct: acc((i, j) => i >= j && i + j <= 3), type: "combo" },
    { label: "X2 + Over 1.5", pct: acc((i, j) => j >= i && i + j > 1), type: "combo" },
    { label: "X2 + Under 3.5", pct: acc((i, j) => j >= i && i + j <= 3), type: "combo" }
  ];

  const clean = rawBets
    .map(b => {
      const pct = Math.round(b.pct * 100);

      return {
        label: b.label,
        pct,
        quota: calcQuota(pct),
        type: b.type
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
  const value = bets.find(b => b.pct < 55 && b.pct >= 40);

  if (safe) {
    result.push(safe);
  }

  if (mid && !result.some(x => x.label === mid.label)) {
    result.push(mid);
  }

  if (value && !result.some(x => x.label === value.label)) {
    result.push(value);
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
      console.log(`\n📥 Carico ${lg.name}`);

      const json = await fetchJsonWithTimeout(BASE_URL + lg.slug);

      if (!Array.isArray(json) || !json.length) {
        console.log(`⚠️ Dati vuoti per ${lg.name}`);
        continue;
      }

      const { played, upcoming } = parseFixtureData(json, lg);

      console.log(`✅ ${lg.name}: played=${played.length}, upcoming=${upcoming.length}`);

      if (!played.length || !upcoming.length) {
        continue;
      }

      const av = leagueAverage(played);

      const rounds = upcoming
        .map(m => m.round || 999)
        .filter(Boolean);

      if (!rounds.length) {
        console.log(`⚠️ Nessuna giornata valida per ${lg.name}`);
        continue;
      }

      const nextRound = Math.min(...rounds);

      const targetMatches = upcoming.filter(m => m.round === nextRound);

      console.log(`🎯 ${lg.name}: prossima giornata ${nextRound}, partite=${targetMatches.length}`);

      for (const m of targetMatches) {
        const sH =
          teamStats(m.home, "home", TEAM_FORM_N, played) ||
          teamStats(m.home, "both", TEAM_FORM_N, played);

        const sA =
          teamStats(m.away, "away", TEAM_FORM_N, played) ||
          teamStats(m.away, "both", TEAM_FORM_N, played);

        if (!sH || !sA) {
          console.log(`⚠️ Stats insufficienti: ${m.home} - ${m.away}`);
          continue;
        }

        const res = calculateMatch(sH, sA, av);
        const bets = buildBets(m.home, m.away, res);

        if (!bets.length) {
          console.log(`⚠️ Nessun pick valido: ${m.home} - ${m.away}`);
          continue;
        }

        matches.push({
          league: lg.name,
          flag: lg.flag,
          round: m.round,
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
    } catch (err) {
      console.error(`❌ Errore ${lg.name}:`, err.message);
    }
  }

  console.log(`\n📊 Totale partite analizzate: ${matches.length}`);

  return matches;
}

// ======================================================
// MESSAGE FORMAT
// ======================================================
function formatBet(bet) {
  if (!bet) return "-";

  if (!SHOW_NUMBERS) {
    return bet.label;
  }

  const quota = bet.quota ? ` · quota stimata ${bet.quota.toFixed(2)}` : "";
  return `${bet.label} · ${bet.pct}%${quota}`;
}

function buildMainMessage(matches) {
  const sorted = [...matches].sort((a, b) => {
    const pa = a.bets?.[0]?.pct || 0;
    const pb = b.bets?.[0]?.pct || 0;
    return pb - pa;
  });

  const top = sorted.slice(0, TOP_LIMIT);

  let msg = "";

  msg += "🔥 Ecco le 10 migliori letture statistiche del weekend 🔥\n\n";
  msg += "Ho analizzato forma recente, rendimento casa/trasferta e modello Poisson per individuare gli scenari più interessanti.\n\n";

  msg += "📌 COME LEGGERE I PICKS\n";
  msg += "✅ Sicura → scenario con probabilità più alta\n";
  msg += "⚖️ Equilibrata → buon compromesso rischio/valore\n";
  msg += "🔥 Value → scenario più aggressivo, ma con base statistica\n\n";

  msg += "━━━━━━━━━━━━━━━\n\n";
  msg += `🏆 TOP ${top.length} PICKS\n\n`;

  for (const m of top) {
    const date = formatDateIT(m.dateUtc);

    msg += `${m.flag} ${m.home} - ${m.away}\n`;

    if (date) {
      msg += `🗓 ${date}\n`;
    }

    msg += `✅ ${formatBet(m.bets[0])}\n`;
    msg += `⚖️ ${formatBet(m.bets[1])}\n`;
    msg += `🔥 ${formatBet(m.bets[2])}\n`;

    if (SHOW_NUMBERS) {
      msg += `📈 1X2: 1 ${m.p1}% · X ${m.px}% · 2 ${m.p2}%\n`;
      msg += `⚽ xG stimati: ${m.xgHome.toFixed(2)} - ${m.xgAway.toFixed(2)}\n`;
    }

    msg += "\n";
  }

  msg += "━━━━━━━━━━━━━━━\n";
  msg += "🎯 Lettura consigliata: usa i picks come filtro statistico, non come certezza.\n";
  msg += "⚠️ Analisi automatica a solo scopo informativo.";

  return msg;
}

function buildLeagueMessages(matches) {
  const map = {};

  for (const m of matches) {
    if (!map[m.league]) {
      map[m.league] = [];
    }

    map[m.league].push(m);
  }

  const messages = [];

  for (const leagueName of Object.keys(map)) {
    const arr = map[leagueName].sort((a, b) => {
      const da = parseDateValue(a.dateUtc)?.getTime() || 0;
      const db = parseDateValue(b.dateUtc)?.getTime() || 0;
      return da - db;
    });

    const flag = arr[0]?.flag || "";

    let msg = "";

    msg += `${flag} ${leagueName} — analisi completa giornata\n\n`;
    msg += "Legenda rapida:\n";
    msg += "✅ Sicura | ⚖️ Equilibrata | 🔥 Value\n\n";
    msg += "━━━━━━━━━━━━━━━\n\n";

    for (const m of arr) {
      const date = formatDateIT(m.dateUtc);

      msg += `⚽ ${m.home} - ${m.away}\n`;

      if (date) {
        msg += `🗓 ${date}\n`;
      }

      msg += `✅ ${formatBet(m.bets[0])}\n`;
      msg += `⚖️ ${formatBet(m.bets[1])}\n`;
      msg += `🔥 ${formatBet(m.bets[2])}\n`;

      if (SHOW_NUMBERS) {
        msg += `📈 1X2: 1 ${m.p1}% · X ${m.px}% · 2 ${m.p2}%\n`;
        msg += `⚽ xG: ${m.xgHome.toFixed(2)} - ${m.xgAway.toFixed(2)}\n`;
      }

      msg += "\n";
    }

    msg += "⚠️ Analisi statistica automatica, non garanzia di esito.";

    messages.push({
      title: leagueName,
      text: msg
    });
  }

  return messages;
}

// ======================================================
// MAIN
// ======================================================
async function main() {
  console.log("🚀 Avvio job bot GitHub Actions");

  const users = loadUsers();

  if (!users.length) {
    console.log("⚠️ users.json vuoto. Nessun invio effettuato.");
    return;
  }

  console.log(`👥 Utenti destinatari: ${users.length}`);

  const matches = await loadData();

  if (!matches.length) {
    await broadcastMessages([
      {
        title: "Nessuna partita",
        text: "⚠️ Nessuna partita analizzabile trovata per questo weekend."
      }
    ]);

    return;
  }

  const messages = [];

  messages.push({
    title: "TOP 10 weekend",
    text: buildMainMessage(matches)
  });

  const leagueMessages = buildLeagueMessages(matches);

  for (const msg of leagueMessages) {
    messages.push(msg);
  }

  console.log(`📦 Messaggi totali generati: ${messages.length}`);

  for (const m of messages) {
    console.log(`📏 ${m.title}: ${m.text.length} caratteri`);
  }

  await broadcastMessages(messages);

  console.log("✅ Job completato correttamente");
}

main().catch(async err => {
  console.error("❌ Errore fatale:", err);

  try {
    await broadcastMessages([
      {
        title: "Errore",
        text: "⚠️ Errore durante l'elaborazione automatica delle analisi."
      }
    ]);
  } catch {}

  process.exit(1);
});
