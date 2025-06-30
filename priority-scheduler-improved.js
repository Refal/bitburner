const debug = false;

// ---- Global Settings ----
const BATCH_WINDOW_MS = 150;    // Minimum allowed gap between phases (safe value)
const BASE_OFFSET = 150;        // Time between launches of consecutive batches per target (should be >= BATCH_WINDOW_MS)
const BATCH_PAUSE = 3_000;   // pause between planning cycles
const OFFEST_MAX_TRIES = Math.ceil(BATCH_PAUSE / BATCH_WINDOW_MS) - 1 // we can try to fill a whole pause window - one BATCH_WINDOW gap
// These are typical safe values; adjust as desired
const GAP_WEAKEN_H = 20;       // Gap between hack and weakenH landings (ms)
const GAP_GROW = 80;          // Gap between hack and grow landings (ms)
const GAP_WEAKEN_G = 20;       // Gap between grow and weakenG landings (ms)

const MIN_HACK_FRACTION = 0.001;
//do not consider host with a weaken time  > MAX_BATCH_TIME
const MAX_BATCH_TIME = 120 * 1000; // e.g., 2 minutes in ms
const MAX_TOTAL_BATCHES  = 100;
const MIN_TARGET_MONEY = 4.1e6;

// additional multiplier to balance grow and weaken for multibutch assignments
// change them based on growing of prep servers
// Globals (outside the function)
let GROW_THREADS_COMP_MULT = 0.6;
let WEAKEN_THREADS_COMP_MULT = 5.2;
let lastTuneTime = 0;


const growPrepPctHistory = [];
const weakenPrepPctHistory = [];

let autoTunePeriod = 120000; // Initial period: 2 min
let growStep = 0.02; // Start with ±2%
let weakenStep = 0.02;

const TARGET_PREP_PCT = 10; // %
const INCREASE_IF_BELOW = 1; // %

// How often to check (ms)
const MULTI_ADJUST_CALM_PERIOD = 240_000; // 4m
const MULTI_ADJUST_NOISE_PERIOD = 60_000; // 1m
const PREP_HISTORY_WINDOW = MULTI_ADJUST_CALM_PERIOD/BATCH_PAUSE;


// ---- Global Window Tracker ----
const batchWindows = {}; // { [target]: [ { hack:ms, grow:ms, weakenH:ms, weakenG:ms } ] }

// Global tracker for all prepping jobs launched by prepServersStep
// prepInFlightMap[host][type] = [{ threads, landing }]
const prepInFlightMap = {};

/** @param {NS} ns */
export async function main(ns) {
    ns.ui.openTail();
    ns.ui.moveTail(930,30)
    ns.ui.resizeTail(575, 400)
    ns.clearLog();
    ns.disableLog("ALL");
    if (debug) ns.print("===== Script started =====");

    const maxDepth = parseIntOrDefault(ns.args[0], 20);
    const maxTarget = parseIntOrDefault(ns.args[1], 60);
    const weakenScript = "worker-weaken.js";
    const growScript = "worker-grow.js";
    const hackScript = "worker-hack.js";
    
    let lastEligibleHosts = [];
    let count = 0;
    let lastServerList = []
    while (true) {
        ns.clearLog();
        const now = Date.now();
        pruneOldBatches(now);
        // ---- 1. Dynamically scan and choose best money hosts
        const servers = scanAllServers(ns, maxDepth);
        if (!arraysEqual(servers, lastServerList)) {
            // Copy all worker scripts to all new servers
            const scripts = ["worker-hack.js", "worker-grow.js", "worker-weaken.js"];
            await copyScriptsToHosts(ns, scripts, servers);
            lastServerList = [...servers]; // Update your cache
        }
        const playerLevel = ns.getHackingLevel();
        const allMoneyHosts = servers.filter(s => {
            const reqHackLevel = ns.getServerRequiredHackingLevel(s);
            if (reqHackLevel > playerLevel) return false;
            const maxMoney = ns.getServerMaxMoney(s);
            if(maxMoney < MIN_TARGET_MONEY) return false;
            return typeof maxMoney === "number" && isFinite(maxMoney) && maxMoney > 0;
        });

        // ---- 2. Plan batches for every candidate server
        const isFormula = isFormulaAvailable(ns);
        const batchesLimit = getBatchPlan(ns, allMoneyHosts, 0.1, 0.8, hackScript, growScript, weakenScript, 1, isFormula);

        let lastSortedMoneyHosts = [];
        let retargetInterval = 5;
        let cycleCount = 0;
        // Get the latest list of eligible hostnames
        let currentHostList = getUsableHosts(ns, servers)
        .map(s => s.host);

        // Compare to previous list (lastEligibleHosts)
        let hostsChanged = !arraysEqual(currentHostList, lastEligibleHosts);
        lastEligibleHosts = currentHostList; // update for next cycle

        if (cycleCount++ % retargetInterval === 0 || hostsChanged) {
             let sortedBatches = getSortedLimitedBatchArrayDynamic(batchesLimit,  getUsableHosts(ns, servers), maxTarget)
            lastSortedMoneyHosts = sortedBatches.map(({target}) => target);
        }
        let moneyHosts = lastSortedMoneyHosts;

        // ---- 4. Batch prep/assignment/launch
        const status = getTargetRecoveryStatus(ns, moneyHosts, 0.4, 4);
        if (status.needsRecovery.length > 0) {
            await prepServersStep(ns, servers, status.needsRecovery.map(t => t.host), 0.8, 0.5, 1, isFormula);
        }
        let workers = getUsableHosts(ns, servers);
        let maxCPU  = Math.min(Math.max(...workers.map(w => w.cores)), 8);
        let totalAvailableMem = workers.map(s=>s.availableMem).reduce((a,b)=> a+b, 0);
        const totalMaxsMem = workers.map(s=>s.maxMem).reduce((a,b)=> a+b, 0);
        
        autoTuneMultipliers(ns);
        ns.print(lastAutoTuneSummary);

        let hackFraction = 0.1;
        let batches = getBatchPlan(ns, status.ok.map(s=>s.host), hackFraction, 0.8, hackScript, growScript, weakenScript, maxCPU, isFormula);
        let sortedBatches = getSortedLimitedBatchArrayDynamic(batchesLimit, workers, maxTarget, true)
        let totalBatchesMem = sortedBatches.reduce((total, { batch }) => total + ((batch.batchMatrix[0][0]?.batchRam) || 0), 0);
        let maxAmountBatch = calcMaxParallelBatches(totalAvailableMem, totalBatchesMem);

        // fallback to smaller hack if nothing fits
        if(maxAmountBatch === 0 && totalMaxsMem < totalBatchesMem * 2) {
            hackFraction = Math.max(MIN_HACK_FRACTION, hackFraction * 0.9 * (totalAvailableMem / totalBatchesMem))
            batches = getBatchPlan(ns, status.ok.map(s=>s.host), hackFraction, 0.8, hackScript, growScript, weakenScript, maxCPU, isFormula)
            sortedBatches = getSortedLimitedBatchArrayDynamic(batchesLimit, workers, maxTarget, true)
            totalBatchesMem = sortedBatches.reduce((total, { batch }) => total + ((batch.batchMatrix[0][0]?.batchRam) || 0), 0)
            maxAmountBatch = calcMaxParallelBatches(totalAvailableMem, totalBatchesMem)
        }

        const minBatchesMem = sortedBatches.reduce(
            (min, { batch }) =>
                Math.min(min, (batch.batchMatrix[0][0]?.batchRam ?? Infinity)),
            Infinity
        );

        // ---- 5. Assign and launch
        const batchAssignments = assignAllBatchesWithWindows(ns, sortedBatches, workers, maxAmountBatch, "round");
        let batchFailures = await launchMultiBatches(ns, batchAssignments);

        // ---- 6. Reporting
        const { totalMem, freeMem } = getMemoryStatsForHosts(workers);
        const preppingArr = Array.isArray(status.needsRecovery) ? status.needsRecovery : [];
        const moneyNeeded = preppingArr.reduce((a, r) => a + (Number(r.moneyNeeded) || 0), 0);
        const secToReduce = preppingArr.reduce((a, r) => a + (Number(r.secToReduce) || 0), 0);
        const { minBatches, maxBatches, totalBatches } = getBatchWindowStats();
        printWorkerThreadSummary(ns, workers);
        ns.print(buildStatusString({
            moneyHosts,
            batchData: { sortedBatches, maxAmountBatch, totalBatchesMem, minBatchesMem, hackFraction },
            preppingArr,
            status,
            moneyNeeded,
            secToReduce,
            workers,
            minBatches,
            maxBatches,
            totalBatches,
            batchAssignments,
            batchFailures,
            totalMem,
            freeMem,
        }));

        if (debug) {
            ns.print(`[SUMMARY] Batch: ${status.ok.length}, Prep: ${status.needsRecovery.length}, Idle: ${moneyHosts.length - status.ok.length - status.needsRecovery.length}`);
        }
        await ns.sleep(BATCH_PAUSE);
        count++;
    }
}

// --- helpers below ---

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
    return true;
}

function parseIntOrDefault(value, def) {
    const n = parseInt(value);
    return isNaN(n) ? def : n;
}

function buildStatusString({
    moneyHosts,
    batchData,
    preppingArr,
    status,
    moneyNeeded,
    secToReduce,
    workers,
    minBatches,
    maxBatches,
    totalBatches,
    batchAssignments,
    batchFailures,
    totalMem,
    freeMem,
}) {
    return [
        `[${(new Date()).toLocaleTimeString()}] Batch Cycle`,
        `Targets: ${moneyHosts.length} | sortedBatches: ${batchData.sortedBatches.length}, first: ${batchData.sortedBatches?.[0]?.target ?? "(no target)"}`,
        `  Ready: ${status.ok.length} | Prepping: ${preppingArr.length}`,
        `  $ Needed: ${shortNum(moneyNeeded)} | Sec to Reduce: ${secToReduce.toFixed(2)}`,
        `Workers: ${workers.length} | Parallel/target: ${batchData.maxAmountBatch} `,
        `[BATCH]T: ${totalBatches} | Min/Max: ${minBatches}/${maxBatches} | ` +
        `CurB: ${batchAssignments.length}, hFract: ${batchData.hackFraction}`,
        `RAM: Used ${(totalMem - freeMem).toFixed(1)} | Free: ${freeMem.toFixed(1)} GB | ${totalMem.toFixed(1)} GB`,
        `. BatchMem: ${batchData.totalBatchesMem.toFixed(1)} GB/MinBatchMem: ${batchData.minBatchesMem.toFixed(1)} GB` +
        (batchFailures > 0 ? ` | ⚠️ Skipped: ${batchFailures}` : "")
    ].join('\n');
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
function getMemoryStatsForHosts(hosts) {
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
function getBatchPlan(
    ns,
    servers,
    hackFraction = 0.1,
    maxMoneFraction = 0.7,
    hackScript,
    growScript,
    weakenScript,
    maxCores = 3,
    isFormulaAvailable
) {
    const player = ns.getPlayer();
    const result = {};
    const hackRam = ns.getScriptRam(hackScript);
    const growRam = ns.getScriptRam(growScript);
    const weakenRam = ns.getScriptRam(weakenScript);
  
    for (const hostname of servers) {    
        const server = ns.getServer(hostname);
        const idealServer = {
            ...ns.getServer(hostname),
            moneyAvailable: ns.getServerMaxMoney(hostname),
            hackDifficulty: ns.getServerMinSecurityLevel(hostname)
        };
        const maxMoney = server.moneyMax;
        const curMoney = Math.max(server.moneyAvailable, 1);
        const parallelBatches = batchWindows[hostname]?.length ?? 1;

        // --- HACK calculations
        let hackChance, hackPercent, hackTime, growTime, weakenTime;
        if (isFormulaAvailable && ns.formulas && ns.formulas.hacking) {
            hackChance = ns.formulas.hacking.hackChance(idealServer, player);
            hackPercent = ns.formulas.hacking.hackPercent(idealServer, player);
            hackTime = ns.formulas.hacking.hackTime(idealServer, player);
            growTime = ns.formulas.hacking.growTime(idealServer, player);
            weakenTime = ns.formulas.hacking.weakenTime(idealServer, player);
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

        
        // Landings all relative to batch end (weakens finish together)
        const batchEnd = weakenTime; // when the weakens should finish

        // Hack should finish right before weakenH
        const hackLanding    = batchEnd - GAP_WEAKEN_H;
        const weakenHLanding = batchEnd;
        const growLanding    = batchEnd + GAP_GROW;
        const weakenGLanding = growLanding + GAP_WEAKEN_G;

        // Launch offsets relative to 'now'
        const hackOffset    = hackLanding    - hackTime;
        const weakenHOffset = weakenHLanding - weakenTime;
        const growOffset    = growLanding    - growTime;
        const weakenGOffset = weakenGLanding - weakenTime;
                
        const GROW_MULTIPLIER = Math.max(1, parallelBatches * GROW_THREADS_COMP_MULT)
        const WEAKEN_MULTIPLIER = Math.max(1, parallelBatches * WEAKEN_THREADS_COMP_MULT)

        // Precompute grow/weaken matrices
        const batchMatrix = [];
        for (let growCores = 1; growCores <= maxCores; ++growCores) {
            batchMatrix[growCores - 1] = [];
            let growThreads;
            if (isFormulaAvailable) {
                growThreads = Math.ceil(ns.formulas.hacking.growThreads(
                    { ...idealServer, moneyAvailable: postHackMoney }, player, batchMoney, growCores
                ) * GROW_MULTIPLIER);
            } else {                
                growThreads = Math.ceil(ns.growthAnalyze(hostname, batchMoney / Math.max(1, postHackMoney), growCores) * GROW_MULTIPLIER);
            }
            const secIncGrow = ns.growthAnalyzeSecurity(growThreads, hostname, growCores);
            for (let weakenCores = 1; weakenCores <= maxCores; ++weakenCores) {
                const weakenPerThread = ns.weakenAnalyze(1, weakenCores);
                //hack add additional weaken
                const weakenAfterGrow = Math.ceil((secIncGrow / weakenPerThread)*WEAKEN_MULTIPLIER);

                // For hack/weaken after hack, just use 1 core (you could expand for hack/weaken cores too if needed)
                const weakenThreadsAfterHack = Math.ceil((secIncreaseHack / weakenPerThread)*WEAKEN_MULTIPLIER);
                // RAM for this combo (add hack/weaken-after-hack RAM as they don't depend on cores)
                const batchRam = (
                    hackThreads * hackRam +
                    growThreads * growRam +
                    weakenThreadsAfterHack * weakenRam + // hack weaken
                    weakenAfterGrow * weakenRam           // grow weaken
                );
                const totalThreads = hackThreads + growThreads + weakenThreadsAfterHack + weakenAfterGrow;
                const batchProfit = hackAmount * hackChance;
                const profitPerGbPerSec = batchProfit / (batchRam * (weakenTime / 1000));
                batchMatrix[growCores - 1][weakenCores - 1] = {
                    growCores,
                    weakenCores,
                    growThreads,
                    weakenAfterGrow,
                    batchRam,
                    totalThreads,
                    batchProfit,
                    profitPerGbPerSec,
                    // PHASE OFFSETS for this batch (for use in assignment)
                    hackOffset,
                    growOffset,
                    weakenHOffset,
                    weakenGOffset,
                    weakenThreadsAfterHack
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
            weakenThreadsAfterHack: batchMatrix[0][0].weakenThreadsAfterHack,
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
async function launchMultiBatches(ns, batchAssignments) {
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
async function prepServersStep(
    ns,
    servers,
    targets,
    moneyTargetFrac = 0.9,
    secBuffer = 0.5,
    maxGrowCores = 1,
    isFormulaAvailable
) {
    const growScript = "worker-grow.js";
    const weakenScript = "worker-weaken.js";
    const growRam = ns.getScriptRam(growScript);
    const weakenRam = ns.getScriptRam(weakenScript);
    const availableWorkers = getUsableHosts(ns, servers);
    const now = Date.now();

    cleanupPrepInFlight(now); // Clean up old entries

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
    let prepping = statuses.filter(s => (!s.moneyOk || s.secHigh ) && shouldPrepHost(s));
    let workersState = availableWorkers.map(w => ({ ...w }));
    
    for (const stat of prepping) {
        // WEAKEN needed
        if (stat.secHigh) {
            let server = ns.getServer(stat.host);
            let player = ns.getPlayer();
            let weakenThreadsNeeded = Math.ceil(stat.secToReduce / ns.weakenAnalyze(1, 1));
            let runningWeaken = countActiveThreads(ns, servers, weakenScript, stat.host);
            let inflightWeaken = getInFlightPrepThreads(stat.host, "weaken", now);
            let weakenThreadsLeft = Math.max(0, weakenThreadsNeeded - runningWeaken - inflightWeaken);

            for (let wi = 0; wi < workersState.length; ++wi) {
                const w = workersState[wi];
                const assign = Math.min(weakenThreadsLeft, Math.floor(w.availableMem / weakenRam));
                if (assign > 0) {
                    const pid = ns.exec(weakenScript, w.host, assign, stat.host, assign);
                    if (pid === 0) continue;
                    w.availableMem -= assign * weakenRam;
                    workersState[wi].availableMem = w.availableMem;
                    weakenThreadsLeft -= assign;
                    let weakenTime = 0
                     if (isFormulaAvailable) {
                        weakenTime = ns.formulas.hacking.weakenTime(server, player);
                    } else {
                        weakenTime = ns.getWeakenTime(stat.host);
                    }
                    addPrepJob(stat.host, "weaken", assign, now + weakenTime)
                }
                if (weakenThreadsLeft <= 0) break;
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
            let inflightGrow = getInFlightPrepThreads(stat.host, "grow", now);
            let growThreadsLeft = Math.max(0, growThreadsTotal - runningGrow - inflightGrow);

            for (const w of sorted) {
                if (growThreadsLeft <= 0) break;
                const assign = Math.min(growThreadsLeft, Math.floor(w.availableMem / growRam));
                if (assign > 0) {
                    const pid = ns.exec(growScript, w.host, assign, stat.host, assign);
                    if (pid === 0) continue;
                    w.availableMem -= assign * growRam;
                    workersState[w.i].availableMem = w.availableMem;
                    growThreadsLeft -= assign;
                    let growTime = 0;
                    if (isFormulaAvailable) {
                        growTime = ns.formulas.hacking.growTime(server, player);
                    } else {
                        growTime = ns.getGrowTime(stat.host);
                    }
                    addPrepJob(stat.host, "grow", assign, now + growTime)
                }
            }             
        }       
    }
    printPrepInFlightSummary(ns)
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
    return Math.min(Math.floor(totalAvailableMem / batchRam), Math.floor(BATCH_PAUSE/BATCH_WINDOW_MS));
}

/**
 * Returns the top N servers by potential max profit per thread per second.
 * @param {NS} ns - Bitburner Netscript context (pass 'ns' in scripts)
 * @param {Array} servers - Array of server names (string) or server objects with at least 'name'
 * @param {number} topN - How many servers to return
 * @returns {Array} Sorted array of server info with calculated profit per thread per second
 */
export function getTopProfitServers(ns, servers, topN, isFormulaAvailable) {
  const player = ns.getPlayer()
    // Helper to get info if only name is provided
    function getInfo(server) {
        const hostname = server.hostname || server.name || server; 
        if (isFormulaAvailable) {
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

function getBatchWindowStats() {
    const batchCounts = Object.values(batchWindows).map(arr => arr.length);
    return {
        minBatches: batchCounts.length > 0 ? Math.min(...batchCounts) : 0,
        maxBatches: batchCounts.length > 0 ? Math.max(...batchCounts) : 0,
        totalBatches: batchCounts.reduce((a, b) => a + b, 0),
    };
}


/**
 * Attempts to assign as many batches as possible per target, honoring window, RAM, and cores.
 * Returns an array of assignments, suitable for launchMultiBatches.
 *
 * @param {NS} ns
 * @param {object} batches - sorted by profit {Array<{target: string, batch: Object, profitPerGbPerSec: number, weakenTime: number}>}
 * @param {Array} workers - worker states [{host, availableMem, cores, ...}]
 * @param {number} maxBatchesPerTarget
 * @returns {Array} batchAssignments [{server, batchNum, assignments, offsets}]
 */
function assignAllBatchesWithWindows(ns, batches, workers, maxBatchesPerTarget, mode = "fill") {
    const now = Date.now();
    pruneOldBatches(now);

    const batchAssignments = [];
    const perTargetBatchCount = {};
    for (const {target} of batches) perTargetBatchCount[target] = 0;
    
    if (mode === "fill") {
        for (const {target, batch} of batches) {
            
            const batchTemplate = batch;
            let batchNum = 0;
                
            const maxTotalBatches = Math.floor(batchTemplate.weakenTime / BATCH_WINDOW_MS);

            let batchDuration = batchTemplate.weakenTime; // ms
        
            if ((batchWindows[target]?.length || 0) >= maxTotalBatches) {
                continue;
            } 
            const max_batches = Math.min(MAX_TOTAL_BATCHES - (batchWindows[target]?.length || 0), maxTotalBatches - (batchWindows[target]?.length || 0), maxBatchesPerTarget, Math.floor(batchDuration / BASE_OFFSET));        
        
            // Try from highest to lowest cores, to maximize batch quality
            const growCoreMax = batchTemplate.batchMatrix.length;
            
            for (let cores = growCoreMax; cores >= 1; cores--) {                
                    let scheduledBatches = 0;
                    while (scheduledBatches < max_batches) {
                        let extraOffset = 0, tries = 0, scheduled = false;
                        // Pick stats for this (growCores, weakenCores)
                        let stats = batchTemplate.batchMatrix[cores - 1][cores - 1]; // square fallback
                        if (!stats) break; // if no such entry

                        while (tries < OFFEST_MAX_TRIES && !scheduled) {
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
                                    ns, batchTemplate, workers, stats,
                                    hackOffset, growOffset, weakenHOffset, weakenGOffset
                                );
                                if (canAssign) {                            
                                    batchAssignments.push({
                                        server: target,
                                        batchNum,
                                        assignments,
                                        offsets: { hackOffset, growOffset, weakenHOffset, weakenGOffset }
                                    });
                                    recordBatch(target, landings);
                                    scheduled = true;
                                    break;
                                } else {
                                    if(debug) {
                                        ns.print(`${target}can not assign batch with offset : ${extraOffset}`)
                                    }
                                }

                            } else {
                                    if(debug) {
                                        ns.print(`${target}can not schedule batch with landing : ${JSON.stringify(landings)}`)
                                    }
                            }
                            // Slide forward in time
                            extraOffset += BATCH_WINDOW_MS;
                            tries++;        
                        }            
                        if (!scheduled) {                    
                            break; // Can't schedule more with this core count
                        } 
                        batchNum++;
                        scheduledBatches++;
                }            
            }        
        }
        return batchAssignments;
    }

    
     // ROUND ROBIN MODE
    // Step 1: Prepare each target's max_batches as before
    const targetBatchLimits = {};

    let totalRunning = 0;
    let totalAllowed = 0;
    let totalTargets = batches.length;
    let hittingCap = 0;
    let windowLimits = [];
    let offsetLimits = [];
    let hardCaps = [];


    for (const { target, batch } of batches) {
        const batchTemplate = batch;
        const maxTotalBatches = Math.floor(batchTemplate.weakenTime / BATCH_WINDOW_MS);
        targetBatchLimits[target] = Math.min(
            MAX_TOTAL_BATCHES - (batchWindows[target]?.length || 0),
            maxTotalBatches - (batchWindows[target]?.length || 0),
            //maxBatchesPerTarget,
            Math.floor(batchTemplate.weakenTime / BASE_OFFSET) - (batchWindows[target]?.length || 0)
        );

        const running = batchWindows[target]?.length || 0;
        const windowLimit = Math.floor(batch.weakenTime / BATCH_WINDOW_MS);
        const offsetLimit = Math.floor(batch.weakenTime / BASE_OFFSET);
        const hardCap = MAX_TOTAL_BATCHES - running;

        const allowed = Math.min(windowLimit, offsetLimit, hardCap);

        windowLimits.push(windowLimit);
        offsetLimits.push(offsetLimit);
        hardCaps.push(hardCap);

        totalRunning += running;
        totalAllowed += allowed;
        if (allowed < windowLimit) hittingCap++;
    }
    // Aggregate stats
    const avgWindow = (windowLimits.reduce((a, b) => a + b, 0) / windowLimits.length).toFixed(1);
    const maxWindow = Math.max(...windowLimits);
    const capAlert = hittingCap > 0 ? `| ⚠️ ${hittingCap}/${totalTargets} at hard cap!` : '';

    if (hittingCap > Math.max(totalTargets - 1 , 1)) {
        ns.print(
            `[BATCHES] Running: ${totalRunning} | Allowed: ${totalAllowed} | WindowAvg: ${avgWindow} | WindowMax: ${maxWindow} | Targets: ${totalTargets} ${capAlert}`
        );
    }
    // Step 2: Loop round-robin until no more can be scheduled
    let madeAssignment = true;
    let batchNums = {}; // Track per-target batchNum for offset
    for (const {target} of batches) batchNums[target] = 0;

    while (madeAssignment) {
        madeAssignment = false;

        for (const {target, batch} of batches) {
            if (perTargetBatchCount[target] >= targetBatchLimits[target]) {
                continue;
            }

            const batchTemplate = batch;
            const batchNum = batchNums[target];
            const growCoreMax = batchTemplate.batchMatrix.length;

            let scheduled = false;

            for (let cores = growCoreMax; cores >= 1 && !scheduled; cores--) {
                    let stats = batchTemplate.batchMatrix[cores - 1][cores - 1];
                    if (!stats) continue;
                    let tries = 0, extraOffset = 0;
                    while (tries < OFFEST_MAX_TRIES && !scheduled) {
                        // Offsets and landings as before
                        const hackOffset = stats.hackOffset + batchNum * BASE_OFFSET + extraOffset;
                        const growOffset = stats.growOffset + batchNum * BASE_OFFSET + extraOffset;
                        const weakenHOffset = stats.weakenHOffset + batchNum * BASE_OFFSET + extraOffset;
                        const weakenGOffset = stats.weakenGOffset + batchNum * BASE_OFFSET + extraOffset;
                        const hackLand    = now + hackOffset    + batchTemplate.hackTime;
                        const growLand    = now + growOffset    + batchTemplate.growTime;
                        const weakenHLand = now + weakenHOffset + batchTemplate.weakenTime;
                        const weakenGLand = now + weakenGOffset + batchTemplate.weakenTime;
                        const landings = { hack: hackLand, grow: growLand, weakenH: weakenHLand, weakenG: weakenGLand };

                        if (canScheduleBatch(target, landings)) {
                            const { assignments, canAssign } = tryAssignBatchWithOffsets(
                                ns, batchTemplate, workers, stats,
                                hackOffset, growOffset, weakenHOffset, weakenGOffset
                            );
                            if (canAssign) {
                                batchAssignments.push({
                                    server: target,
                                    batchNum,
                                    assignments,
                                    offsets: { hackOffset, growOffset, weakenHOffset, weakenGOffset }
                                });
                                recordBatch(target, landings);
                                perTargetBatchCount[target]++;
                                batchNums[target]++;
                                madeAssignment = true;
                                scheduled = true;
                                break;
                            } else {
                                if(debug) {
                                    const weakenScript = ns.getScriptRam("worker-weaken.js")
                                    if (cores == 1 && stats.batchRam < 1.1*workers.map(w => w.availableMem).filter(m => m >= weakenScript).reduce((a, b) => a + b, 0)) {
                                        ns.tprint(`workers: ${JSON.stringify(workers)}`)
                                        ns.tprint(`can not assign stats: ${JSON.stringify(stats)}`)
                                    }
                                }
                            }
                        }
                        extraOffset += BATCH_WINDOW_MS;
                        tries++;
                }
            }
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
        return {assignments, canAssign}      
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
        return {assignments, canAssign}      
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
        return {assignments, canAssign}             
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

function isFormulaAvailable(ns) {
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

function addPrepJob(host, type, threads, landing) {
    if (!prepInFlightMap[host]) prepInFlightMap[host] = {};
    if (!prepInFlightMap[host][type]) prepInFlightMap[host][type] = [];
    prepInFlightMap[host][type].push({ threads, landing });
}

function cleanupPrepInFlight(now = Date.now()) {
    for (const host in prepInFlightMap) {
        for (const type in prepInFlightMap[host]) {
            // Remove old jobs in place
            prepInFlightMap[host][type] = prepInFlightMap[host][type].filter(job => job.landing >= now);
            // Clean up empty arrays
            if (prepInFlightMap[host][type].length === 0) {
                delete prepInFlightMap[host][type];
            }
        }
        // Remove host if empty
        if (Object.keys(prepInFlightMap[host]).length === 0) {
            delete prepInFlightMap[host];
        }
    }
}

function getInFlightPrepThreads(host, type, now = Date.now()) {
    if (!prepInFlightMap[host] || !prepInFlightMap[host][type]) return 0;
    return prepInFlightMap[host][type]
        .filter(job => job.landing > now)
        .reduce((sum, job) => sum + job.threads, 0);
}

function shouldPrepHost(host) {
    // If batchWindows has no entry or the entry array is empty, host is not in use for batching
    return !(batchWindows[host] && batchWindows[host].length > 0);
}

/**
 * Returns a sorted & limited array of batches, auto-limited by RAM.
 * 
 * @param {Object} batches - mapping of target => batchPlan
 * @param {Array} workers - list of all worker servers [{host, availableMem, ...}]
 * @param {number} maxBatchesPerTarget - planned parallel batches per target
 * @returns {Array<{target: string, batch: Object, profitPerGbPerSec: number, weakenTime: number}>}
 */
function getSortedLimitedBatchArrayDynamic(batches, workers, maxBatchesPerTarget, isRamLimit = false) {
    // Compute total available RAM across all workers
    const totalAvailableRam = workers.reduce((sum, w) => sum + (w.availableMem || 0), 0);

    // Build batch meta
    const meta = Object.entries(batches).map(([target, batch]) => {
        const maxCore = batch.batchMatrix.length - 1;
        const stats = batch.batchMatrix[maxCore][maxCore];
        // RAM needed for a single batch (take lowest found, for safety)
        const batchRam = stats ? stats.batchRam : Infinity;
        return {
            target,
            batch,
            profitPerGbPerSec: stats ? stats.profitPerGbPerSec : 0,
            weakenTime: batch.weakenTime,
            batchRam
        };
    }).filter(t =>
        t.profitPerGbPerSec > 0 &&
        t.weakenTime < MAX_BATCH_TIME &&
        isFinite(t.batchRam) && t.batchRam > 0
    );
    
    // Sort by profit
    meta.sort((a, b) => b.profitPerGbPerSec - a.profitPerGbPerSec);
    if(!isRamLimit) return meta;
    // Now, dynamically limit the number of targets
    let runningRam = 0;
    const limited = [];
    for (const entry of meta) {
        // If we include this target, how much RAM will we need for max batches?
        const needRam = entry.batchRam * maxBatchesPerTarget;
        if (runningRam + needRam > totalAvailableRam) {
            limited.push(entry); // let's add one more
            break; // No more room!
        }
        limited.push(entry);
        runningRam += needRam;
    }
    return limited;
}


function printPrepInFlightSummary(ns) {
    let totalGrow = 0, totalWeaken = 0;
    for (const host in prepInFlightMap) {
        if (prepInFlightMap[host].grow) {
            totalGrow += prepInFlightMap[host].grow.reduce((a, b) => a + b.threads, 0);
        }
        if (prepInFlightMap[host].weaken) {
            totalWeaken += prepInFlightMap[host].weaken.reduce((a, b) => a + b.threads, 0);
        }
    }
    const total = totalGrow + totalWeaken;
    ns.print(`Prep in-flight total: ${total} | G:${totalGrow} | W:${totalWeaken}`);
}

function printWorkerThreadSummary(ns, workers) {
    let realTotal = 0;
    let gTotal = 0;
    let wTotal = 0;
    let hTotal = 0;

    for (const w of workers) {
        for (const proc of ns.ps(w.host)) {
            if (!proc.filename.startsWith('worker-')) continue;

            realTotal += proc.threads;

            if (proc.filename === 'worker-grow.js') gTotal += proc.threads;
            else if (proc.filename === 'worker-weaken.js') wTotal += proc.threads;
            else if (proc.filename === 'worker-hack.js') hTotal += proc.threads;
        }
    }

    ns.print(`Real total: ${realTotal} | G: ${gTotal} | W: ${wTotal} | H: ${hTotal}`);
}

/**
 * Copies specified script(s) to all eligible servers (skips 'home').
 * Only copies if host is new since last copy, or always if you want to keep up to date.
 * 
 * @param {NS} ns
 * @param {Array<string>} scripts - e.g. ["worker-hack.js", "worker-grow.js", "worker-weaken.js"]
 * @param {Array<string>} servers - hostnames to copy to
 * @param {Array<string>} [skipHosts] - hosts to skip (e.g. ["home"])
 */
export async function copyScriptsToHosts(ns, scripts, servers, skipHosts = ["home"]) {
    for (const hostname of servers) {
        if (skipHosts.includes(hostname)) continue;
        ns.scp(scripts, hostname);        
    }
}


let lastAutoTuneSummary = '';
/**
 * Auto-tune GROW/WEAKEN multipliers based on global thread prep stats
 * Call from your main loop
 */
function autoTuneMultipliers(ns) {
    // Gather stats as before ...
    let growPrep = 0, weakenPrep = 0;
    let gRunning = 0, wRunning = 0;
    const workers = getUsableHosts(ns, scanAllServers(ns));
    for (const host in prepInFlightMap) {
        if (prepInFlightMap[host].grow)
            growPrep += prepInFlightMap[host].grow.reduce((a, b) => a + b.threads, 0);
        if (prepInFlightMap[host].weaken)
            weakenPrep += prepInFlightMap[host].weaken.reduce((a, b) => a + b.threads, 0);
    }
    for (const w of workers) {
        for (const proc of ns.ps(w.host)) {
            if (proc.filename === 'worker-grow.js') gRunning += proc.threads;
            else if (proc.filename === 'worker-weaken.js') wRunning += proc.threads;
        }
    }
    // Compute prep percentages
    function percent(prep, run) {
        const total = run;
        if (total === 0) return 0;
        return 100 * prep / total;
    }
    const growPrepPct = percent(growPrep, gRunning);
    const weakenPrepPct = percent(weakenPrep, wRunning);

    // --- Store in rolling history ---
    growPrepPctHistory.push(growPrepPct);
    weakenPrepPctHistory.push(weakenPrepPct);
    if (growPrepPctHistory.length > PREP_HISTORY_WINDOW) growPrepPctHistory.shift();
    if (weakenPrepPctHistory.length > PREP_HISTORY_WINDOW) weakenPrepPctHistory.shift();

    // --- Assess stability/volatility ---
    function stddev(arr) {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length || 0;
        return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length || 0);
    }
    const growStd = stddev(growPrepPctHistory);
    const weakenStd = stddev(weakenPrepPctHistory);
    const growMean = growPrepPctHistory.reduce((a, b) => a + b, 0) / growPrepPctHistory.length || 0;
    const weakenMean = weakenPrepPctHistory.reduce((a, b) => a + b, 0) / weakenPrepPctHistory.length || 0;

    // --- Adjust frequency and amplitude ---
    // "Noisy" means either high variance or far from target
    function farFromTarget(mean) {
        return Math.abs(mean - TARGET_PREP_PCT) > 10;
    }
    function isNoisy(std) {
        return std > 4; // More than 4% stddev in history
    }

    // Set step and period for grow
    if (farFromTarget(growMean) || isNoisy(growStd)) {
        growStep = 0.02; // ±2%
        autoTunePeriod = MULTI_ADJUST_NOISE_PERIOD; // 1 min
    } else {
        growStep = 0.01; // ±1%
        autoTunePeriod = MULTI_ADJUST_CALM_PERIOD; // 3 min
    }
    // Same for weaken
    if (farFromTarget(weakenMean) || isNoisy(weakenStd)) {
        weakenStep = 0.04; //less threads more need for adjustments
        autoTunePeriod = Math.min(autoTunePeriod, MULTI_ADJUST_NOISE_PERIOD);
    } else {
        weakenStep = 0.01;
        autoTunePeriod = Math.min(autoTunePeriod, MULTI_ADJUST_CALM_PERIOD);
    }

    // --- Actually tune multipliers ---
    const now = Date.now();
    if (now - lastTuneTime < autoTunePeriod) {
        lastAutoTuneSummary =
          `[AutoTune](${Math.round((autoTunePeriod - (now - lastTuneTime))/1000)}s/${autoTunePeriod/1000}s) `
          + `GPrep:${growMean.toFixed(2)}(${growPrepPct.toFixed(1)}%) WPrep:${weakenMean.toFixed(2)}(${weakenPrepPct.toFixed(1)}%)\n`
          + `GrowMult:${GROW_THREADS_COMP_MULT.toFixed(2)} WeakenMult:${WEAKEN_THREADS_COMP_MULT.toFixed(2)} | `
          + `GStep:${growStep*100}% WStep:${weakenStep*100}%`;
        return;
    }
    lastTuneTime = now;

    // Grow adjustment
    // Use mean for regular tuning:
    if (growMean > TARGET_PREP_PCT) {
        GROW_THREADS_COMP_MULT *= 1 + growStep;
    } else if (growMean < INCREASE_IF_BELOW) {
        GROW_THREADS_COMP_MULT *= 1 - growStep;
    }
    // "Emergency" tuning if there's a huge spike
    if (growPrepPct > TARGET_PREP_PCT * 2) {
        GROW_THREADS_COMP_MULT *= 1.14; // Fast bump
    }
    GROW_THREADS_COMP_MULT = Math.max(0.2, Math.min(GROW_THREADS_COMP_MULT, 3.0));

    // Weaken adjustment
    if (weakenMean > TARGET_PREP_PCT) {
        WEAKEN_THREADS_COMP_MULT *= 1 + weakenStep;
    } else if (weakenMean < INCREASE_IF_BELOW) {
        WEAKEN_THREADS_COMP_MULT *= 1 - weakenStep;
    }
     // "Emergency" tuning if there's a huge spike
    if (weakenPrepPct > TARGET_PREP_PCT * 2) {
        WEAKEN_THREADS_COMP_MULT *= 1.14; // Fast bump
    }
    WEAKEN_THREADS_COMP_MULT = Math.max(0.5, Math.min(WEAKEN_THREADS_COMP_MULT, 6.0));

    lastAutoTuneSummary =
      `[AutoTune](${Math.round(autoTunePeriod/1000)}s) GPrep:${growPrep} (${growPrepPct.toFixed(1)}%) WPrep:${weakenPrep} (${weakenPrepPct.toFixed(1)}%)\n`
      + `GMean:${growMean.toFixed(1)} GStd:${growStd.toFixed(2)} GStep:${(growStep*100).toFixed(1)}%\n`
      + `WMean:${weakenMean.toFixed(1)} WStd:${weakenStd.toFixed(2)} WStep:${(weakenStep*100).toFixed(1)}%\n`
      + `GrowMult:${GROW_THREADS_COMP_MULT.toFixed(2)} WeakenMult:${WEAKEN_THREADS_COMP_MULT.toFixed(2)} `;
}
