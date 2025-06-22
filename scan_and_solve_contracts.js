/** @param {NS} ns 
* if you tied to solve contracts manually - run it
**/
export async function main(ns) {
    const contractSolverScript = "multi_contract_solver.js";
    const maxDepth = isNaN(ns.args[0]) ? 3 : parseInt(ns.args[0]);

    const visited = new Set();
    const serverMap = {};
    const paths = {};

    function dfs(server, parent, depth) {
        if (visited.has(server) || depth > maxDepth) return;
        visited.add(server);
        serverMap[server] = ns.scan(server);
        paths[server] = parent ? [...paths[parent], server] : [server];

        for (const neighbor of serverMap[server]) {
            dfs(neighbor, server, depth + 1);
        }
    }

    dfs("home", null, 0);

    for (const server of Object.keys(serverMap)) {
        if (!ns.hasRootAccess(server)) continue;

        const files = ns.ls(server, ".cct");
        for (const file of files) {
            const type = ns.codingcontract.getContractType(file, server);
            const path = paths[server].map(s => `connect ${s}`).join("; ");

            ns.tprint(`📄 Contract: [${file}]`);
            ns.tprint(`🌐 Server: ${server} (${type})`);
            ns.tprint(`🔗 Path: ${path}`);
            ns.tprint("──────────────");

            const pid = ns.run(contractSolverScript, 1, file, server);
            if (pid === 0) {
                ns.tprint(`⚠️  Not enough RAM to solve ${file} on ${server}`);
            } else {
                while (ns.isRunning(pid)) {
                    await ns.sleep(100);
                }
            }
        }
    }

    ns.tprint("✅ Finished scanning and solving contracts.");
}
