export function simpleStats(team, matches) {
  const data = matches.filter(m => m.home === team || m.away === team);

  const gf = data.reduce((s, m) => s + (m.home === team ? m.hg : m.ag), 0);
  const ga = data.reduce((s, m) => s + (m.home === team ? m.ag : m.hg), 0);

  return {
    avgGF: gf / data.length || 1.2,
    avgGA: ga / data.length || 1.2
  };
}

export function poisson(lambda, k) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function factorial(n){ return n<=1 ? 1 : n * factorial(n-1); }

export function predictMatch(home, away, played) {
  const sH = simpleStats(home, played);
  const sA = simpleStats(away, played);

  const lambdaH = (sH.avgGF + sA.avgGA) / 2;
  const lambdaA = (sA.avgGF + sH.avgGA) / 2;

  let probs = [];

  for (let i=0;i<=5;i++) {
    for (let j=0;j<=5;j++) {
      const p = poisson(lambdaH, i) * poisson(lambdaA, j);

      probs.push({
        score: `${i}-${j}`,
        p
      });
    }
  }

  probs.sort((a,b)=>b.p-a.p);

  return probs.slice(0,2); // 🔥 top 2 risultati
}
