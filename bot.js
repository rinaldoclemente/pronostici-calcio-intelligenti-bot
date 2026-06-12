import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

const TEST_MODE = process.env.TEST_MODE === "true";

// =============================
// ✅ UTENTI
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
      body: JSON.stringify({ chat_id: id, text })
    });
  }
}

// =============================
// ✅ DATE SAFE
// =============================
function formatDate(d) {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date)) return null;
  return date.toISOString().split("T")[0];
}

// =============================
// ✅ POISSON + STATS
// =============================
function poisson(l, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(l, k) * Math.exp(-l)) / fact;
}

function getStats(team, matches) {
  const games = matches.filter(m => m.home === team || m.away === team);

  if (!games.length) return { gf: 1.3, ga: 1.3 };

  const gf = games.reduce((s, m) =>
    s + (m.home === team ? m.hg : m.ag), 0) / games.length;

  const ga = games.reduce((s, m) =>
    s + (m.home === team ? m.ag : m.hg), 0) / games.length;

  return { gf, ga };
}

// =============================
// ✅ CALCOLO PRONOSTICI
// =============================
function calculate(lambdaH, lambdaA) {

  let pH=0,pD=0,pA=0,over15=0,over25=0,under35=0,btts=0;

  for (let i=0;i<=5;i++){
    for (let j=0;j<=5;j++){
      const p = poisson(lambdaH,i)*poisson(lambdaA,j);

      if(i>j)pH+=p;
      else if(i===j)pD+=p;
      else pA+=p;

      if(i+j>1)over15+=p;
      if(i+j>2)over25+=p;
      if(i+j<4)under35+=p;
      if(i>0 && j>0)btts+=p;
    }
  }

  const base = {
    "1": pH,
    "X": pD,
    "2": pA,
    "1X": pH+pD,
    "X2": pD+pA,
    "O1.5": over15,
    "O2.5": over25,
    "U3.5": under35,
    "BTTS": btts
  };

  let bets=[];

  Object.entries(base).forEach(([l,p])=>{
    bets.push({label:l,pct:p});
  });

  // ✅ combo smart
  ["1","X","2"].forEach(r=>{
    ["O1.5","O2.5","U3.5"].forEach(t=>{
      bets.push({label:`${r} + ${t}`, pct:base[r]*base[t]});
    });
  });

  ["1X","X2"].forEach(dc=>{
    ["O1.5","O2.5","U3.5"].forEach(t=>{
      bets.push({label:`${dc} + ${t}`, pct:base[dc]*base[t]});
    });
  });

  ["O1.5","O2.5"].forEach(t=>{
    bets.push({label:`BTTS + ${t}`, pct:base["BTTS"]*base[t]});
  });

  bets = bets.filter(b=>b.pct>0.40 && b.pct<0.85);
  bets.sort((a,b)=>b.pct-a.pct);

  const safe = bets.find(b=>b.pct>=0.7);
  const mid  = bets.find(b=>b.pct<0.7 && b.pct>=0.55);
  const risk = bets.find(b=>b.pct<0.55);

  return [safe,mid,risk].filter(Boolean).slice(0,3);
}

// =============================
// ✅ BOMBA (LOGICA CORRETTA)
// =============================
function buildBomb(matches, title) {

  let used = new Set();
  let selected = [];

  for (const m of matches) {

    if (used.has(m.home) || used.has(m.away)) continue;

    used.add(m.home);
    used.add(m.away);

    selected.push(m);

    // ✅ max 24 partite (48 squadre)
    if (selected.length >= 24) break;
  }

  if (selected.length === 0) return null;

  let msg = `💣 ${title} 💣\n\n`;

  selected.forEach(m=>{
    msg += `${m.home} - ${m.away}\n`;
    msg += `✅ ${m.bets[0]?.label}\n`;
    msg += `⚖️ ${m.bets[1]?.label}\n\n`;
  });

  return msg;
}

// =============================
// ✅ LOAD WORLD CUP
// =============================
async function loadWorldCup() {

  const schedule = await (await fetch(
    "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
  )).json();

  const fixtures = schedule.matches;

  const statUrls = [
    "fifa-world-cup-2022",
    "fifa-world-cup-2018",
    "nations-league-2024"
  ];

  let played = [];

  for (const slug of statUrls) {
    const json = await (await fetch(BASE_URL + slug)).json();

    json.forEach(r=>{
      if(r.HomeTeamScore !== null){
        played.push({
          home:r.HomeTeam,
          away:r.AwayTeam,
          hg:r.HomeTeamScore,
          ag:r.AwayTeamScore
        });
      }
    });
  }

  let matches = [];

  fixtures.forEach(m=>{

    if (!m.team1 || !m.team2) return;
    if (m.team1.includes("W") || m.team2.includes("W")) return;

    const h = getStats(m.team1, played);
    const a = getStats(m.team2, played);

    matches.push({
      home: m.team1,
      away: m.team2,
      round: m.round,
      date: m.date,
      bets: calculate((h.gf+a.ga)/2,(a.gf+h.ga)/2)
    });
  });

  return matches;
}

// =============================
// ✅ MESSAGE BASE
// =============================
function buildMessage(matches,title){

  let msg = `🔥 ${title} 🔥\n\n`;

  matches.slice(0,10).forEach(m=>{
    msg += `${m.home} - ${m.away}\n`;
    msg += `✅ ${m.bets[0]?.label}\n`;
    msg += `⚖️ ${m.bets[1]?.label}\n`;
    msg += `🔥 ${m.bets[2]?.label}\n\n`;
  });

  return msg;
}

// =============================
// ✅ MAIN
// =============================
async function run(){

  const matches = await loadWorldCup();

  if (matches.length === 0 && !TEST_MODE) return;

  const today = new Date();
  const todayStr = formatDate(today);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  // =============================
  // ✅ DOMANI
  // =============================
  const tomorrowMatches = matches.filter(m => m.date === tomorrowStr);

  if (tomorrowMatches.length > 0) {
    await sendToAll(buildMessage(tomorrowMatches, "WORLD CUP - DOMANI"));
  }

  // =============================
  // ✅ BOMBA GIORNATA
  // =============================
  const rounds = [...new Set(matches.map(m => m.round))];

  for (const round of rounds) {

    const roundMatches = matches.filter(m => m.round === round);

    const start = roundMatches.map(m => m.date).sort()[0];

    // ✅ giorno prima
    if (start === tomorrowStr) {
      const bomb = buildBomb(roundMatches, `BOMBA ${round.toUpperCase()}`);
      if (bomb) await sendToAll(bomb);
    }
  }

  // =============================
  // ✅ TEST PRIMA GIORNATA (MANUALE)
  // =============================
  if (TEST_MODE) {

    const firstRound = rounds[0];
    const firstMatches = matches.filter(m => m.round === firstRound);

    const bomb = buildBomb(firstMatches, `TEST BOMBA ${firstRound.toUpperCase()}`);

    if (bomb) {
      await sendToAll(bomb);
    }
  }
}

run();
