import * as linux from "./process/linux.mjs";
import * as darwin from "./process/darwin.mjs";

function backend() {
  requireProcessSupport();
  return process.platform === "linux" ? linux : darwin;
}

export function requireProcessSupport() {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error(`Process ownership tracking requires Linux or macOS; unsupported platform: ${process.platform}`);
}

export function bootIdentity() {
  return backend().bootIdentity();
}

// Identity = pid + boot + start (Linux clock ticks, macOS UTC start second).
// shortcut: macOS PID reuse within one second is indistinguishable; stronger identity needs native OS access.
export function processIdentity(pid = process.pid, snapshot) {
  const source = backend();
  const row = source.processRow(pid, snapshot);
  return { pid, start: row.start, boot: source.bootIdentity(), state: row.state };
}
export function ownerState(owner, snapshot) {
  if (!owner || !Number.isInteger(owner.pid) || !owner.start || !owner.boot) return "unknown";
  let state;
  try {
    const current = processIdentity(owner.pid, snapshot);
    state = current.boot === owner.boot && current.start === owner.start && !["Z", "X"].includes(current.state) ? "live" : "dead";
  } catch (error) { state = error.code === "ENOENT" ? "dead" : "unknown"; }
  if (owner.child && state !== "live") {
    const childState = ownerState(owner.child, snapshot);
    if (childState !== "dead") return childState;
  }
  return state;
}

export function descendsFrom(owner, ancestorPid, snapshot) {
  if (ownerState(owner, snapshot) !== "live" || !Number.isInteger(ancestorPid) || ancestorPid <= 0) return false;
  let pid = owner.pid;
  try {
    const source = backend();
    const rows = snapshot ?? (source === darwin ? processTable() : undefined);
    while (pid > 0) {
      if (pid === ancestorPid) return ownerState(owner, snapshot) === "live";
      const parent = source.processRow(pid, rows).parent;
      if (!Number.isInteger(parent) || parent === pid) return false;
      pid = parent;
    }
  } catch { return false; }
  return false;
}

export function processTable() {
  return backend().processTable();
}

// Darwin uses only the supplied snapshot; Linux retains fresh /proc identity checks.
export function observeTree(record, snapshot) {
  const boot = backend().bootIdentity();
  const known = (record.processes || []).filter(identity => !identity.boot || identity.boot === boot);
  record.processes = known;
  if (!known.length) return { live: [], uncertain: false };
  const rows = snapshot ?? processTable();
  const live = new Map();
  let uncertain = false;
  for (const identity of known) {
    const state = ownerState(identity, rows);
    if (state === "unknown") uncertain = true;
    if (state === "live") {
      const row = rows.get(identity.pid);
      if (row && !["Z", "X"].includes(row.state)) live.set(identity.pid, { ...identity, group: row.group });
      else uncertain = true;
    }
  }
  let added;
  do {
    added = false;
    const ownGroup = rows.get(process.pid)?.group;
    const groups = new Set([...live.values()].map(value => value.group).filter(group => group > 1 && group !== ownGroup));
    for (const row of rows.values()) {
      if (live.has(row.pid) || ["Z", "X"].includes(row.state) || (!live.has(row.parent) && !groups.has(row.group))) continue;
      try { live.set(row.pid, { ...processIdentity(row.pid, rows), group: row.group }); added = true; }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") uncertain = true; }
    }
  } while (added);
  for (const identity of known) {
    if ([...live.values()].some(value => value.group === identity.group)) continue;
    const members = [...rows.values()].filter(row => row.group === identity.group && !["Z", "X"].includes(row.state));
    // An unanchored surviving group is not authority to signal a possibly reused PID.
    if (members.length) {
      const leader = known.find(value => value.pid === identity.group);
      let reused = false;
      if (leader && rows.has(identity.group)) {
        try {
          const current = processIdentity(identity.group, rows);
          reused = current.start !== leader.start || current.boot !== leader.boot;
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") uncertain = true; }
      }
      if (!reused) uncertain = true;
    }
  }
  const byPid = new Map(known.map(value => [value.pid, value]));
  for (const value of live.values()) byPid.set(value.pid, value);
  record.processes = [...byPid.values()];
  return { live: [...live.values()], uncertain };
}
export function signalTree(tree, signal) {
  requireProcessSupport();
  const groups = new Set(tree.live.map(value => value.group));
  for (const group of groups) {
    const anchor = tree.live.find(value => value.group === group && ownerState(value) === "live");
    if (!anchor) continue;
    const row = processTable().get(anchor.pid);
    if (!row || row.group !== group) continue;
    if (group <= 1 || group === processTable().get(process.pid)?.group) throw new Error("Refusing to signal an unsafe process group");
    try { process.kill(-group, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
