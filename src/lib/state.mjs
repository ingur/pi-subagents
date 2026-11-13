// Copied from pi-projects core/lib, which no longer has a copy; this one is maintained here.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { uptime } from "node:os";
import { ownerState, processIdentity, requireProcessSupport } from "./process.mjs";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Expected a complete session UUID");
  return value;
}
export function readJSON(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

// Resolve existing ancestors too: first-run transcripts/state directories may not exist yet.
export function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    const parent = dirname(path);
    if (error.code !== "ENOENT" || parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function atomicJSON(directory, name, value) {
  requireProcessSupport();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const path = join(directory, name);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return value;
}

function inspectLock(directory, snapshot) {
  const names = readdirSync(directory);
  const states = [];
  let newest = lstatSync(directory).mtimeMs, incomplete = !names.length;
  for (const name of names) {
    const path = join(directory, name);
    newest = Math.max(newest, lstatSync(path).mtimeMs);
    try {
      const owner = readJSON(path);
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5)) ||
          !Number.isInteger(owner?.pid) || !owner.start || !owner.boot) incomplete = true;
      else states.push(ownerState(owner, snapshot));
    } catch { incomplete = true; }
  }
  // Incomplete writes get 1 s grace; older remnants (or remnants preceding this boot) cannot still be starting.
  const stale = newest < Date.now() - Math.min(uptime() * 1000, 1000);
  const state = states.includes("live") ? "live" : states.includes("unknown") || incomplete && !stale ? "unknown" : "dead";
  return { state, names };
}

export function acquireLock(directory) {
  requireProcessSupport();
  mkdirSync(join(directory, ".."), { recursive: true, mode: 0o700 });
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const { state, names } = inspectLock(directory);
      if (state !== "dead") throw Object.assign(new Error(`Live or uncertain owner (ownership unknown): ${directory}`), { code: "ELOCKED" });
      // Only remove observed filenames, never recursively delete a racing new owner's generation.
      for (const name of names) unlinkSync(join(directory, name));
      rmdirSync(directory);
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw Object.assign(new Error(`Lock ownership changed during reclamation: ${directory}`, { cause: error }), { code: "ELOCKED" });
      throw error;
    }
  }
  const owner = { ...processIdentity(), token: randomUUID() };
  const file = join(directory, `${owner.token}.json`);
  writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    unlinkSync(file);
    rmdirSync(directory);
  } };
}
