/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // === CONFIG ===
  const maxScanDepth = isNaN(ns.args[0]) ? 3 : parseInt(ns.args[0]);
  const showLimit = isNaN(ns.args[1]) ? 20 : parseInt(ns.args[1]);

  const servers = scanAllServers(ns, "home", maxScanDepth);
  const playerLevel = ns.getHackingLevel();
  const results = [];

  // ===== Detect if formulas are really usable =====
  let formulasAvailable = false;
  try {
    // Pick any owned server to check (home is always safe)
    if (ns.formulas && ns.formulas.hacking) {
      const player = ns.getPlayer();
      const target = ns.getServer("home");
      // Try any formulas call
      ns.formulas.hacking.hackChance(target, player);
      formulasAvailable = true;
    }
  } catch (e) {
    formulasAvailable = false;
  }

  for (const server of servers) {
    if (!ns.hasRootAccess(server)) continue;
    if (ns.getServerMaxMoney(server) === 0) continue;

    const reqHackLevel = ns.getServerRequiredHackingLevel(server);
    if (reqHackLevel > playerLevel) continue;
    if (ns.getHackingLevel() > 500 && ns.getServerMaxMoney(server) < 1e9) continue;

    const maxMoney = ns.getServerMaxMoney(server);
    const curMoney = ns.getServerMoneyAvailable(server);
    const minSec = ns.getServerMinSecurityLevel(server);
    const curSec = ns.getServerSecurityLevel(server);

    let hackPerSec = 0;
    let profitPerThreadPerSec = 0;

    if (formulasAvailable) {
      const player = ns.getPlayer();
      const target = ns.getServer(server);
      target.moneyAvailable = target.moneyMax;
      target.hackDifficulty = target.minDifficulty;

      const hackChance = ns.formulas.hacking.hackChance(target, player);
      const hackTime = ns.formulas.hacking.hackTime(target, player) / 1000;
      const weakenTime = ns.formulas.hacking.weakenTime(target, player) / 1000;
      const hackPercent = ns.formulas.hacking.hackPercent(target, player);

      hackPerSec = (maxMoney * hackPercent * hackChance) / hackTime;
      profitPerThreadPerSec = (maxMoney * hackChance * hackPercent) / weakenTime;
    } else {
      const hackTime = ns.getHackTime(server) / 1000;
      const hackChance = ns.hackAnalyzeChance(server);
      const hackPercent = ns.hackAnalyze(server);
      const weakenTime = ns.getWeakenTime(server) / 1000;

      hackPerSec = (maxMoney * hackPercent * hackChance) / hackTime;
      profitPerThreadPerSec = weakenTime > 0 ? (maxMoney * hackChance * hackPercent) / weakenTime : 0;
    }

    results.push({
      name: server,
      level: reqHackLevel,
      money: maxMoney,
      curMoney,
      minSec,
      curSec,
      hackPerSec,
      profitPerThreadPerSec
    });
  }

  results.sort((a, b) => b.profitPerThreadPerSec - a.profitPerThreadPerSec);

  ns.tprintf(`\n📊 Hack Target Analysis (depth ≤ ${maxScanDepth})`);
  ns.tprintf(
    "%-20s %-6s %-10s %-10s %-8s %-8s %s",
    "Server", "Level", "CurMoney", "MaxMoney", "CurSec", "MinSec", "Est$/sec"
  );

  for (const r of results.slice(0, showLimit)) {
    ns.tprintf(
      "%-20s %-6d $%-9s $%-9s %-8.2f %-8.2f $%-8s",
      r.name,
      r.level,
      ns.formatNumber(r.curMoney, 1),
      ns.formatNumber(r.money, 1),
      r.curSec,
      r.minSec,
      ns.formatNumber(r.profitPerThreadPerSec, 1)
    );
  }
}

// === Recursive bounded DFS server scanner ===
function scanAllServers(ns, start = "home", maxDepth = 6) {
  const visited = new Set();
  const stack = [{ host: start, depth: 0 }];
  const result = [];

  while (stack.length > 0) {
    const { host, depth } = stack.pop();
    if (visited.has(host) || depth > maxDepth) continue;

    visited.add(host);
    result.push(host);

    for (const neighbor of ns.scan(host)) {
      if (!visited.has(neighbor)) {
        stack.push({ host: neighbor, depth: depth + 1 });
      }
    }
  }

  return result;
}
