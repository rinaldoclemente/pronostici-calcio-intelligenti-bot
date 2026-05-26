import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

// ✅ modalità test
const TEST_MODE = process.env.TEST_MODE === "true";

// ✅ data test configurabile da YAML
const TEST_DATE = process.env.TEST_DATE 
  ? new Date(process.env.TEST_DATE) 
  : null;

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
// ✅ DATA
// =============================
function now() {
  if (TEST_MODE && TEST_DATE && !isNaN(TEST_DATE)) {
    return TEST_DATE;
  }
  return new Date();
}

// ✅ formato sicuro
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
// ✅ CALCOLO
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

  let bets = [];

  Object.entries(base).forEach(([l,p])=>{
    bets.push({label:l,pct:p});
  });

  // combo corrette
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

  return [safe, mid, risk].filter(Boolean).slice(0,3);
}

// =============================
// ✅ LOAD MONDIALI
// =============================
async function loadWorldCup() {

  const urls = [
    "fifa-world-cup-2026",
    "fifa-world-cup-2022",
    "fifa-world-cup-2018",
    "nations-league-2024"
  ];

  let played = [];
  let wc2026 = [];

  for (const slug of urls){

    const json = await (await fetch(BASE_URL + slug)).json();

    json.forEach(r => {

      if(r.HomeTeamScore !== null){
        played.push({
          home: r.HomeTeam,
          away: r.AwayTeam,
          hg: r.HomeTeamScore,
          ag: r.AwayTeamScore
        });
      }

      if(slug === "fifa-world-cup-2026"){
        wc2026.push(r);
      }
    });
  }

  let matches = [];

  // =============================
  // ✅ TEST MODE (APPENA PARTI)
  // =============================
  if (TEST_MODE) {

    // ✅ prende prime 10 partite disponibili (NON per data)
    const firstMatches = wc2026.slice(0, 10);

    firstMatches.forEach(m => {

      if (!m.HomeTeam || !m.AwayTeam) return;

      const h = getStats(m.HomeTeam, played);
      const a = getStats(m.AwayTeam, played);

      matches.push({
        home: m.HomeTeam,
        away: m.AwayTeam,
        bets: calculate(
          (h.gf + a.ga) / 2,
          (a.gf + h.ga) / 2
        )
      });
    });

    return matches;
  }

  // =============================
  // ✅ PRODUZIONE (GIORNO DOPO)
  // =============================
  const current = new Date();
  const tomorrow = new Date(current);
  tomorrow.setDate(current.getDate() + 1);

  const tStr = formatDate(tomorrow);

  wc2026.forEach(m => {

    const d = formatDate(m.MatchDate);
    if (!d) return;

    if (d === tStr) {

      const h = getStats(m.HomeTeam, played);
      const a = getStats(m.AwayTeam, played);

      matches.push({
        home: m.HomeTeam,
        away: m.AwayTeam,
        bets: calculate((h.gf + a.ga)/2,(a.gf + h.ga)/2)
      });
    }
  });

  return matches;
}

  // ============================
  // ✅ PRODUZIONE
  // ============================
  const current = new Date();
  const tomorrow = new Date(current);
  tomorrow.setDate(current.getDate() + 1);

  const tStr = formatDate(tomorrow);

  wc2026.forEach(m => {

    const d = formatDate(m.MatchDate);
    if (!d) return;

    if (d === tStr) {

      const h = getStats(m.HomeTeam, played);
      const a = getStats(m.AwayTeam, played);

      matches.push({
        home: m.HomeTeam,
        away: m.AwayTeam,
        bets: calculate((h.gf + a.ga) / 2, (a.gf + h.ga) / 2)
      });
    }
  });

  return matches;
}

// =============================
// ✅ MESSAGE
// =============================
function buildMessage(matches,title){

  let msg=`🔥 ${title} 🔥\n\n`;

  matches.slice(0,10).forEach(m=>{
    msg+=`${m.home} - ${m.away}\n`;
    msg+=`✅ ${m.bets[0]?.label}\n`;
    msg+=`⚖️ ${m.bets[1]?.label}\n`;
    msg+=`🔥 ${m.bets[2]?.label}\n\n`;
  });

  return msg;
}

// =============================
// ✅ MAIN
// =============================
async function run(){

  const matches = await loadWorldCup();

  // ✅ NON INVIA NULLA SE VUOTO
  if (matches.length === 0) return;

  const title = TEST_MODE
    ? "WORLD CUP TEST"
    : "WORLD CUP - DOMANI";

  await sendToAll(buildMessage(matches,title));
}

run();
