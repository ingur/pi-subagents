import { execFileSync } from "node:child_process";

const columns = ["pid", "ppid", "pgid", "stat", "lstart"].flatMap(name => ["-o", `${name}=`]);
const startPattern = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;

export function parseProcessTable(output) {
  const rows = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // No command column: the first four fields are fixed, and lstart owns the rest.
    const fields = line.trim().split(/\s+/);
    const [pid, parent, group] = fields.slice(0, 3).map(Number);
    const state = fields[3]?.[0], start = fields.slice(4).join(" ");
    if (fields.length !== 9 || !fields.slice(0, 3).every(value => /^\d+$/.test(value)) ||
        ![pid, parent, group].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !/^[IRSTUZX]$/.test(state) || !startPattern.test(start) || rows.has(pid)) {
      throw new Error("Invalid macOS ps process row");
    }
    rows.set(pid, { pid, parent, group, state, start });
  }
  return rows;
}

export function parseBootIdentity(output) {
  const value = output.trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid macOS kern.bootsessionuuid");
  return value.toLowerCase();
}

function command(path, args) {
  // Synchronous callers pay a subprocess cost; monitors share one ps snapshot per tick.
  try {
    return execFileSync(path, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
      timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // An unavailable observer is not an absent process.
    if (error.code === "ENOENT") throw new Error(`Unable to execute ${path} for macOS process tracking`, { cause: error });
    throw error;
  }
}

let boot;
export function bootIdentity() {
  // A running Node process cannot survive a reboot; cache only a successful observation.
  return boot ??= parseBootIdentity(command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]));
}

export function processTable() {
  const rows = parseProcessTable(command("/bin/ps", ["-ax", ...columns]));
  if (!rows.has(process.pid)) throw new Error("Incomplete macOS process table");
  return rows;
}

export function processRow(pid, snapshot) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process PID");
  let rows = snapshot;
  if (!rows) {
    let output;
    try { output = command("/bin/ps", [...columns, "-p", String(pid)]); }
    catch (error) {
      // ps exits 1 when no selected process exists; other failures are unknown, not death.
      if (error.status !== 1 || String(error.stdout ?? "").trim() || String(error.stderr ?? "").trim()) throw error;
      output = "";
    }
    rows = parseProcessTable(output);
  }
  const row = rows.get(pid);
  if (!row) throw Object.assign(new Error(`Process ${pid} does not exist`), { code: "ENOENT" });
  return row;
}
