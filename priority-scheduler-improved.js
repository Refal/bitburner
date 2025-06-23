const debug = false;

// ---- Global Settings ----
const BATCH_WINDOW_MS = 200;    // Minimum allowed gap between phases (safe value)
const BASE_OFFSET = 200;        // Time between launches of consecutive batches per target (should be >= BATCH_WINDOW_MS)
const BATCH_PAUSE = 3000;   // pause between planning cycles
const OFFEST_MAX_TRIES = Math.ceil(BATCH_PAUSE / BATCH_WINDOW_MS) - 1 // we can try to fill a whole pause window - one BATCH_WINDOW gap
// ---- Global Window Tracker ----
const batchWindows = {}; // { [target]: [ { hack:ms, grow:ms, weakenH:ms, weakenG:ms } ] }

/** @param {NS} ns */
export async function main(ns) {
  
    ns.ui.openTail();
    ns.clearLog();
    
    // 2) Turn off the built-in function logs (so only your prints show)
    ns.disableLog("ALL");

    // 3) Now that the tail is open and cleared, write your first debug line
    if (debug) ns.print("===== Script started =====");

    const arg0 = parseInt(ns.args[0]);
    const maxDepth    = isNaN(arg0) ? 20 : arg0;
    
    const arg1 = parseInt(ns.args[1]);
    const maxTarget    = isNaN(arg1) ? -1 : arg1;

    // Constants
    const weakenScript = "worker-weaken.js";
    const growScript = "worker-grow.js";
    const hackScript = "worker-hack.js";
    const isFormula = isFormulaAvailable()

    // once at startup, snap the usableHosts and compute a memory‐bounded target list
    const servers          = scanAllServers(ns, maxDepth)
    const playerLevel      = ns.getHackingLevel()
    const isAdvance      = playerLevel>500;
    let moneyHosts       = servers
    .filter(h => isAdvance?ns.getServerMaxMoney(h) > 1e9:ns.getServerMaxMoney(h)>0)
    .filter(s => {
        const reqHackLevel = ns.getServerRequiredHackingLevel(s);
        if (reqHackLevel > playerLevel) return false;
        const maxMoney = ns.getServerMaxMoney(s);
        // Exclude NaN, 0, negative, undefined, null, or special servers
        return typeof maxMoney === "number" && isFinite(maxMoney) && maxMoney > 0;
    })
  
    if(maxTarget>0) {
        moneyHosts = getTopProfitServers(ns, moneyHosts, maxTarget, isFormula)
    }        

    let cycleCount = 0
  
    while (true && (!debug || cycleCount++<2)) {
        ns.clearLog()
        // 2. Prep any that need recovery
        const status = getTargetRecoveryStatus(ns, moneyHosts, 0.5, 2);
        if (status.needsRecovery.length > 0) {
            prepServersStep(ns, servers, status.needsRecovery.map(t => t.host), 0.8, 0.5, 1, isFormula );
        }
        let workers = getUsableHosts(ns, servers);
        let maxCPU  = Math.max(...workers.map(w => w.cores));
        let totalAvailableMem = workers.map(s=>s.availableMem).reduce((a,b)=> a+b)
        // 4. Build/rebuild batch assignments
        let batches = {}
        let maxAmountBatch = 0;
        let hackFraction = 0.1;
        let minBatchesMem = 0;
        let totalBatchesMem = 0;
        let tries = 0;
        while(maxAmountBatch == 0 && tries <2) {
            batches = getBatchPlan(ns, status.ok.map(s=>s.host),hackFraction, 0.8, hackScript, growScript, weakenScript, maxCPU, isFormula)
                        
            totalBatchesMem = Object.values(batches).reduce(
            (total, batch) =>
                total +
                (batch.batchMatrix[0][0].batchRam
                    ?batch.batchMatrix[0][0].batchRam: 0), 0
            );
            //fallback to do at least small hack if nothing is working
            if(totalBatchesMem>totalAvailableMem) 
                hackFraction *= 0.9*totalAvailableMem/totalBatchesMem 

            minBatchesMem = Object.values(batches).reduce(
            (total, batch) =>
                Math.min(total,
                (batch.batchMatrix[0][0].batchRam
                    ?batch.batchMatrix[0][0].batchRam: Infinity)), Infinity
            );

            maxAmountBatch = calcMaxParallelBatches(totalAvailableMem, totalBatchesMem)
      
            tries++;
        }
        

        // Call in main loop:
        const batchAssignments = assignAllBatchesWithWindows(ns, batches, workers, maxAmountBatch);

        
        // 5. Launch as many batches as desired
        let batchFailures = await launchMultiBatches(ns, batchAssignments);
        
        const { totalMem, freeMem } = getMemoryStatsForHosts(workers);

        const preppingArr = Array.isArray(status.needsRecovery) ? status.needsRecovery : [];

        const moneyNeeded = preppingArr
        .map(r => Number(r.moneyNeeded) || 0)
        .reduce((a, b) => a + b, 0);

        const secToReduce = preppingArr
        .map(r => Number(r.secToReduce) || 0)
        .reduce((a, b) => a + b, 0);

        ns.print([
        `[${(new Date()).toLocaleTimeString()}] Batch Cycle`,
        `Targets: ${moneyHosts.length}`,
        `  Ready: ${status.ok.length} | Prepping: ${preppingArr.length}`,
        `  $ Needed: ${shortNum(moneyNeeded)} | Sec to Reduce: ${secToReduce.toFixed(2)}`,
        `Workers: ${workers.length} | Parallel/target: ${maxAmountBatch}`,
        `RAM: Used ${(totalMem-freeMem).toFixed(1)} / ${totalMem.toFixed(1)} GB`,
        `     Free: ${freeMem.toFixed(1)} GB`,
        `Batches: ${batchAssignments.length}, hackFraction: ${hackFraction}`,
        `. BatchMem: ${totalBatchesMem.toFixed(1)} GB/MinBatchMem: ${minBatchesMem.toFixed(1)} GB` +
            (batchFailures > 0 ? ` | ⚠️ Skipped: ${batchFailures}` : "")
        ].join('\n'));

        if(debug){
            ns.print([
            `[SUMMARY] Batch: ${status.ok.length}, Prep: ${status.needsRecovery.length}, Idle: ${moneyHosts.length - status.ok.length - status.needsRecovery.length}`
            ].join('\n'));
        }
        // 6. Wait before next cycle
        await ns.sleep(BATCH_PAUSE); // 5 seconds—tune for your environment!
    }
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
  return result.filter(s=>s!="home");
}


function getUsableHosts(ns, servers) {
  const weakenCost = ns.getScriptRam("worker-weaken.js");
  return servers.filter(h => ns.hasRootAccess(h) && ns.getServerMaxRam(h) >= weakenCost)
  .map(s=>({
      host: s, 
      availableMem: ns.getServerMaxRam(s) - ns.getServerUsedRam(s),
      cores: ns.getServer(s).cpuCores,
      maxMem: ns.getServerMaxRam(s)
      }));
}

/**
 * Returns total and free memory for the given list of hosts.
 * @param {Array} hosts - Array of {host, availableMem, maxMem, ...}
 * @returns {{totalMem: number, freeMem: number}}
 */
export function getMemoryStatsForHosts(hosts) {
    return hosts.reduce(
        (acc, h) => {
            acc.totalMem += h.maxMem;
            acc.freeMem += h.availableMem;
            return acc;
        },
        { totalMem: 0, freeMem: 0 }
    );
}

/**
 * Returns batch plan with per-phase, per-core matrices for easy worker matching, including phase offsets.
 * @param {NS} ns
 * @param {string[]} servers
 * @param {number} hackFraction
 * @param {string} hackScript
 * @param {string} growScript
 * @param {string} weakenScript
 * @param {number} maxCores - Precompute for 1..maxCores
 * @returns {Object} mapping hostname -> batch plan matrix
 */
export function getBatchPlan(
    ns,
    servers,
    hackFraction = 0.1,
    maxMoneFraction = 0.7,
    hackScript,
    growScript,
    weakenScript,
    maxCores = 3,
    isFormulaAvailable = false 
) {
    const player = ns.getPlayer();
    const result = {};
    const hackRam = ns.getScriptRam(hackScript);
    const growRam = ns.getScriptRam(growScript);
    const weakenRam = ns.getScriptRam(weakenScript);

    for (const hostname of servers) {    
        const server = ns.getServer(hostname);
        const maxMoney = server.moneyMax;
        const curMoney = Math.max(server.moneyAvailable, 1);

        // --- HACK calculations
        let hackChance, hackPercent, hackTime, growTime, weakenTime;
        if (isFormulaAvailable && ns.formulas && ns.formulas.hacking) {
            hackChance = ns.formulas.hacking.hackChance(server, player);
            hackPercent = ns.formulas.hacking.hackPercent(server, player);
            hackTime = ns.formulas.hacking.hackTime(server, player);
            growTime = ns.formulas.hacking.growTime(server, player);
            weakenTime = ns.formulas.hacking.weakenTime(server, player);
        } else {
            // Fallbacks (estimates, not as accurate as formulas)
            hackChance = ns.hackAnalyzeChance(hostname);
            hackPercent = ns.hackAnalyze(hostname);
            hackTime = ns.getHackTime(hostname);
            growTime = ns.getGrowTime(hostname);
            weakenTime = ns.getWeakenTime(hostname);
        }
        
        // Plan to hack hackFraction of "after grow" money (the steady state)
        const batchMoney = maxMoney * maxMoneFraction; // Steady-state batch money
        const hackAmount = batchMoney * hackFraction;  // e.g., 0.1 for 10% of batch state
        const hackThreads = hackPercent > 0
            ? Math.ceil(hackAmount / (batchMoney * hackPercent * hackChance))
            : 0;
        // Simulate post-hack state for grow planning
        const postHackMoney = batchMoney - hackAmount;        
        const secIncreaseHack = ns.hackAnalyzeSecurity(hackThreads);

        // For hack/weaken after hack, just use 1 core (you could expand for hack/weaken cores too if needed)
        const weakenThreadsAfterHack = Math.ceil(secIncreaseHack / ns.weakenAnalyze(1));

        // PHASE OFFSETS
        // These offsets are standard for 4-phase Bitburner batching:
        const hackOffset = weakenTime - hackTime;
        const growOffset = weakenTime - growTime + 100; // 100ms after hack lands
        const weakenHOffset = 0;                        // Hack weaken lands last
        const weakenGOffset = 200;                      // Grow weaken lands slightly after grow

        // Precompute grow/weaken matrices
        const batchMatrix = [];
        for (let growCores = 1; growCores <= maxCores; ++growCores) {
            batchMatrix[growCores - 1] = [];
            let growThreads;
            if (isFormulaAvailable && ns.formulas && ns.formulas.hacking) {
                growThreads = Math.ceil(ns.formulas.hacking.growThreads(
                    { ...server, moneyAvailable: postHackMoney }, player, batchMoney, growCores
                ));
            } else {
                // Fallback: growthAnalyze ratio (ignores cores, but it's the only API available)
                // ns.growthAnalyze(host, growth, cores) - we use growCores here for best-guess
                growThreads = Math.ceil(ns.growthAnalyze(hostname, batchMoney / Math.max(1, postHackMoney), growCores));
            } 
            const secIncGrow = ns.growthAnalyzeSecurity(growThreads, hostname, growCores);
            for (let weakenCores = 1; weakenCores <= maxCores; ++weakenCores) {
                const weakenPerThread = ns.weakenAnalyze(1, weakenCores);
                const weakenAfterGrow = Math.ceil(secIncGrow / weakenPerThread);
                // RAM for this combo (add hack/weaken-after-hack RAM as they don't depend on cores)
                const batchRam = (
                    hackThreads * hackRam +
                    growThreads * growRam +
                    weakenThreadsAfterHack * weakenRam + // hack weaken
                    weakenAfterGrow * weakenRam           // grow weaken
                );
                const totalThreads = hackThreads + growThreads + weakenThreadsAfterHack + weakenAfterGrow;
                const batchProfit = hackAmount * hackChance;
                const profitPerGB = batchRam > 0 ? batchProfit / batchRam : 0;
                const profitPerGbPerSec = weakenTime > 0 ? profitPerGB / (weakenTime / 1000) : 0;
                batchMatrix[growCores - 1][weakenCores - 1] = {
                    growCores,
                    weakenCores,
                    growThreads,
                    weakenAfterGrow,
                    batchRam,
                    totalThreads,
                    batchProfit,
                    profitPerGB,
                    profitPerGbPerSec,
                    // PHASE OFFSETS for this batch (for use in assignment)
                    hackOffset,
                    growOffset,
                    weakenHOffset,
                    weakenGOffset,
                };
                 if (batchRam === 0) {
                   ns.print(`[WARN][${hostname}] batchMatrix[${growCores - 1}][${weakenCores - 1}] batchRam=0 (hackT=${hackThreads}, growT=${growThreads}, weakH=${weakenThreadsAfterHack}, weakG=${weakenAfterGrow})`);
                }
            }
           
        }
      
        result[hostname] = {
            server: hostname,
            maxMoney,
            curMoney,
            minSec: server.minDifficulty,
            curSec: server.hackDifficulty,
            hackFraction,
            hackThreads,
            hackTime,
            growTime,
            weakenTime,
            weakenThreadsAfterHack,
            scripts: {
                hack: hackScript,
                grow: growScript,
                weaken: weakenScript,
            },
            // PHASE OFFSETS (top-level for convenience)
            phaseOffsets: {
                hack: hackOffset,
                grow: growOffset,
                weakenH: weakenHOffset,
                weakenG: weakenGOffset,
            },
            batchMatrix, // [growCores][weakenCores]: stats and offsets for each combo
        };
    }

    return result;
}

/**
 * Launch up to N parallel batches per target, spacing each batch and phase with proper offsets.
 * @param {NS} ns
 * @param {Array} batchAssignments - Array of { server, assignments: [...] }
 * @param {number} batchInterval - ms between batches (e.g., 200)
 * @param {Array} workers - [{host, availableMem, cores}]
 * @param {number} parallelBatches - max batches per target (depth)
 */
export async function launchMultiBatches(ns, batchAssignments) {
    let batchesSkipped = 0;

    for (const batch of batchAssignments) {
        // Defensive: skip batches with empty assignments
        if (!batch.assignments || batch.assignments.length === 0) {
            batchesSkipped++;
            continue;
        }
        for (const a of batch.assignments) {
            // Launch the script with the precomputed offset
            const pid = ns.exec(a.script, a.host, a.threads, batch.server, a.threads, a.offset);
            if (pid === 0) {
                ns.print(`ERROR: Failed to launch ${a.script} on ${a.host}`);         
            }
            
        }
    }
    return batchesSkipped;
}

/**
 * Recovers a list of servers to near-max money and low security using all provided workers IN PARALLEL.
 * Will launch as many jobs as RAM allows, and process all targets in rounds.
 * @param {NS} ns
 * @param {Array} workers - [{host, availableMem, cores}]
 * @param {Array} targets - list of target server hostnames
 * @param {number} moneyTargetFrac - e.g. 0.9 for 90% of max
 * @param {number} secBuffer - e.g. 0.5 for minSec+0.5
 * @param {number} maxGrowCores - max grow cores to use (default 8)
 */
/**
 * Kicks off as many grow/weaken jobs as possible for prepping, but does NOT block.
 * Call once per main loop cycle.
 */
export function prepServersStep(
    ns,
    servers,
    targets,
    moneyTargetFrac = 0.9,
    secBuffer = 0.5,
    maxGrowCores = 1,
    isFormulaAvailable = false
) {
    const growScript = "worker-grow.js";
    const weakenScript = "worker-weaken.js";
    const growRam = ns.getScriptRam(growScript);
    const weakenRam = ns.getScriptRam(weakenScript);
    const availableWorkers = getUsableHosts(ns, servers);

    // Prep only: For each prepping target, schedule missing jobs if RAM allows
    function getTargetsStatus() {
        return targets.map(target => {
            const s = ns.getServer(target);
            const moneyGoal = s.moneyMax * moneyTargetFrac;
            const secGoal = s.minDifficulty + secBuffer;
            return {
                host: target,
                money: s.moneyAvailable,
                moneyGoal,
                moneyShort: Math.max(0, moneyGoal - s.moneyAvailable),
                moneyOk: s.moneyAvailable >= moneyGoal,
                sec: s.hackDifficulty,
                secGoal,
                secHigh: s.hackDifficulty > secGoal,
                secToReduce: Math.max(0, s.hackDifficulty - secGoal),
                maxMoney: s.moneyMax,
                minSec: s.minDifficulty,
            };
        });
    }

    let statuses = getTargetsStatus();
    let prepping = statuses.filter(s => !s.moneyOk || s.secHigh);
    let workersState = availableWorkers.map(w => ({ ...w }));

    for (const stat of prepping) {
        // WEAKEN needed
        if (stat.secHigh) {
            let server = ns.getServer(stat.host);
            let player = ns.getPlayer();
            let weakenThreadsNeeded = Math.ceil(stat.secToReduce / ns.weakenAnalyze(1, 1));
            let runningWeaken = countActiveThreads(ns, servers, weakenScript, stat.host);

            let weakenThreadsLeft = Math.max(0, weakenThreadsNeeded - runningWeaken);
            for (let wi = 0; wi < workersState.length; ++wi) {
                const w = workersState[wi];
                const assign = Math.min(weakenThreadsLeft, Math.floor(w.availableMem / weakenRam));
                if (assign > 0) {
                    const pid = ns.exec(weakenScript, w.host, assign, stat.host, assign);
                    if (pid === 0) continue;
                    w.availableMem -= assign * weakenRam;
                    workersState[wi].availableMem = w.availableMem;
                    weakenThreadsLeft -= assign;
                }
                if (weakenThreadsLeft <= 0) break;
            }
            if(debug && weakenThreadsLeft > 0) {
                ns.print(`[PREP-FAIL][${stat.host}] Could not assign ${weakenThreadsLeft} weaken threads (RAM?)`);
            }
        }        
        // GROW needed
        if (!stat.moneyOk) {
            let sorted = workersState
                .map((w, i) => ({ ...w, i }))
                .sort((a, b) => b.cores - a.cores || b.availableMem - a.availableMem);

            let best = sorted[0];
            let server = ns.getServer(stat.host);
            let player = ns.getPlayer();
            let growThreadsTotal = 0;
            if (isFormulaAvailable) {
                growThreadsTotal = Math.ceil(ns.formulas.hacking.growThreads(
                    server, player, stat.moneyGoal, Math.min(best.cores, maxGrowCores)
                ));
            } else {
                // Fallback: Use ns.growthAnalyze (does not consider cores, but okay as fallback)
                growThreadsTotal = Math.ceil(ns.growthAnalyze(stat.host, stat.moneyGoal / Math.max(1, stat.money), best.cores));
            }
            let runningGrow = countActiveThreads(ns, servers, growScript, stat.host);
            let growThreadsLeft = Math.max(0, growThreadsTotal - runningGrow);

            for (const w of sorted) {
                if (growThreadsLeft <= 0) break;
                const assign = Math.min(growThreadsLeft, Math.floor(w.availableMem / growRam));
                if (assign > 0) {
                    const pid = ns.exec(growScript, w.host, assign, stat.host, assign);
                    if (pid === 0) continue;
                    w.availableMem -= assign * growRam;
                    workersState[w.i].availableMem = w.availableMem;
                    growThreadsLeft -= assign;
                }
            }             
            if (debug && growThreadsLeft > 0) {
                ns.print(`[PREP-FAIL][${stat.host}] Could not assign ${growThreadsLeft} grow threads (RAM?)`);
            }
        }
                
    }
}



/**
 * Checks which targets are ready and which need prep, and what for.
 * @param {NS} ns
 * @param {Array<string>} targets - Hostnames to check
 * @param {number} moneyFrac - E.g. 0.9 for 90% of max money (default)
 * @param {number} secBuffer - E.g. 0.5 above minSec (default)
 * @returns {{ok: Array, needsRecovery: Array}}
 */
export function getTargetRecoveryStatus(ns, targets, moneyFrac = 0.9, secBuffer = 0.5) {
    const ok = [];
    const needsRecovery = [];

    for (const host of targets) {
        const s = ns.getServer(host);
        const moneyReady = s.moneyAvailable >= s.moneyMax * moneyFrac;
        const secReady = s.hackDifficulty <= s.minDifficulty + secBuffer;

        if (moneyReady && secReady) {
            ok.push({
                host,
                money: s.moneyAvailable,
                moneyMax: s.moneyMax,
                security: s.hackDifficulty,
                minSec: s.minDifficulty
            });
        } else {
            needsRecovery.push({
                host,
                money: s.moneyAvailable,
                moneyNeeded: Math.max(0, s.moneyMax * moneyFrac - s.moneyAvailable),
                security: s.hackDifficulty,
                secToReduce: Math.max(0, s.hackDifficulty - (s.minDifficulty + secBuffer)),
                moneyOk: moneyReady,
                secOk: secReady,
                moneyMax: s.moneyMax,
                minSec: s.minDifficulty
            });
        }
    }
    return { ok, needsRecovery };
}

/**
 * Calculates how many parallel batches can be run, given total available RAM and batch RAM usage.
 * @param {Array} totalAvailableMem 
 * @param {number} batchRam - Total RAM used by one batch (sum of all phase RAMs)
 * @returns {number} Maximum number of parallel batches that can fit.
 */
export function calcMaxParallelBatches(totalAvailableMem, batchRam) {
    if (batchRam <= 0) return 0;
    return Math.floor(totalAvailableMem / batchRam);
}

/**
 * Returns the top N servers by potential max profit per thread per second.
 * @param {NS} ns - Bitburner Netscript context (pass 'ns' in scripts)
 * @param {Array} servers - Array of server names (string) or server objects with at least 'name'
 * @param {number} topN - How many servers to return
 * @returns {Array} Sorted array of server info with calculated profit per thread per second
 */
export function getTopProfitServers(ns, servers, topN, isFormulaAvailable = false) {
  const player = ns.getPlayer()
    // Helper to get info if only name is provided
    function getInfo(server) {
        const hostname = server.hostname || server.name || server; 
        if (isFormulaAvailable && ns.formulas && ns.formulas.hacking) {
            // Use formulas API
            return {
                ...server,
                hackChance: ns.formulas.hacking.hackChance(server, player),
                hackTime: ns.formulas.hacking.hackTime(server, player),
                weakenTime: ns.formulas.hacking.weakenTime(server, player),
                maxMoney: ns.getServerMaxMoney(server.hostname),
                curMoney: ns.getServerMoneyAvailable(server.hostname),
                hostname
            };
        } else {
            return {
                ...server,
                hackChance: ns.hackAnalyzeChance(hostname),
                hackTime: ns.getHackTime(hostname),
                weakenTime: ns.getWeakenTime(hostname),
                maxMoney: ns.getServerMaxMoney(hostname),
                curMoney: ns.getServerMoneyAvailable(hostname),
                hostname, // ensure hostname always present
            };
        }
    }

    // Normalize: always get server object (if only string provided)
    const normalizedServers = servers.map(s => (typeof s === "string" ? ns.getServer(s) : s));
    
    const serversWithProfit = normalizedServers.map(getInfo).map(s => ({
        ...s,
        profitPerThreadPerSec: s.weakenTime > 0
            ? (s.maxMoney * s.hackChance / s.weakenTime / 1000)
            : 0,
    })).filter(s =>
        s.profitPerThreadPerSec > 0 &&
        s.maxMoney > 0 &&
        s.curMoney > 0
    );

    // Sort by profit descending
    serversWithProfit.sort((a, b) => b.profitPerThreadPerSec - a.profitPerThreadPerSec);

    // Optionally print debug output
    // ns.printf("servers profit: %j", serversWithProfit);

    // Return top N hostnames
    return serversWithProfit.slice(0, topN).map(s => s.hostname);
}

function countActiveThreads(ns, workers, scriptName, target) {
    let count = 0;
    for (const w of workers) {
        for (const proc of ns.ps(w.host)) {
            if (proc.filename === scriptName && proc.args[0] === target) {
                count += proc.threads;
            }
        }
    }
    return count;
}

// ---- Batch Window Helpers ----
function canScheduleBatch(target, landings) {
    if (!batchWindows[target]) return true;
    for (const batch of batchWindows[target]) {
        if (Math.abs(landings.hack - batch.hack) < BATCH_WINDOW_MS) return false;
        if (Math.abs(landings.grow - batch.grow) < BATCH_WINDOW_MS) return false;
        if (Math.abs(landings.weakenH - batch.weakenH) < BATCH_WINDOW_MS) return false;
        if (Math.abs(landings.weakenG - batch.weakenG) < BATCH_WINDOW_MS) return false;
    }
    return true;
}
function recordBatch(target, landings) {
    if (!batchWindows[target]) batchWindows[target] = [];
    batchWindows[target].push(landings);
}
function pruneOldBatches(now) {
    for (const target in batchWindows) {
        batchWindows[target] = batchWindows[target].filter(b =>
            Math.max(b.hack, b.grow, b.weakenH, b.weakenG) > now
        );
        if (batchWindows[target].length === 0) delete batchWindows[target];
    }
}

/**
 * Attempts to assign as many batches as possible per target, honoring window, RAM, and cores.
 * Returns an array of assignments, suitable for launchMultiBatches.
 *
 * @param {NS} ns
 * @param {object} batches - mapping target->batchTemplate (from getBatchPlan)
 * @param {Array} workers - worker states [{host, availableMem, cores, ...}]
 * @param {number} maxBatchesPerTarget
 * @returns {Array} batchAssignments [{server, batchNum, assignments, offsets}]
 */
function assignAllBatchesWithWindows(ns, batches, workers, maxBatchesPerTarget) {
    const now = Date.now();
    pruneOldBatches(now);
    if(debug) {
        for (const target of Object.keys(batchWindows)) {
                ns.print(`[WINDOW][${target}] Tracked batches: ${batchWindows[target].length}`);
        }
    }

    const batchAssignments = [];
    const workerStates = workers.map(w => ({ ...w }));

    for (const target of Object.keys(batches)) {
        
        const batchTemplate = batches[target];
        let batchNum = 0;
        const batch_duration = batchTemplate.weakenTime; // or time between scheduling and the *last* phase
        const base_offset = BASE_OFFSET; // e.g., 200 ms
        
        const max_batches = Math.min(maxBatchesPerTarget, Math.floor(batch_duration / base_offset));

        // Try from highest to lowest cores, to maximize batch quality
        for (let coreAttempt = batchTemplate.batchMatrix.length; coreAttempt >= 1; coreAttempt--) {
            let scheduledBatches = 0;
            while (scheduledBatches < max_batches) {
                let extraOffset = 0, tries = 0, scheduled = false;
                while (tries < OFFEST_MAX_TRIES && !scheduled) {
                    // Pick stats for this (growCores, weakenCores)
                    let stats = batchTemplate.batchMatrix[coreAttempt - 1][coreAttempt - 1]; // square fallback
                    if (!stats) break; // if no such entry

                    // Calculate offsets
                    const hackOffset = stats.hackOffset + batchNum * BASE_OFFSET + extraOffset;
                    const growOffset = stats.growOffset + batchNum * BASE_OFFSET + extraOffset;
                    const weakenHOffset = stats.weakenHOffset + batchNum * BASE_OFFSET + extraOffset;
                    const weakenGOffset = stats.weakenGOffset + batchNum * BASE_OFFSET + extraOffset;

                    // Calculate landing times
                    const hackLand    = now + hackOffset    + batchTemplate.hackTime;
                    const growLand    = now + growOffset    + batchTemplate.growTime;
                    const weakenHLand = now + weakenHOffset + batchTemplate.weakenTime;
                    const weakenGLand = now + weakenGOffset + batchTemplate.weakenTime;
                    const landings = { hack: hackLand, grow: growLand, weakenH: weakenHLand, weakenG: weakenGLand };

                    // Check window
                    if (canScheduleBatch(target, landings)) {
                        // Attempt assignment
                        const { assignments, canAssign } = tryAssignBatchWithOffsets(
                            ns, batchTemplate, workerStates, stats,
                            hackOffset, growOffset, weakenHOffset, weakenGOffset
                        );
                        if (canAssign) {
                            if(debug) {
                                // For each target you are trying to batch:
                                ns.print(`\[BATCHER] ${target}: batch assigned`)                                
                                const server = ns.getServer(target);
                                const runningHack = countActiveThreads(ns, workers, "worker-hack.js", target);
                                const runningGrow = countActiveThreads(ns, workers, "worker-grow.js", target);
                                const runningWeaken = countActiveThreads(ns, workers, "worker-weaken.js", target);
                                ns.print(`[ACTIVE] ${target}: hackT=${runningHack}, growT=${runningGrow}, weakenT=${runningWeaken}`);                                
                                ns.print(`[STATE] ${target}: CurMoney=${shortNum(server.moneyAvailable)}, MaxMoney=${shortNum(server.moneyMax)}, CurSec=${server.hackDifficulty}, MinSec=${server.minDifficulty}`);
                                ns.print(`[BATCH-RAM][${target}] batchRam=${stats.batchRam}GB`);
                                ns.print(`[TIMING] ${target} Batch#${batchNum} ` +
                                    `Hack@${hackOffset}, Grow@${growOffset}, WeakenH@${weakenHOffset}, WeakenG@${weakenGOffset}`
                                );
                            }
                            recordBatch(target, landings);
                            
                            batchAssignments.push({
                                server: target,
                                batchNum,
                                assignments,
                                offsets: { hackOffset, growOffset, weakenHOffset, weakenGOffset }
                            });
                            scheduled = true;
                            break;
                        } else {
                            if(debug) ns.print(`\[BATCHER] ${target}: not enough RAM/cores`)
                        }
                    } else {
                        if(debug) ns.print(`\[BATCHER] ${target}: can not schedule that landing: ${String.values(...landings)}`)
                    }
                    // Slide forward in time
                    extraOffset += BATCH_WINDOW_MS;
                    tries++;        
                }
                // If you slide offset and still fail, also print how many ms you slid:
                if (debug && !scheduled && tries > 0) {
                    ns.print(`[SKIP][${target}] Batch window slide failed after ${extraOffset} ms`);
                }
                if (!scheduled) {
                    if(debug) ns.print('\[BATCHER] ${target}: Can\'t schedule more with this core count')
                    break; // Can't schedule more with this core count
                } 
                batchNum++;
                scheduledBatches++;
            }
            if (debug && scheduledBatches === 0) {
                ns.print(`[SKIP][${target}] No batch scheduled this cycle (RAM/window/prep?)`);
            }
        }
        if(debug) {
            const server = ns.getServer(target);
            ns.print(`[STATE] ${target}: CurMoney=${shortNum(server.moneyAvailable)}, MaxMoney=${shortNum(server.moneyMax)}, CurSec=${server.hackDifficulty}, MinSec=${server.minDifficulty}`);
        // For each target you are trying to batch:
            const runningHack = countActiveThreads(ns, workers, "worker-hack.js", target);
            const runningGrow = countActiveThreads(ns, workers, "worker-grow.js", target);
            const runningWeaken = countActiveThreads(ns, workers, "worker-weaken.js", target);

            ns.print(`[ACTIVE] ${target}: hackT=${runningHack}, growT=${runningGrow}, weakenT=${runningWeaken}`);
        }
    }
    return batchAssignments;
}

/**
 * Helper that tries to assign a batch with specific stats and explicit per-phase offsets.
 * Returns { assignments, canAssign } just like before.
 *
 * @param {NS} ns
 * @param {object} batchTemplate
 * @param {Array} workerStates
 * @param {object} stats
 * @param {number} hackOffset
 * @param {number} growOffset
 * @param {number} weakenHOffset
 * @param {number} weakenGOffset
 * @returns {{assignments: Array, canAssign: boolean}}
 */
function tryAssignBatchWithOffsets(
    ns, batchTemplate, workerStates, stats,
    hackOffset, growOffset, weakenHOffset, weakenGOffset
) {
    const hackScript   = batchTemplate.scripts.hack;
    const growScript   = batchTemplate.scripts.grow;
    const weakenScript = batchTemplate.scripts.weaken;
    const hackRam   = ns.getScriptRam(hackScript);
    const growRam   = ns.getScriptRam(growScript);
    const weakenRam = ns.getScriptRam(weakenScript);

    const hackThreads    = Math.ceil(batchTemplate.hackThreads);
    const growThreads    = Math.ceil(stats.growThreads);
    const weakenHThreads = Math.ceil(batchTemplate.weakenThreadsAfterHack);
    const weakenGThreads = Math.ceil(stats.weakenAfterGrow);
    const simulatedWorkers = workerStates.map(w => ({ ...w }));

    const assignments = [];
    let canAssign = true;
     if(debug) {
        ns.printf("Worker's stat: %j", workerStates)
        ns.printf("trying to assign stats: %j", stats)
     }
    // GROW
    let threadsLeft = growThreads;
    let growWorkers = simulatedWorkers
        .filter(w => w.cores >= stats.growCores && w.availableMem >= growRam)
        .sort((a, b) => b.cores - a.cores || b.availableMem - a.availableMem);
    for (const w of growWorkers) {
        if (threadsLeft <= 0) break;
        const assign = Math.min(threadsLeft, Math.floor(w.availableMem / growRam));
        if (assign > 0) {
            assignments.push({
                host: w.host, phase: "grow", threads: assign,
                script: growScript, offset: growOffset,
                usedMem: assign * growRam
            });
            w.availableMem -= assign * growRam;
            threadsLeft -= assign;
        }
    }
    
    if (threadsLeft > 0) {
        canAssign = false;
        if(debug) {
           ns.print(`[SKIP][${batchTemplate.server}] Not enough RAM/cores for phase: grow, needed: ${threadsLeft}`);
        }
    }

    // WEAKEN AFTER GROW
    threadsLeft = weakenGThreads;
    let weakenGWorkers = simulatedWorkers
        .filter(w => w.cores >= stats.weakenCores && w.availableMem >= weakenRam)
        .sort((a, b) => b.cores - a.cores || b.availableMem - a.availableMem);
    for (const w of weakenGWorkers) {
        if (threadsLeft <= 0) break;
        const assign = Math.min(threadsLeft, Math.floor(w.availableMem / weakenRam));
        if (assign > 0) {
            assignments.push({
                host: w.host, phase: "weakenG", threads: assign,
                script: weakenScript, offset: weakenGOffset,
                usedMem: assign * weakenRam
            });
            w.availableMem -= assign * weakenRam;
            threadsLeft -= assign;
        }
    }
    if (threadsLeft > 0) {
        canAssign = false;
        if(debug) {
        ns.print(`[SKIP][${batchTemplate.server}] Not enough RAM/cores for phase: weakenG, needed: ${threadsLeft}`);
        }
    }

    // HACK
    threadsLeft = hackThreads;
    let hackWorkers = simulatedWorkers
        .filter(w => w.availableMem >= hackRam)
        .sort((a, b) => b.availableMem - a.availableMem);
    for (const w of hackWorkers) {
        if (threadsLeft <= 0) break;
        const assign = Math.min(threadsLeft, Math.floor(w.availableMem / hackRam));
        if (assign > 0) {
            assignments.push({
                host: w.host, phase: "hack", threads: assign,
                script: hackScript, offset: hackOffset,
                usedMem: assign * hackRam
            });
            w.availableMem -= assign * hackRam;
            threadsLeft -= assign;
        }
    }
     if (threadsLeft > 0) {
        canAssign = false;
        if(debug) {
            ns.print(`[SKIP][${batchTemplate.server}] Not enough RAM/cores for phase: hack, needed: ${threadsLeft}`);
        }
    }

    // WEAKEN AFTER HACK
    threadsLeft = weakenHThreads;
    let weakenHWorkers = simulatedWorkers
        .filter(w => w.cores >= stats.weakenCores && w.availableMem >= weakenRam)
        .sort((a, b) => b.cores - a.cores || b.availableMem - a.availableMem);
    for (const w of weakenHWorkers) {
        if (threadsLeft <= 0) break;
        const assign = Math.min(threadsLeft, Math.floor(w.availableMem / weakenRam));
        if (assign > 0) {
            assignments.push({
                host: w.host, phase: "weakenH", threads: assign,
                script: weakenScript, offset: weakenHOffset,
                usedMem: assign * weakenRam
            });
            w.availableMem -= assign * weakenRam;
            threadsLeft -= assign;
        }
    }
    if (threadsLeft > 0) {
        canAssign = false;
        if(debug) {
            ns.print(`[SKIP][${batchTemplate.server}] Not enough RAM/cores for phase: weakenH, needed: ${threadsLeft}`);
        }
    }
    if (canAssign) {
    // Only now apply simulated state to real workerStates
    for (let i = 0; i < workerStates.length; i++) {
          workerStates[i].availableMem = simulatedWorkers[i].availableMem;
        }
    }

    return {assignments, canAssign};
}

function shortNum(n) {
  if (!isFinite(n)) return "0";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "t";
  if (n >= 1e9)  return (n / 1e9 ).toFixed(2) + "b";
  if (n >= 1e6)  return (n / 1e6 ).toFixed(2) + "m";
  if (n >= 1e3)  return (n / 1e3 ).toFixed(2) + "k";
  return n.toFixed(2);
}

function isFormulaAvailable() {
    try {
        // Pick any owned server to check (home is always safe)
        if (ns.formulas && ns.formulas.hacking) {
        const player = ns.getPlayer();
        const target = ns.getServer("home");
        // Try any formulas call
        ns.formulas.hacking.hackChance(target, player);
        return true;
        }
    } catch (e) {
        return false;
    }
}
