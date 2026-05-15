const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "SERIE A", slug: "serie-a-2025" },
  { name: "PREMIER LEAGUE", slug: "epl-2025" }
];

// ✅ funzione invio
async function sendMessage(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });
}

// ✅ stats squadra
function getStats(team, matches) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (games.length === 0) return { gf: 1.2, ga: 1.2 };

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

// ✅ poisson
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

// ✅ calcolo probabilità
function calculateBets(lambdaH, lambdaA) {
  let pH = 0, pD = 0, pA = 0;
  let over25 = 0, under35 = 0;

  let scores = [];

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      scores.push({ score: `${i}-${j}`, p });

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      if (i + j > 2) over25 += p;
      if (i + j < 4) under35 += p;
    }
  }

  scores.sort((a, b) => b.p - a.p);

  const bets = [
    { label: "1", pct: pH },
    { label: "X", pct: pD },
    { label: "2", pct: pA },
    { label: "1X", pct: pH + pD },
    { label: "X2", pct: pD + pA },
    { label: "OVER 2.5", pct: over25 },
    { label: "UNDER 3.5", pct: under35 }
  ];

  bets.sort((a, b) => b.pct - a.pct);

  return {
    topBets: bets.slice(0, 2),
    scores: scores.slice(0, 2)
  };
}

// ✅ load dati
async function loadData() {
  let matchesByLeague = {};

  for (const lg of LEAGUES) {
    const res = await fetch(BASE_URL + lg.slug);
    const json = await res.json();

    const played = [];
    const upcoming = [];

    json.forEach(r => {
      const finished = r.HomeTeamScore !== null && r.AwayTeamScore !== null;

      const m = {
        home: r.HomeTeam,
        away: r.AwayTeam,
        hg: r.HomeTeamScore,
        ag: r.AwayTeamScore
      };

      if (finished) played.push(m);
      else upcoming.push(m);
    });

    let matches = [];

    upcoming.slice(0, 10).forEach(m => {
      const h = getStats(m.home, played);
      const a = getStats(m.away, played);

      const lambdaH = (h.gf + a.ga) / 2;
      const lambdaA = (a.gf + h.ga) / 2;

      const res = calculateBets(lambdaH, lambdaA);

      matches.push({
        home: m.home,
        away: m.away,
        bets: res.topBets,
        scores: res.scores
      });
    });

    matchesByLeague[lg.name] = matches;
  }

  return matchesByLeague;
}

// ✅ MAIN
async function run() {
  const data = await loadData();

  let allMatches = [];

  Object.values(data).forEach(arr => {
    allMatches = allMatches.concat(arr);
  });

  if (allMatches.length === 0) {
    await sendMessage("⚠️ Nessuna partita disponibile");
    return;
  }

  // ✅ TOP 10
  allMatches.sort((a, b) => b.bets[0].pct - a.bets[0].pct);

  const top10 = allMatches.slice(0, 10);

  let message = "🔥 TOP 10 PRONOSTICI\n\n";

  top10.forEach(m => {
    message += `${m.home} - ${m.away}\n`;
    message += `${m.bets[0].label} (${(m.bets[0].pct * 100).toFixed(0)}%) - `;
    message += `${m.bets[1].label} (${(m.bets[1].pct * 100).toFixed(0)}%)\n\n`;
  });

  // ✅ PARTITE PER CAMPIONATO
  for (const lg in data) {
    message += `\n📊 ${lg}\n\n`;

    data[lg].forEach(m => {
      message += `${m.home} - ${m.away}\n`;
      message += `${m.bets[0].label} - ${m.bets[1].label}\n`;
      message += `${m.scores[0].score} - ${m.scores[1].score}\n\n`;
    });
  }

  // ✅ limite telegram
  if (message.length > 3500) {
    message = message.substring(0, 3500);
  }

  await sendMessage(message);
}

run();
