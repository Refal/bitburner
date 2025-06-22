/** @param {NS} ns 
* will buy you own servers on all money, except some reservers
*/
export async function main(ns) {
  const minRam = 4;  // Minimum RAM per server in GB
  const reserveMoney = !isNaN(ns.args[0]) ? parseInt(ns.args[0]) : 1_800_000_000;
  let money = ns.getServerMoneyAvailable("home");

  const limit = ns.getPurchasedServerLimit();
  const servers = ns.getPurchasedServers();
  const maxRam = ns.getPurchasedServerMaxRam();

  // --- Upgrade existing servers ---
  for (const server of servers) {
    let currentRam = ns.getServerMaxRam(server);
    let targetRam = currentRam;

    while (targetRam < maxRam) {
      const nextRam = targetRam * 2;
      const upgradeCost = ns.getPurchasedServerUpgradeCost(server, nextRam);

      if (upgradeCost === Infinity || upgradeCost + reserveMoney > money) break;

      const success = ns.upgradePurchasedServer(server, nextRam);
      if (success) {
        money -= upgradeCost;
        targetRam = nextRam;
        ns.tprintf("⬆️ Upgraded %s to %d GB, spent: %d", server, targetRam, upgradeCost);
      } else {
        break;
      }
    }
  }

  // --- Purchase new servers ---
  const slotsLeft = limit - servers.length;
  for (let i = 0; i < slotsLeft; i++) {
    let ram = minRam;

    while (ram <= maxRam) {
      const cost = ns.getPurchasedServerCost(ram);
      if (cost + reserveMoney > money) break;
      ram *= 2;
    }

    ram = ram / 2;
    if (ram < minRam) break;

    const cost = ns.getPurchasedServerCost(ram);
    const hostname = ns.purchaseServer(`myserver${servers.length + i}`, ram);
    if (hostname) {
      money -= cost;
      ns.tprintf("🆕 Bought %s with %d GB, spent: %d", hostname, ram, cost);
    } else {
      break;
    }
  }
}
