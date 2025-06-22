/** Bitburner Industrial Priority Scheduler - Fully Refactored **/
/** written by LLM */
/** @param {NS} ns */
export async function main(ns) {
  const debug = false;
  ns.ui.openTail();
  ns.clearLog();
  
  // 2) Turn off the built-in function logs (so only your prints show)
  ns.disableLog("ALL");

  // 3) Now that the tail is open and cleared, write your first debug line
  if (debug) ns.print("===== Script started =====");

  const arg0 = parseInt(ns.args[0]);
  const arg1 = parseInt(ns.args[1]);
  const maxDepth    = isNaN(arg0) ? 3 : arg0;
  const userTarget = isNaN(arg1) ? undefined : arg1;


  // Constants
  const weakenScript = "worker-weaken.js";
  const growScript = "worker-grow.js";
  const hackScript = "worker-hack.js";

  const weakenCost = ns.getScriptRam(weakenScript);
  const growCost = ns.getScriptRam(growScript);
  const hackCost = ns.getScriptRam(hackScript);

  const securityThresholdBuffer = 0.05;

  // before the while
  let inRecoveryMode    = false;
  const enterThreshold  = 0.3;   // when to go into recovery
  const exitThreshold   = 0.7;   // when to leave recovery

 // once at startup, snap the usableHosts and compute a memory‐bounded target list
 const allHosts      = getUsableHosts(ns, maxDepth);
const moneyHosts  = allHosts.filter(h => ns.getServerMaxMoney(h) > 0);
 const autoTargets   = computeDynamicTargets(
   ns, moneyHosts,
   weakenCost, growCost, hackCost,
   securityThresholdBuffer,
   weakenScript, growScript, hackScript
 );
 const topTargets    = userTarget !== undefined
   ? moneyHosts.slice(0, userTarget)
   : autoTargets;

  while (true) {
    const hosts = userTarget !== undefined
      ? getUsableHosts(ns, maxDepth)
      : allHosts;
    if(debug) ns.tprint("available servers: %j", hosts)
    // pick your targets
    const targets = userTarget !== undefined
      ? selectTargets(ns, hosts, userTarget)
      : topTargets;
    const ramPool = hosts.map(h => ({ host: h, free: ns.getServerMaxRam(h) - ns.getServerUsedRam(h) }));

    // Recovery Mode Detection
    const avgMoneyRatio = targets.reduce((sum, t) => sum + ns.getServerMoneyAvailable(t) / (ns.getServerMaxMoney(t) + 1), 0) / targets.length;
    // … compute avgMoneyRatio
    if (!inRecoveryMode && avgMoneyRatio < enterThreshold) {
      inRecoveryMode = true;
    } else if ( inRecoveryMode && avgMoneyRatio > exitThreshold) {
      inRecoveryMode = false;
    }
    
    if (inRecoveryMode) {
      runRecovery(ns, targets, ramPool, 
        weakenScript, growScript, weakenCost, growCost, securityThresholdBuffer);
    } else {
      runPipelinedBatches(ns, targets, ramPool,
        weakenScript, growScript, hackScript,
        weakenCost, growCost, hackCost,
        securityThresholdBuffer, debug);
    }

    await ns.sleep(5000);
  }
}

/**
 * Recovery: free-fill grow/weaken up to demand cap
 */
function runRecovery(ns, targets, pool, weakenScript, growScript, wCost, gCost, secBuf) {
  let scheduled=0;
  const weakenNeed = {}, growNeed = {};
  let totalWeakenDemand = 0, totalGrowDemand = 0;
  targets.forEach(t=>{
    const minS = ns.getServerMinSecurityLevel(t);
    const curS = ns.getServerSecurityLevel(t);
    const curM = ns.getServerMoneyAvailable(t);
    const maxM = ns.getServerMaxMoney(t);
    const wNeed = Math.ceil(Math.max(0, curS-(minS+secBuf)) / ns.weakenAnalyze(1));
    const growFactor = Math.max(1, maxM / Math.max(curM, 1));
    const gNeed      = Math.ceil(ns.growthAnalyze(t, growFactor));
    weakenNeed[t] = wNeed; totalWeakenDemand += wNeed;
    growNeed[t]   = gNeed; totalGrowDemand   += gNeed;
  });
  for(const s of pool) 
    // keep trying to fill this server until either:
    //  a) it runs out of free RAM, or
    //  b) no weaken/grow tasks can be scheduled
    while (s.free >= Math.min(wCost, gCost)) {
      let didLaunch = false;
      for(const t of targets){
        if(weakenNeed[t]>0 && s.free>=wCost){
          const n = Math.min(weakenNeed[t], Math.floor(s.free / wCost));
          if(ns.exec(weakenScript,s.host,n,t,n)>0) { 
            weakenNeed[t]-=n; 
            s.free-=n*wCost; 
            scheduled++;
            didLaunch = true;
          }
        } else if(growNeed[t]>0 && s.free>=gCost){
          const n= Math.min(growNeed[t], Math.floor(s.free/gCost));
          if(ns.exec(growScript,s.host,n,t,n)>0) { 
            growNeed[t]-=n; 
            s.free-=n*gCost; 
            scheduled++; 
            didLaunch = true;
          }                    
        }
      }
      // if we made no progress this pass, break out—even if s.free is still ≥ cost
      if (!didLaunch) {
            break;
      }
  }
  renderRecoveryLog(ns, targets, pool, scheduled, totalWeakenDemand, totalGrowDemand);
}

/**
 * Batch mode: dynamic overlapping pipelines per target
 */
function runPipelinedBatches(ns, targets, pool,
    wScript, gScript, hScript,
    wCost, gCost, hCost, secBuf, debug) {

  // 1) Plan & filter
  const plans = targets
    .map(t => planBatch(ns, t, secBuf, wScript, gScript, hScript, wCost, gCost, hCost))
    .filter(p => p);

  // 2) Sort by profit/sec
  plans.sort((a, b) => b.estimatedIncomePerSec - a.estimatedIncomePerSec);

  // Compute total free RAM, not installed
  // const totalFreeRam = pool.reduce((sum, s) => sum + s.free, 0);
  let scheduled = 0, profit = 0, fast = 0, med = 0, slow = 0;
  let scheduledW = 0, scheduledG = 0, scheduledH = 0;


  if (debug) {
    ns.tprint(` → targets: ${targets}`);
      const totalFreeRamD = pool.reduce((sum, s) => sum + s.free, 0);
      for (const p of plans) {
        const perBatchRam =
          p.hackThreads * hCost +
          p.growThreads * gCost +
          (p.weakenAfterHack + p.weakenAfterGrow) * wCost;
        const maxPipelines = Math.floor(totalFreeRamD / perBatchRam);
        const depth        = Math.max(1, Math.min(maxPipelines, 5));
        const gap          = Math.max(1, Math.floor(p.weakenTime * 1000 / depth));
        ns.tprint(
          `  [${p.target}] perBatchRam=${perBatchRam.toFixed(1)}; ` +
          `freeRam=${totalFreeRamD.toFixed(1)}; ` +
          `maxPipes=${maxPipelines}; depth=${depth}; gap=${gap}`
        );
    }
  }

  for (const p of plans) {
    // categorize by batch length
    if (p.weakenTime < 120) fast++;
    else if (p.weakenTime < 600) med++;
    else slow++;

    // RAM per batch
    const perBatchRam =
      p.hackThreads * hCost +
      p.growThreads * gCost +
      (p.weakenAfterHack + p.weakenAfterGrow) * wCost;
    // recompute free RAM right now:
    const totalFreeRam = pool.reduce((sum, s) => sum + s.free, 0);
    let maxPipelines = Math.floor(totalFreeRam / perBatchRam);

  // never run more pipelines than you have targets:
    const depth = Math.max(1, Math.min(maxPipelines, targets.length, 12));

    // And compute a non-zero gap
    const gap = Math.floor(p.weakenTime * 1000 / depth) || 1;

    for (let i = 0; i < depth; i++) {
      for (const job of p.offsets) {
        const off = job.baseOffset + i * gap;
        for (const server of pool) {
          const canThreads = Math.floor(server.free / job.cost);
          const toRun = Math.min(canThreads, job.threads);
          if (toRun > 0) {
            const pid = ns.exec(job.script, server.host, toRun, p.target, toRun, off);
            if (pid > 0) {
              server.free -= toRun * job.cost;
              scheduled++;
              if (job.script === wScript) scheduledW += toRun;
              else if (job.script === gScript) scheduledG += toRun;
              else if (job.script === hScript) { 
                scheduledH += toRun; profit += p.estimatedIncomePerSec; 
              }
              break;
            }
          }
        }
      }
    }
  }

  renderBatchLog(ns, plans, scheduled, profit, pool, fast, med, slow, scheduledW, scheduledG, scheduledH);
}

/**
 * Plan a single batch's thread counts and stagger offsets.
 */
function planBatch(ns, target, secBuf,
    wScript, gScript, hScript,
    wCost, gCost, hCost) {

  const maxM   = ns.getServerMaxMoney(target);
  const curM   = ns.getServerMoneyAvailable(target);
  const hTime  = ns.getHackTime(target)   / 1000;
  const wTime  = ns.getWeakenTime(target) / 1000;
  const hChance= ns.hackAnalyzeChance(target);

  // dynamic hack fraction
  const skill = ns.getHackingLevel() / (ns.getServerRequiredHackingLevel(target)+1);
  const hFrac = Math.min(0.1, skill * 0.02);

  // threads for hack
  // let hackAmt     = maxM * hFrac;
  const hackAmt     = curM * hFrac;
  let   hackThreads = Math.floor(ns.hackAnalyzeThreads(target, hackAmt) || 0);
 
  // threads for grow
  const growMul    = 1 / (1 - hFrac);
  const growThreads= Math.ceil(ns.growthAnalyze(target, growMul));

  // threads for weaken to counter hack & grow
  const secInc     = ns.growthAnalyzeSecurity(growThreads);
  const weakenAfterHack = Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / ns.weakenAnalyze(1));
  const weakenAfterGrow = Math.ceil(secInc                       / ns.weakenAnalyze(1));

  // // estimate profit/sec safely
  // const moneyFactor = curM / (maxM + 1);
  // let estimatedIncomePerSec = 0;
  // if (hackThreads > 0 && hackAmt > 0 && hTime > 0 && hChance > 0 && moneyFactor > 0) {
  //   estimatedIncomePerSec = (hackAmt * hChance * moneyFactor) / hTime;
  // }

  // estimate profit/sec (will be zero if hackThreads===0)
  const moneyFactor           = curM / (maxM + 1);
  const estimatedIncomePerSec = (hackThreads > 0 && hackAmt > 0 && hTime > 0 && hChance > 0 && moneyFactor > 0)
    ? (hackAmt * hChance * moneyFactor) / hTime
    : 0;

  // build staggered-offset jobs, but drop any with zero threads
  const offsets = [
    { script: wScript, cost: wCost, threads: weakenAfterHack, baseOffset:   0                   },
    { script: gScript, cost: gCost, threads: growThreads,    baseOffset: Math.floor(wTime * 800) },
    { script: wScript, cost: wCost, threads: weakenAfterGrow, baseOffset: Math.floor(wTime *1000) },
    { script: hScript, cost: hCost, threads: hackThreads,    baseOffset: Math.floor(wTime *1200) }
  ].filter(job => job.threads > 0);
 
  // if literally nothing to run, bail out
  if (offsets.length === 0) return null;

  return {
    target,
    hackThreads,
    growThreads,
    weakenAfterHack,
    weakenAfterGrow,
    weakenTime: wTime,
    estimatedIncomePerSec,
    offsets
  };
}

function getUsableHosts(ns, maxDepth) {
  const weakenCost = ns.getScriptRam("worker-weaken.js");
  return scanAllServers(ns, maxDepth).filter(h => ns.hasRootAccess(h) && ns.getServerMaxRam(h) >= weakenCost && h !== "home");
}

/**
 * Choose the top N hack targets by potential income/sec
 * @param {NS} ns
 * @param {string[]} servers   – list of all candidate hostnames
 * @param {number} topTarget   – max number of targets to return
 * @returns {string[]}         – sorted list of at most topTarget hosts
 */
function selectTargets(ns, servers, topTarget) {
  const level = ns.getHackingLevel();
  
  // Build a list of { server, potential } entries
  const candidates = servers
    .filter(s => {
      if (!ns.hasRootAccess(s)) return false;
      if (ns.getServerMaxMoney(s) <= 0) return false;
      // if you're over level 500, skip any server with <1 billion
      if (level > 500 && ns.getServerMaxMoney(s) <= 1e9) return false;
      return ns.getServerRequiredHackingLevel(s) <= level;
    })
    .map(s => {
      const maxMoney   = ns.getServerMaxMoney(s);
      const hackTime   = ns.getHackTime(s) / 1000;            // seconds
      const hackFrac   = ns.hackAnalyze(s);                   // fraction per thread
      const hackChance = ns.hackAnalyzeChance(s);             // success probability
      const potential  = hackTime > 0
        ? (maxMoney * hackFrac * hackChance) / hackTime
        : 0;
      return { server: s, potential };
    });

  // Sort by descending potential and take the top N
  candidates.sort((a, b) => b.potential - a.potential);
  return candidates.slice(0, topTarget).map(c => c.server);
}

/**
 * Scan all servers up to a given depth.
 * @param {NS} ns
 * @param {number} maxDepth
 * @returns {string[]} list of hostnames
 */
function scanAllServers(ns, maxDepth = 6) {
  const visited = new Set();
  const stack = [{ host: "home", depth: 0 }];
  const result = [];
  while (stack.length > 0) {
    const { host, depth } = stack.pop();
    if (visited.has(host) || depth > maxDepth) continue;
    visited.add(host);
    result.push(host);
    for (const n of ns.scan(host)) {
      if (!visited.has(n)) {
        stack.push({ host: n, depth: depth + 1 });
      }
    }
  }
  return result;
}

function renderRecoveryLog(ns, targets, pool, scheduled, totalWeakenDemand, totalGrowDemand) {
  // Compute stats
  const ratios = targets.map(t => {
    const cur = ns.getServerMoneyAvailable(t);
    const max = ns.getServerMaxMoney(t);
    return { name: t, ratio: cur / (max + 1) };
  });
  const avgRatio = ratios.reduce((sum, r) => sum + r.ratio, 0) / ratios.length;
  const worst    = ratios.reduce((min, r) => r.ratio < min.ratio ? r : min, ratios[0]);

  const totalRam = pool.reduce((sum, h) => sum + ns.getServerMaxRam(h.host), 0);
  const usedRam  = pool.reduce((sum, h) => sum + (ns.getServerMaxRam(h.host) - h.free), 0);
  const freeRam  = totalRam - usedRam;

  const t = countThreads(ns, pool);

  ns.clearLog();
  ns.print("─ RECOVERY MODE ─────────────────");
  ns.print(`Targets       : ${targets.length}`);
  ns.print(`Scheduled     : ${scheduled}`);
  ns.print(`Avg Money     : ${(avgRatio * 100).toFixed(1)}%`);
  ns.print(`Worst Target  : ${worst.name} ${(worst.ratio * 100).toFixed(1)}%`);
  ns.print(`Weaken Demand : ${totalWeakenDemand}`);
  ns.print(`Grow Demand   : ${totalGrowDemand}`);
  ns.print(`RAM Free/Total: ${freeRam.toFixed(1)}/${totalRam.toFixed(1)} GB`);
  ns.print(`Threads W/G/H : ${t.weaken}/${t.grow}/${t.hack}`);
  ns.print("─────────────────────────────────");
}

function renderBatchLog(ns, plans, sched, profit, pool, f,m,s, launchedW, launchedG, launchedH) {
  const totalRam=pool.reduce((s,h)=>s+ns.getServerMaxRam(h.host),0);
  const usedRam = pool.reduce((s,h)=>s+(ns.getServerMaxRam(h.host)-h.free),0);
  const demandW = plans.reduce((sum,p) => sum + p.weakenAfterHack + p.weakenAfterGrow, 0),
      demandG = plans.reduce((sum,p) => sum + p.growThreads,               0),
      demandH = plans.reduce((sum,p) => sum + p.hackThreads,               0);
  ns.clearLog();
  ns.print("===== BATCH MODE =====");
  ns.print(`Targets: ${plans.length} | Batches: ${sched}`);
  ns.print(`Profit/s: $${ns.nFormat(profit,"0.00a")}`);
  ns.print(`RAM: ${usedRam.toFixed(1)}/${totalRam} GB`);
  const t=countThreads(ns, pool);
  ns.print(`Threads → W:${t.weaken} G:${t.grow} H:${t.hack}`);
  ns.print(
    `ΔDemand% W:${(((launchedW - demandW) / demandW) * 100).toFixed(1)}% ` +
    `G:${(((launchedG - demandG) / demandG) * 100).toFixed(1)}% ` +
    `H:${(((launchedH - demandH) / demandH) * 100).toFixed(1)}%`
  );
  ns.print(`Timing → Fast:${f} Med:${m} Slow:${s}`);
}

function countThreads(ns, pool) {
  let weaken = 0, grow = 0, hack = 0;
  // pool is an array of { host, free } – we only care about host here
  for (const server of pool) {
    const host = server.host;
    for (const p of ns.ps(host)) {
      if (p.filename === "worker-weaken.js")        weaken += p.threads;
      else if (p.filename === "worker-grow.js")      grow   += p.threads;
      else if (p.filename === "worker-hack.js")      hack   += p.threads;
    }
  }
  return { weaken, grow, hack };
}

/**  
 * Given a list of hosts and your script costs, pick as many full‐pipeline targets  
 * (hack→grow→weaken→weaken) as will fit in your total free RAM.  
 */
function computeDynamicTargets(ns, hosts, wCost, gCost, hCost, secBuf,
                               weakenScript, growScript, hackScript) {
  // 1) Measure total free RAM at startup
  let freeRam = hosts
    .map(h => ns.getServerMaxRam(h) - ns.getServerUsedRam(h))
    .reduce((sum, f) => sum + f, 0);

  // 2) Build a plan for each host (reuse your planBatch)
  const plans = hosts
    .map(h => planBatch(ns, h, secBuf, weakenScript, growScript, hackScript, wCost, gCost, hCost))
    .filter(p => p)
    .map(p => {
       // precompute the RAM one pipeline of this plan needs:
        p.ramNeeded = 
        p.hackThreads   * hCost +
        p.growThreads   * gCost +
        (p.weakenAfterHack + p.weakenAfterGrow) * wCost;
      return p;
    })
    .sort((a,b) => a.ramNeeded - b.ramNeeded);
    // .sort((a, b) => b.estimatedIncomePerSec - a.estimatedIncomePerSec);

  // 3) Greedily pick as many as will fit
  const selected = [];
  let accRam = 0;
  for (const p of plans) {
    const ramNeeded =
      p.hackThreads   * hCost +
      p.growThreads   * gCost +
      (p.weakenAfterHack + p.weakenAfterGrow) * wCost;

    if (accRam + ramNeeded > freeRam) break;
    selected.push(p.target);
    accRam += ramNeeded;
  }

  return selected;
}
