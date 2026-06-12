import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

// ✅ TEST MODE
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
// ✅ POISSON
// =============================
function poisson(l, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(l, k) * Math.exp(-l)) / fact;
}

// =============================
// ✅ STATS
// =============================
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

  // ✅ combo realistiche
  ["1","X","2"].forEach(r=>{
    ["O1.5","O2.5","U3.5"].forEach(t=>{
      bets.push({label:`${r} + ${t}`,pct:base[r]*base[t]});
    });
  });

  ["1X","X2"].forEach(dc=>{
    ["O1.5","O2.5","U3.5"].forEach(t=>{
      bets.push({label:`${dc} + ${t}`,pct:base[dc]*base[t]});
    });
  });

  ["O1.5","O2.5"].forEach(t=>{
    bets.push({label:`BTTS + ${t}`,pct:base["BTTS"]*base[t]});
  });

  bets = bets.filter(b=>b.pct>0.40 && b.pct<0.85);
  bets.sort((a,b)=>b.pct-a.pct);

  const safe = bets.find(b=>b.pct>=0.7);
  const mid  = bets.find(b=>b.pct<0.7 && b.pct>=0.55);
  const risk = bets.find(b=>b.pct<0.55);

  return [safe,mid,risk].filter(Boolean).slice(0,3);
}

// =============================
// ✅ LOAD WORLD CUP
// =============================
async function loadWorldCup() {

  // ✅ calendario ufficiale
  const schedule = await (await fetch(
    "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
  )).json();

  const fixtures = schedule.matches;

  // ✅ statistiche storiche
  const statUrls = [
    "fifa-world-cup-2022",
    "fifa-world-cup-2018",
    "nations-league-2024"
  ];

  let played = [];

  for (const slug of statUrls) {

    const json = await (await fetch(BASE_URL + slug)).json();

    json.forEach(r => {
      if (r.HomeTeamScore !== null) {
        played.push({
          home: r.HomeTeam,
          away: r.AwayTeam,
          hg: r.HomeTeamScore,
          ag: r.AwayTeamScore
        });
      }
    });
  }

  let matches = [];

  // =============================
  // ✅ TEST MODE
  // =============================
  if (TEST_MODE) {

    // prime 5 giornate reali
    const matchdays = [...new Set(fixtures.map(m => m.round))].slice(0, 5);

    fixtures.forEach(m => {

      // evita placeholder tipo W101
      if (!m.team1 || !m.team2) return;
      if (m.team1.includes("W") || m.team2.includes("W")) return;

      if (!matchdays.includes(m.round)) return;

      const h = getStats(m.team1, played);
      const a = getStats(m.team2, played);

      matches.push({
        home: m.team1,
        away: m.team2,
        bets: calculate((h.gf + a.ga)/2,(a.gf + h.ga)/2)
      });
    });

    return matches;
  }

  // =============================
  // ✅ PRODUZIONE
  // =============================
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const tStr = tomorrow.toISOString().split("T")[0];

  fixtures.forEach(m => {

    if (!m.team1 || !m.team2) return;
    if (m.team1.includes("W") || m.team2.includes("W")) return;

    if (m.date !== tStr) return;

    const h = getStats(m.team1, played);
    const a = getStats(m.team2, played);

    matches.push({
      home: m.team1,
      away: m.team2,
      bets: calculate((h.gf + a.ga)/2,(a.gf + h.ga)/2)
    });
  });

  return matches;
}

// =============================
// ✅ MESSAGE
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

  // ✅ niente invio se vuoto (produzione)
  if (!TEST_MODE && matches.length === 0) return;

  const title = TEST_MODE
    ? "WORLD CUP TEST"
    : "WORLD CUP - DOMANI";

  await sendToAll(buildMessage(matches,title));
}

run();
``
