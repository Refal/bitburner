/** @param {NS} ns 
* will distribute all needed scripts across hacked/purchased servers - and utilise  percentage for fractions
*/
export async function main(ns) {
  const logPrefix = "distribute.js:";
  ns.disableLog("ALL");
  ns.clearLog();

  const weakenScript   = "worker-weaken.js";
  const growScript     = "worker-grow.js";
  const hackScript     = "worker-hack.js";
  const shareScript    = "share.js";
  // Parse parameters (no defaults here; values should be validated upstream)
  const arg0 = parseInt(ns.args[0]);
  const arg1 = parseInt(ns.args[1]);
  const maxDepth    = isNaN(arg0) ? 3 : arg0;
  const sharePercent= isNaN(arg1) ? 0 : Math.min(10, Math.max(0, arg1));
  const rawTarget  = ns.args[3];
  const topTarget  = rawTarget !== undefined && Number.isFinite(+rawTarget)
      ? +rawTarget
      : undefined;
  const balancerScript = ns.args[2] && ns.args[2].trim()
    ? ns.args[2]
    : "priority-scheduler.js";
  // Discover and root all servers within depth
  const allServers = scanAllServers(ns, "home", maxDepth).filter(s => s !== "home");
  const rooted = [];
  const serverFreeRam = {};

  for (const srv of allServers) {
    tryToHack(ns, srv);

    if (!ns.hasRootAccess(srv)) continue;

    ns.killall(srv);
    await ns.sleep(10);

    const free = ns.getServerMaxRam(srv) - ns.getServerUsedRam(srv);
    const minRam = Math.min(
      ns.getScriptRam(weakenScript),
      ns.getScriptRam(growScript),
      ns.getScriptRam(hackScript),
      ns.getScriptRam(shareScript)
    );
    if (free < minRam) continue;

    rooted.push(srv);
    serverFreeRam[srv] = free;
  }

  // Distribute worker & share scripts
  ns.tprint(`${logPrefix} 🚀 Deploying to ${rooted.length} servers (share ${sharePercent * 10}%)`);
  const shareCount = Math.floor((sharePercent / 10) * rooted.length);
  const shareHosts = new Set(rooted.sort(() => 0.5 - Math.random()).slice(0, shareCount));

  for (const srv of rooted) {
    if (shareHosts.has(srv)) {
      const threads = Math.floor(serverFreeRam[srv] / ns.getScriptRam(shareScript));
      if (threads > 0) {
        ns.scp(shareScript, srv);
        const pid = ns.exec(shareScript, srv, threads);
        ns.tprint(pid > 0
          ? `${logPrefix} 🚀 share.js on ${srv} (${threads} threads)`
          : `${logPrefix} ❌ share.js failed on ${srv}`
        );
      }
    } 
    ns.scp([weakenScript, growScript, hackScript], srv);
    ns.tprint(`${logPrefix} ✅ Workers copied to ${srv}`);
  }

  // Launch balancer on home, passing maxDepth and topTarget directly
  ns.tprint(`${logPrefix} 🧠 Launching balancer with depth ${maxDepth}, top target ${topTarget}`);
  const existing = ns.ps("home").find(p => p.filename === balancerScript);
  if (existing) {
    ns.kill(existing.pid);
    await ns.sleep(100);
  }
  const balancerArgs = [ balancerScript, "home", 1, maxDepth ];
  if (topTarget !== undefined) {
    balancerArgs.push(topTarget);
  }

  // 3) Spread them into ns.exec
  const pid = ns.exec(...balancerArgs);
  ns.tprint(pid > 0
    ? `${logPrefix} ✅ Balancer started (PID: ${pid})`
    : `${logPrefix} ❌ Balancer failed`
  );
}

/** Helpers **/
function tryToHack(ns, host) {
  if (ns.hasRootAccess(host)) return;
  try { ns.brutessh(host) } catch {};
  try { ns.ftpcrack(host) } catch {};
  try { ns.relaysmtp(host) } catch {};
  try { ns.httpworm(host) } catch {};
  try { ns.sqlinject(host) } catch {};
  try { ns.nuke(host) } catch {};
}

function scanAllServers(ns, start = "home", maxDepth = 6) {
  const visited = new Set();
  const stack = [{ host: start, depth: 0 }];
  const result = [];
  while (stack.length) {
    const { host, depth } = stack.pop();
    if (visited.has(host) || depth > maxDepth) continue;
    visited.add(host);
    result.push(host);
    for (const neigh of ns.scan(host)) {
      if (!visited.has(neigh)) stack.push({ host: neigh, depth: depth + 1 });
    }
  }
  return result;
}
