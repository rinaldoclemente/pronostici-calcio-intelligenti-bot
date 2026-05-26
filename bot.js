import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const USERS_FILE = "users.json";
const BASE_URL = "https://fixturedownload.com/feed/json/";

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
// ✅ UTILITY DATE
// =============================
function getDateOnly(d) {
  return new Date(d).toISOString().split("T")[0];
}

function getMinMaxDates(matches) {
  const dates = matches.map(m => new Date(m.MatchDate));
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  return { min, max };
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

  let bets=[];

  Object.entries(base).forEach(([l,p])=>bets.push({label:l,pct:p}));

  // ✅ combo corrette
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
// ✅ LOAD MONDIALI DINAMICO
// =============================
async function loadWorldCup() {

  const urls = [
    "fifa-world-cup-2026",
    "fifa-world-cup-2022",
    "fifa-world-cup-2018",
    "nations-league-2024"
  ];

  let allPlayed=[];
  let upcoming2026=[];

  for (const slug of urls){

    const json = await (await fetch(BASE_URL + slug)).json();

    json.forEach(r=>{

      if(r.HomeTeamScore!==null){
        allPlayed.push({
          home:r.HomeTeam,
          away:r.AwayTeam,
          hg:r.HomeTeamScore,
          ag:r.AwayTeamScore
        });
      }

      if(slug==="fifa-world-cup-2026"){
        upcoming2026.push(r);
      }
    });
  }

  // ✅ date dinamiche
  const { min, max } = getMinMaxDates(upcoming2026);

  const now = new Date();

  // 👉 attivo dal giorno prima
  const start = new Date(min);
  start.setDate(start.getDate()-1);

  if (!(now >= start && now <= max)) return [];

  const tomorrow = new Date();
  tomorrow.setDate(now.getDate()+1);
  const tStr = getDateOnly(tomorrow);

  let matches=[];

  upcoming2026.forEach(m=>{
    const d = m.MatchDate?.split("T")[0];

    if(d===tStr){

      const h=getStats(m.HomeTeam,allPlayed);
      const a=getStats(m.AwayTeam,allPlayed);

      matches.push({
        home:m.HomeTeam,
        away:m.AwayTeam,
        bets:calculate((h.gf+a.ga)/2,(a.gf+h.ga)/2)
      });
    }
  });

  return matches;
}

// =============================
// ✅ LOAD CAMPIONATI DINAMICO
// =============================
async function loadLeagues() {

  const now = new Date();
  let matches=[];

  const leagues = ["serie-a","epl","bundesliga","la-liga","ligue-1","eredivisie"];

  for (const lg of leagues){

    const year = now.getMonth()+1 >= 8 ? now.getFullYear() : now.getFullYear()-1;

    const json = await (await fetch(`${BASE_URL}${lg}-${year}`)).json();

    const { min, max } = getMinMaxDates(json);

    // ✅ filtro stagione dinamico
    if (!(now >= min && now <= max)) continue;

    const played=[];
    const upcoming=[];

    json.forEach(r=>{
      if(r.HomeTeamScore!==null){
        played.push({
          home:r.HomeTeam,
          away:r.AwayTeam,
          hg:r.HomeTeamScore,
          ag:r.AwayTeamScore
        });
      } else {
        upcoming.push(r);
      }
    });

    upcoming.slice(0,5).forEach(m=>{
      const h=getStats(m.HomeTeam,played);
      const a=getStats(m.AwayTeam,played);

      matches.push({
        home:m.HomeTeam,
        away:m.AwayTeam,
        bets:calculate((h.gf+a.ga)/2,(a.gf+h.ga)/2)
      });
    });
  }

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

  const now = new Date();
  const day = now.getDay();

  // 🔥 MONDIALI (ogni giorno ma solo se attivi)
  const wc = await loadWorldCup();
  if (wc.length > 0) {
    await sendToAll(buildMessage(wc,"WORLD CUP - MATCH DOMANI"));
    return;
  }

  // ⚽ CAMPIONATI (solo venerdì)
  if(day===5){
    const lg = await loadLeagues();
    if (lg.length > 0){
      await sendToAll(buildMessage(lg,"WEEKEND PICKS"));
    }
  }
}

run();
