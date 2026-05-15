import fetch from "node-fetch";
import { loadAllData } from "./predictor.js";
import { predictMatch } from "./logic.js";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function sendMessage(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown"
    })
  });
}

function formatTop10(allMatches) {
  return allMatches
    .sort((a,b)=>b.top.p - a.top.p)
    .slice(0,10)
    .map((m,i)=>`${i+1}. ${m.home} - ${m.away} → ${m.top.score} (${(m.top.p*100).toFixed(1)}%)`)
    .join("\n");
}

function formatAll(matches) {
  return matches.map(m => {
    return `*${m.home} - ${m.away}*\n` +
      `1) ${m.top.score} (${(m.top.p*100).toFixed(1)}%)\n` +
      `2) ${m.second.score} (${(m.second.p*100).toFixed(1)}%)`;
  }).join("\n\n");
}

async function run() {
  const data = await loadAllData();

  let all = [];

  for (const lg in data) {
    const played = data[lg].played;
    const upcoming = data[lg].upcoming;

    upcoming.forEach(m => {
      const preds = predictMatch(m.home, m.away, played);

      if (preds.length >= 2) {
        all.push({
          home: m.home,
          away: m.away,
          top: preds[0],
          second: preds[1]
        });
      }
    });
  }

  const msg =
    `🔥 *TOP 10 Pronostici*\n\n` +
    formatTop10(all) +
    `\n\n📊 *Tutte le partite*\n\n` +
    formatAll(all);

  await sendMessage(msg);
}

run();
