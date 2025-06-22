/** @param {NS} ns **/
export async function main(ns) {
  const target = ns.args[0];
  const threads = ns.args[1] || ns.getRunningScript().threads;
  const offset = ns.args[2] || 0;

  if (offset > 0) {
    await ns.sleep(offset);
  }
  
  await ns.grow(target, { threads: Number(threads) || 1 });
}
