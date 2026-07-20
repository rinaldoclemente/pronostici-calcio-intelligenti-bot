import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const TEST_MODE = process.env.TEST_MODE === "true";

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
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

async function sendToAll(text) {
  const users = loadUsers();

  for (const id of users) {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: id,
        text
      })
    });
  }
}

// =============================
// DATE / STAGIONE
// =============================
function getSeasonYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  return month >= 8 ? year : year - 1;
}

function getMatchDate(match) {
  return match.DateUtc || match.MatchDate || match.Date || null;
}

function formatDate(d) {
  if (!d) return null;

  const date = new Date(d);

  if (isNaN(date)) return null;

  return date.toISOString().split("T")[0];
}

function getWeekendDates(referenceDate = new Date()) {
  const ref = new Date(referenceDate);
  const day = ref.getDay();

  // Giorni mancanti al sabato
  const daysToSaturday = (6 - day + 7) % 7;

  const saturday = new Date(ref);
  saturday.setDate(ref.getDate() + daysToSaturday);

  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);

  return {
    saturday: formatDate(saturday),
    sunday: formatDate(sunday)
  };
}

function isWeekendMatch(matchDate) {
  const d = formatDate(matchDate);
  if (!d) return false;

  const { saturday, sunday } = getWeekendDates();

  return d === saturday || d === sunday;
}

// =============================
// POISSON
// =============================
function poisson(lambda, k) {
  let fact = 1;

  for (let i = 2; i <= k; i++) {
    fact *= i;
  }

  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

// =============================
// PROFILO SQUADRA SALVEZZA
// =============================
function computeSurvivalProfile(previousMatches) {
  const teams = {};

  previousMatches.forEach(m => {
    if (!teams[m.home]) {
      teams[m.home] = { p: 0, gf: 0, ga: 0, pts: 0 };
    }

    if (!teams[m.away]) {
      teams[m.away] = { p: 0, gf: 0, ga: 0, pts: 0 };
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
  });

  const ranked = Object.values(teams)
    .filter(t => t.p > 0)
    .sort((a, b) => {
      const ptsA = a.pts / a.p;
      const ptsB = b.pts / b.p;
      return ptsA - ptsB;
    });

  if (!ranked.length) {
    return {
      gf: 1.0,
      ga: 1.6
    };
  }

  const bottomCount = Math.max(3, Math.ceil(ranked.length * 0.2));
  const bottomTeams = ranked.slice(0, bottomCount);

  const avgGF = bottomTeams.reduce((s, t) => s + (t.gf / t.p), 0) / bottomTeams.length;
  const avgGA = bottomTeams.reduce((s, t) => s + (t.ga / t.p), 0) / bottomTeams.length;

  return {
    gf: avgGF || 1.0,
    ga: avgGA || 1.6
  };
}

// =============================
// STATISTICHE
// =============================
function getStats(team, matches, fallbackProfile) {
  const games = matches.filter(m => m.home === team || m.away === team);

  // Neopromossa o squadra senza storico
  if (!games.length) {
    return fallbackProfile || { gf: 1.0, ga: 1.6 };
  }

  const rawGF = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.hg : m.ag);
  }, 0) / games.length;

  const rawGA = games.reduce((sum, m) => {
    return sum + (m.home === team ? m.ag : m.hg);
  }, 0) / games.length;

  // Se ha poche partite, blend con profilo salvezza
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

// =============================
// CALCOLO PRONOSTICI
// =============================
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

  // Combo realistiche: 1X2 + Over/Under
  ["1", "X", "2"].forEach(result => {
    ["O1.5", "O2.5", "U2.5", "U3.5"].forEach(total => {
      bets.push({
        label: `${result} + ${total}`,
        pct: base[result] * base[total]
      });
    });
  });

  // Combo realistiche: doppia chance + Over/Under
  ["1X", "X2"].forEach(dc => {
    ["O1.5", "O2.5", "U2.5", "U3.5"].forEach(total => {
      bets.push({
        label: `${dc} + ${total}`,
        pct: base[dc] * base[total]
      });
    });
  });

  // Combo realistiche: BTTS + Over
  ["O1.5", "O2.5"].forEach(total => {
    bets.push({
      label: `BTTS + ${total}`,
      pct: base["BTTS"] * base[total]
    });
  });

  bets = bets.filter(b => b.pct > 0.40 && b.pct < 0.85);

  bets.sort((a, b) => b.pct - a.pct);

  const safe = bets.find(b => b.pct >= 0.70);
  const mid = bets.find(b => b.pct < 0.70 && b.pct >= 0.55);
  const risk = bets.find(b => b.pct < 0.55);

  const result = [safe, mid, risk].filter(Boolean);

  for (const bet of bets) {
    if (result.length >= 3) break;
    if (!result.includes(bet)) result.push(bet);
  }

  return result.slice(0, 3);
}

// =============================
// LOAD CAMPIONATI
// =============================
async function loadLeagues() {
  const seasonYear = getSeasonYear();
  const previousSeasonYear = seasonYear - 1;

  let allMatches = [];

  for (const league of LEAGUES) {
    const currentSlug = `${league.slug}-${seasonYear}`;
    const previousSlug = `${league.slug}-${previousSeasonYear}`;

    let previousPlayed = [];
    let currentPlayed = [];
    let currentUpcoming = [];

    const sources = [
      { slug: previousSlug, type: "previous" },
      { slug: currentSlug, type: "current" }
    ];

    for (const source of sources) {
      try {
        const res = await fetch(BASE_URL + source.slug);

        if (!res.ok) continue;

        const json = await res.json();

        json.forEach(r => {
          const hasResult =
            r.HomeTeamScore !== null &&
            r.HomeTeamScore !== undefined &&
            r.HomeTeamScore !== "" &&
            r.AwayTeamScore !== null &&
            r.AwayTeamScore !== undefined &&
            r.AwayTeamScore !== "";

          const match = {
            home: r.HomeTeam,
            away: r.AwayTeam,
            hg: hasResult ? Number(r.HomeTeamScore) : null,
            ag: hasResult ? Number(r.AwayTeamScore) : null,
            date: getMatchDate(r),
            round: r.RoundNumber || null
          };

          if (!match.home || !match.away) return;

          if (hasResult) {
            if (source.type === "previous") {
              previousPlayed.push(match);
            } else {
              currentPlayed.push(match);
            }
          } else if (source.type === "current") {
            currentUpcoming.push(match);
          }
        });
      } catch {
        continue;
      }
    }

    const survivalProfile = computeSurvivalProfile(previousPlayed);
    const allPlayedForStats = previousPlayed.concat(currentPlayed);

    const targetMatches = currentUpcoming
      .filter(m => m.home && m.away)
      .filter(m => TEST_MODE ? true : isWeekendMatch(m.date))
      .slice(0, TEST_MODE ? 5 : 50);

    targetMatches.forEach(m => {
      const h = getStats(m.home, allPlayedForStats, survivalProfile);
      const a = getStats(m.away, allPlayedForStats, survivalProfile);

      const bets = calculate(
        (h.gf + a.ga) / 2,
        (a.gf + h.ga) / 2
      );

      if (bets.length >= 3) {
        allMatches.push({
          league: league.name,
          home: m.home,
          away: m.away,
          date: m.date,
          round: m.round,
          bets
        });
      }
    });
  }

  return allMatches;
}

// =============================
// MESSAGGIO
// =============================
function buildMessage(matches, title) {
  let msg = `🔥 ${title} 🔥\n\n`;

  const top10 = [...matches]
    .sort((a, b) => b.bets[0].pct - a.bets[0].pct)
    .slice(0, 10);

  msg += "🏆 TOP 10 PICKS\n\n";

  top10.forEach(m => {
    msg += `${m.home} - ${m.away}\n`;
    msg += `✅ ${m.bets[0]?.label}\n`;
    msg += `⚖️ ${m.bets[1]?.label}\n`;
    msg += `🔥 ${m.bets[2]?.label}\n\n`;
  });

  msg += "━━━━━━━━━━━━━━━\n";

  const byLeague = {};

  matches.forEach(m => {
    if (!byLeague[m.league]) byLeague[m.league] = [];
    byLeague[m.league].push(m);
  });

  for (const league in byLeague) {
    msg += `\n📊 ${league}\n\n`;

    byLeague[league].forEach(m => {
      msg += `${m.home}-${m.away} → `;
      msg += `${m.bets[0]?.label} | ${m.bets[1]?.label} | ${m.bets[2]?.label}\n`;
    });
  }

  if (msg.length > 3900) {
    msg = msg.substring(0, 3900);
  }

  return msg;
}

// =============================
// MAIN
// =============================
async function run() {
  const matches = await loadLeagues();

  // Se non ci sono partite nel weekend non invia nulla
  if (matches.length === 0) return;

  const title = TEST_MODE
    ? "TEST CAMPIONATI"
    : "WEEKEND PICKS";

  await sendToAll(buildMessage(matches, title));
}

run();
