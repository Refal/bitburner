/** @param {NS} ns */
export async function main(ns) {
  ns.killall()
  //just pring available servers for hacking
  //todo uncomment after purchasing formula.exe
  //ns.run("target_analyzer.js",1, 20)
  //share trading did not spent time to improve for publish
 // ns.run("long-short-trader-ui.js", 1, 1e12)
   //1,  money that need to be keepd - update myserver fleet
  ns.run("share_manage.js", 1, 1e12)
  
 // 1, depth, share.js ratio(0-10), top target
  //ns.run("distribute-balancer.js", 1, 20, 0, "priority-scheduler.js",1) //, 15)
  
  ns.run("distribute-balancer.js", 1, 20, 0, "priority-scheduler-improved.js", 1)
  ns.run("hack-stat.js",1, 20)
  //1, money reserv, delay between purch, no money delay
  ns.run("hacknet.js", 1, 1e12, 500, 20_000)  
}
