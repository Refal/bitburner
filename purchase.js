/** @param {NS} ns **/
export async function main(ns) {
    // Scripts to deploy to purchased servers
    const scripts = ["worker-weaken.js", "worker-grow.js", "worker-hack.js"];

    // Helper: Make unique server names
    function makeServerName(idx) { return `myserver${idx}`; }

    // All money reserve rules in this function
    function getReserveMoney(ns) {
        // Before SQLInject.exe, reserve $250m for buying it
        if (!ns.fileExists("SQLInject.exe", "home")) return 250_000_000;
        // Otherwise, no reserve
        return 0;
    }

    // Helper: Do we have Formulas?
    function isFormulaAvailable(ns) {
        try {
            if (ns.formulas && ns.formulas.hacking) {
                ns.formulas.hacking.hackChance(ns.getServer("home"), ns.getPlayer());
                return true;
            }
        } catch (_) {}
        return false;
    }


    // Helper: Do we have Formulas?
    function isStockAvailable(ns) {
        try {
            if (ns.stock && ns.stock.getSymbols()) {
                return true;
            }
        } catch (_) {}
        return false;
    }

    const minRam = 4;
    const limit = ns.getPurchasedServerLimit();
    const maxRam = ns.getPurchasedServerMaxRam();
    let servers = ns.getPurchasedServers();
    let usedNames = new Set(servers);

    // Determine if Formulas.exe and MarketAPI.exe are bought
    const hasFormulas = isFormulaAvailable(ns);
    const hasMarketAPI = isStockAvailable(ns);

    // Reserve money per logic
    let reserveMoney = getReserveMoney(ns);
    let money = ns.getServerMoneyAvailable("home");

    // Main loop: always choose most efficient RAM per $
    let actions = [];

    // 1. Gather possible upgrades
    for (const server of servers) {
        let currentRam = ns.getServerMaxRam(server);
        let nextRam = currentRam * 2;
        if (nextRam > maxRam) continue;
        let cost = ns.getPurchasedServerUpgradeCost(server, nextRam);

        // --- Enforce business logic ---
        if (!ns.fileExists("SQLInject.exe", "home")) {
            // Only upgrade if we keep $250m for SQLInject
            if (2 * cost + reserveMoney > money) continue;
        } else if (!hasFormulas && cost >= 2_000_000_000) {
            // After SQLInject, stop if upgrade cost is >= $2.175b and we don't have formulas
            continue;
        } else if (
            hasFormulas && !hasMarketAPI &&
            cost >= 20_000_000_000
        ) {
            // After formulas, stop at $20b per upgrade if no market API
            continue;
        } else if (2 * cost + reserveMoney > money) {
            continue;
        }
        // -----------------------------

        let gain = nextRam - currentRam;
        let efficiency = gain / cost;
        actions.push({
            type: "upgrade",
            server,
            from: currentRam,
            to: nextRam,
            cost,
            efficiency
        });
    }

    // 2. Gather possible purchases
    if (servers.length < limit) {
        let bestPurchase = null;
        let ram = minRam;
        while (ram <= maxRam) {
            let cost = ns.getPurchasedServerCost(ram);

            // Respect the same logic for purchasing as upgrades
            if (!ns.fileExists("SQLInject.exe", "home")) {
                if (2 * cost + reserveMoney > money) break;
            } else if (!hasFormulas && cost >= 2_175_000_000) {
                break;
            } else if (
                hasFormulas && !hasMarketAPI &&
                cost >= 20_000_000_000
            ) {
                break;
            } else if (2 * cost + reserveMoney > money) {
                break;
            }

            bestPurchase = { ram, cost };
            ram *= 2;
        }
        if (bestPurchase) {
            let efficiency = bestPurchase.ram / bestPurchase.cost;
            actions.push({
                type: "purchase",
                ram: bestPurchase.ram,
                cost: bestPurchase.cost,
                efficiency
            });
        }
    }

    // 3. Pick the most efficient action
    if (actions.length === 0) return;
    actions.sort((a, b) => b.efficiency - a.efficiency);
    const best = actions[0];

    if (best.type === "upgrade") {
        let success = ns.upgradePurchasedServer(best.server, best.to);
        if (success) {
            money -= best.cost;
            ns.printf("⬆️ Upgraded %s from %d to %d GB, spent: %s", best.server, best.from, best.to, ns.formatNumber(best.cost));
        }
    } else if (best.type === "purchase") {
        let idx = 0, name = makeServerName(idx);
        while (usedNames.has(name)) { idx += 1; name = makeServerName(idx); }
        let hostname = ns.purchaseServer(name, best.ram);
        if (hostname) {
            usedNames.add(hostname);
            money -= best.cost;
            ns.printf("🆕 Bought %s with %d GB, spent: %s", hostname, best.ram, ns.formatNumber(best.cost));
            for (const script of scripts) {
                ns.scp(script, hostname);
            }
            servers.push(hostname);
        }
    }
}
