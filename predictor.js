import fetch from "node-fetch";

const LGS = [
  { id:'serie-a-2025', slug:'serie-a-2025', name:'Serie A' },
  { id:'epl-2025', slug:'epl-2025', name:'Premier League' },
  { id:'bundesliga-2025', slug:'bundesliga-2025', name:'Bundesliga' },
  { id:'la-liga-2025', slug:'la-liga-2025', name:'La Liga' },
  { id:'ligue-1-2025', slug:'ligue-1-2025', name:'Ligue 1' },
  { id:'eredivisie-2025', slug:'eredivisie-2025', name:'Eredivisie' }
];

const BASE_URL = "https://fixturedownload.com/feed/json/";

export async function loadAllData() {
  const data = {};

  for (const lg of LGS) {
    const res = await fetch(BASE_URL + lg.slug);
    const json = await res.json();

    const played = [];
    const upcoming = [];

    json.forEach(r => {
      const ok = r.HomeTeamScore !== null && r.AwayTeamScore !== null;

      const m = {
        home: r.HomeTeam,
        away: r.AwayTeam,
        hg: r.HomeTeamScore,
        ag: r.AwayTeamScore,
        round: r.RoundNumber,
        lg: lg.name
      };

      if (ok) played.push(m);
      else upcoming.push(m);
    });

    data[lg.name] = { played, upcoming };
  }

  return data;
}
