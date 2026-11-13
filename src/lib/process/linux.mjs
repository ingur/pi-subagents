// Copied from pi-projects core/lib, which no longer has a copy; this one is maintained here.
import { readFileSync, readdirSync } from "node:fs";

export function bootIdentity() {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

// Linux keeps fresh per-pid reads even when a descendant table is supplied.
export function processRow(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pid, parent: Number(fields[1]), group: Number(fields[2]), state: fields[0], start: fields[19] };
}

export function processTable() {
  const rows = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { rows.set(Number(name), processRow(Number(name))); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  return rows;
}
