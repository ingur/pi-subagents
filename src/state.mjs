import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonicalPath, readJSON, sessionId } from "./lib/state.mjs";
import { MESSAGE_TYPE } from "./prompts.mjs";

/** @typedef {"attempting" | "turn-settled" | "aborted" | "failed" | "uncertain"} Turn */
/** @typedef {{ manual: boolean, turn?: Turn }} Attempt */
/** @typedef {{ version: 1, owner: string, paused: boolean, runs: Record<string, Attempt> }} State */

export function stateDirectory(env = process.env, home = homedir()) {
  const directory = env.PI_SUBAGENTS_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "pi-subagents");
  if (!isAbsolute(directory)) throw new Error("PI_SUBAGENTS_STATE_DIR and XDG_STATE_HOME must be absolute");
  return canonicalPath(directory);
}

export function receiptEntries(entries, owner) {
  const receipts = new Map();
  for (const entry of entries) {
    const details = entry?.details;
    if (entry?.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.id === "string" &&
        details?.version === 1 && details.owner === owner && typeof details.id === "string" && Number.isSafeInteger(details.run) && details.run > 0) {
      receipts.set(`${details.id}:${details.run}`, entry.id);
    }
  }
  return receipts;
}

/** @returns {State} */
export function loadState(directory, owner) {
  const state = readJSON(join(directory, "adapter.json"), { version: 1, owner, paused: false, runs: {} });
  if (state?.version !== 1 || state.owner !== owner || typeof state.paused !== "boolean" ||
      !state.runs || typeof state.runs !== "object" || Array.isArray(state.runs)) throw new Error("Invalid subagent notification state");
  for (const [key, attempt] of Object.entries(state.runs)) {
    const split = key.lastIndexOf(":");
    sessionId(key.slice(0, split));
    if (!/^[1-9][0-9]*$/.test(key.slice(split + 1)) || typeof attempt?.manual !== "boolean" ||
        (attempt.turn !== undefined && !["attempting", "turn-settled", "aborted", "failed", "uncertain"].includes(attempt.turn))) {
      throw new Error("Invalid subagent run state");
    }
    // Earlier attempts are replay-only; current-session starts/follow-ups register new automatic wakes.
    attempt.manual = true;
    if (attempt.turn === "attempting") attempt.turn = "uncertain";
  }
  return state;
}

/** @param {State} state */
export function settleTurn(state, processing, inFlight, aborted, outcome) {
  const keys = new Set([...processing, ...(inFlight ?? [])]);
  const turn = aborted ? "aborted" : outcome === "completed" ? "turn-settled" : outcome === "error" ? "failed" : "uncertain";
  for (const key of keys) state.runs[key].turn = turn;
  const paused = aborted || (keys.size > 0 && turn !== "turn-settled");
  if (paused) state.paused = true;
  return paused || keys.size > 0;
}

export function processingKeys(completions, visible, runs) {
  return [...completions.keys()].filter(key => visible.has(key) && runs[key].turn !== "turn-settled");
}

export function wakeKeys(completions, visible, runs) {
  return [...completions.keys()].filter(key => !runs[key].manual && !runs[key].turn && visible.has(key));
}

export function retireRecorded(completions, persisted, runs, recorded) {
  for (const key of completions.keys()) {
    if (persisted.has(key) && (runs[key].manual || runs[key].turn === "turn-settled")) {
      recorded.add(key);
      completions.delete(key);
    }
  }
}
