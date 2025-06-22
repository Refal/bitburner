/** @param {NS} ns 
* help with tracking hack/grow/weaken progress
**/
export async function main(ns) {
    ns.ui.openTail();
    ns.clearLog();
    ns.disableLog('ALL');
    const maxDepth = ns.args[0] ? parseInt(ns.args[0]) : 20;

    function scanServers(depthLimit) {
        const visited = new Set(['home']);
        const queue = [{ server: 'home', depth: 0 }];
        const result = [];
        while (queue.length) {
            const { server, depth } = queue.shift();
            result.push(server);
            if (depth >= depthLimit) continue;
            for (const neighbor of ns.scan(server)) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push({ server: neighbor, depth: depth + 1 });
                }
            }
        }
        return result;
    }

    while (true) {
        ns.clearLog();
        let totalRam = 0;
        let totalFreeRam = 0;
        const statsTable = [];
        const offsets = []; // <--- collect offsets for dynamic bucketizing
        const procs = [];

        for (const srv of scanServers(maxDepth)) {
            const maxRam = ns.getServerMaxRam(srv);
            const usedRam = ns.getServerUsedRam(srv);
            const freeRam = Math.max(0, maxRam - usedRam);
            totalRam += maxRam;
            totalFreeRam += freeRam;

            for (const proc of ns.ps(srv)) {
                const fn = proc.filename;
                const target = (typeof proc.args[0] === "string" && proc.args[0].trim() !== "") ? proc.args[0] : null;
                if (!target) continue;
                // Note: offset is in ms, convert to s for display
                const offset = Number(proc.args[2] ?? 0) / 1000;
                offsets.push(offset);
                procs.push({ srv, proc, fn, target, offset });
            }
        }

        // Compute dynamic thresholds
        let t1 = 0, t2 = 0;
        if (offsets.length > 0) {
            offsets.sort((a, b) => a - b);
            const n = offsets.length;
            const idx1 = Math.floor(n / 3);
            const idx2 = Math.floor((2 * n) / 3);
            t1 = offsets[idx1];
            t2 = offsets[idx2];
        }

        // Build statsTable with dynamic buckets
        for (const {fn, target, proc, offset} of procs) {
            let cat;
            if (offset <= t1) cat = 'low';
            else if (offset <= t2) cat = 'mid';
            else cat = 'high';

            let row = statsTable.find(x => x.script === fn && x.target === target);
            if (!row) {
                row = {
                    script: fn,
                    target,
                    low_count: 0,
                    low_threads: 0,
                    mid_count: 0,
                    mid_threads: 0,
                    high_count: 0,
                    high_threads: 0
                };
                statsTable.push(row);
            }
            row[`${cat}_count`]++;
            row[`${cat}_threads`] += proc.threads;
        }

        // Sort and print
        statsTable.sort((a, b) => {
            if (a.target < b.target) return -1;
            if (a.target > b.target) return 1;
            if (a.script < b.script) return -1;
            if (a.script > b.script) return 1;
            return 0;
        });

        ns.print('Offset Categories [count(thread)]');
        const header = `| Script               | Target             |   Low        |   Mid        |   High       |`;
        ns.print(header);
        ns.print('-'.repeat(header.length));
        for (const d of statsTable) {
            const low   = `${d.low_count}(${d.low_threads})`.padStart(12);
            const mid   = `${d.mid_count}(${d.mid_threads})`.padStart(12);
            const high  = `${d.high_count}(${d.high_threads})`.padStart(12);
            ns.print(`| ${d.script.padEnd(20)} | ${d.target.padEnd(17)} | ${low} | ${mid} | ${high} |`);
        }
        ns.print(`Dynamic Buckets: low ≤ ${t1.toFixed(1)}s, mid ≤ ${t2.toFixed(1)}s, high > ${t2.toFixed(1)}s`);
        ns.print(`Total RAM: ${ns.formatRam(totalRam, 1)}   Free RAM: ${ns.formatRam(totalFreeRam, 1)}`);
        await ns.sleep(10000);
    }
}
