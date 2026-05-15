// ✅ BOT TELEGRAM PRONOSTICI

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const BASE_URL = "https://fixturedownload.com/feed/json/";

const LEAGUES = [
  { name: "Serie A", slug: "serie-a-2025" },
  { name: "Premier League", slug: "epl-2025" },
  { name: "Bundesliga", slug: "bundesliga-2025" },
  { name: "La Liga", slug: "la-liga-2025" },
  { name: "Ligue 1", slug: "ligue-1-2025" },
  { name: "Eredivisie", slug: "eredivisie-2025" }
];

// ✅ funzione invio messaggio
async function sendMessage(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text
      })
    });

    const data = await res.json();
    console.log("Telegram risposta:", data);

  } catch (err) {
    console.error("Errore invio:", err);
  }
}

// ✅ semplice modello probabilità (basato su medie gol)
function predictMatch(homeStats, awayStats) {
  const lambdaH = (homeStats.gf + awayStats.ga) / 2;
  const lambdaA = (awayStats.gf + homeStats.ga) / 2;

  function poisson(l, k) {
    let fact = 1;
    for (let i = 2; i <= k; i++) fact *= i;
    return (Math.pow(l, k) * Math.exp(-l)) / fact;
  }

  let scores = [];

  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);
      scores.push({
        score: `${i}-${j}`,
        p
      });
    }
  }

  scores.sort((a, b) => b.p - a.p);

  return scores.slice(0, 2);
}

// ✅ stats squadra
function getStats(team, matches) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (games.length === 0) {
    return { gf: 1.2, ga: 1.2 }; // fallback
  }

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

// ✅ carica dati
async function loadData() {
  let allMatches = [];

  for (const lg of LEAGUES) {
    try {
      console.log("Carico:", lg.name);

      const res = await fetch(BASE_URL + lg.slug);
      const json = await res.json();

      const played = [];
      const upcoming = [];

      json.forEach(r => {
        const finished = r.HomeTeamScore !== null && r.AwayTeamScore !== null;

        const match = {
          home: r.HomeTeam,
          away: r.AwayTeam,
          hg: r.HomeTeamScore,
          ag: r.AwayTeamScore
        };

        if (finished) played.push(match);
        else upcoming.push(match);
      });

      console.log(lg.name, "giocate:", played.length, "future:", upcoming.length);

      // prendi solo prime 5 partite per non mandare messaggi troppo lunghi
      upcoming.slice(0, 5).forEach(m => {
        const hStats = getStats(m.home, played);
        const aStats = getStats(m.away, played);

        const preds = predictMatch(hStats, aStats);

        if (preds.length >= 2) {
          allMatches.push({
            league: lg.name,
            home: m.home,
            away: m.away,
            top: preds[0],
            second: preds[1]
          });
        }
      });

    } catch (err) {
      console.log("Errore lega:", lg.name);
    }
  }

  return allMatches;
}

// ✅ MAIN
async function run() {
  console.log("🚀 BOT PARTITO");

  const matches = await loadData();

  console.log("Totale partite trovate:", matches.length);

  // ✅ fallback sicurezza
  if (matches.length === 0) {
    await sendMessage("⚠️ Nessuna partita trovata");
    return;
  }

  // ✅ TOP 10
  matches.sort((a, b) => b.top.p - a.top.p);

  const top10 = matches.slice(0, 10);

  let message = "🔥 TOP 10 PRONOSTICI\n\n";

  top10.forEach((m, i) => {
    message += `${i + 1}. ${m.home} - ${m.away}\n`;
    message += `👉 ${m.top.score} (${(m.top.p * 100).toFixed(1)}%)\n\n`;
  });

  message += "\n📊 ALTRE PARTITE\n\n";

  matches.slice(0, 15).forEach(m => {
    message += `${m.home} - ${m.away}\n`;
    message += `1) ${m.top.score} ${(m.top.p * 100).toFixed(1)}%\n`;
    message += `2) ${m.second.score} ${(m.second.p * 100).toFixed(1)}%\n\n`;
  });

  // ✅ taglia se troppo lungo
  if (message.length > 3500) {
    message = message.substring(0, 3500);
  }

  console.log("Messaggio pronto");

  await sendMessage(message);
}

run();
``
