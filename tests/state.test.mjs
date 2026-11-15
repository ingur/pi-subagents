import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicJSON } from "../src/lib/state.mjs";
import { loadState, processingKeys, receiptEntries, retireRecorded, settleTurn, stateDirectory, wakeKeys } from "../src/state.mjs";
import { MESSAGE_TYPE, WAKE_TYPE } from "../src/prompts.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = randomUUID(), key = `${randomUUID()}:1`;
  return { directory, owner, key, state: { version: 1, owner, paused: false, runs: { [key]: { manual: false } } } };
}

test("receipt identity includes parent, child and positive safe run number", () => {
  const owner = randomUUID(), id = randomUUID();
  const entry = { type: "custom_message", customType: MESSAGE_TYPE, id: "entry", details: { version: 1, owner, id, run: 1 } };
  const entries = [entry, null, { ...entry, customType: WAKE_TYPE }, { ...entry, type: "message" },
    { ...entry, id: undefined }, { ...entry, details: { ...entry.details, owner: randomUUID() } },
    ...[undefined, 2].map(version => ({ ...entry, details: { ...entry.details, version } })),
    ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map(run => ({ ...entry, details: { ...entry.details, run } }))];
  assert.deepEqual([...receiptEntries(entries, owner)], [[`${id}:1`, "entry"]]);
});

test("an interrupted parent wake becomes uncertain and replay-only without pausing new work", t => {
  const { directory, owner, key, state } = fixture(t);
  state.runs[key].turn = "attempting";
  atomicJSON(directory, "adapter.json", state);
  const restored = loadState(directory, owner);
  assert.equal(restored.runs[key].turn, "uncertain");
  assert.equal(restored.runs[key].manual, true);
  assert.equal(restored.paused, false);
  assert.equal(JSON.parse(readFileSync(join(directory, "adapter.json"), "utf8")).runs[key].turn, "attempting");
});

test("invalid adapter state and attempt identities fail closed", t => {
  const { directory, owner, key, state } = fixture(t);
  for (const value of [null, { ...state, version: 2 }, { ...state, owner: randomUUID() }, { ...state, paused: 0 },
    { ...state, runs: [] }, { ...state, runs: null }, ...["bad:1", `${randomUUID()}:0`, `${randomUUID()}:01`, `${randomUUID()}:x`]
      .map(key => ({ ...state, runs: { [key]: { manual: true } } })),
    ...[null, {}, { manual: "false" }, { manual: false, turn: "" }, { manual: false, turn: "invalid" }]
      .map(attempt => ({ ...state, runs: { [key]: attempt } }))]) {
    atomicJSON(directory, "adapter.json", value);
    assert.throws(() => loadState(directory, owner), /Invalid|UUID/);
  }
});

test("settlement classifies every outcome and never clears an existing pause", t => {
  const { state, key } = fixture(t), other = `${randomUUID()}:2`;
  for (const [aborted, outcome, turn] of [[true, "completed", "aborted"], [false, "completed", "turn-settled"],
    [false, "error", "failed"], [false, undefined, "uncertain"]]) {
    const current = { ...state, runs: { [key]: { manual: false }, [other]: { manual: true } } };
    assert.equal(settleTurn(current, [key], [key, other], aborted, outcome), true);
    assert.equal(current.runs[key].turn, turn);
    assert.equal(current.runs[other].turn, turn);
    assert.equal(current.paused, turn !== "turn-settled");
  }
  state.paused = true;
  assert.equal(settleTurn(state, [key], undefined, false, "completed"), true);
  assert.equal(state.paused, true);
  assert.equal(settleTurn(state, [], undefined, false, "completed"), false);
  state.paused = false;
  assert.equal(settleTurn(state, [], undefined, true, undefined), true);
  assert.equal(state.paused, true, "an unrelated human abort still pauses automatic delivery");
});

test("only visible unattempted automatic completions wake; recorded settled and orphan notices retire", () => {
  const keys = ["auto", "orphan", "failed", "settled", "invisible"];
  const completions = new Map(keys.map(key => [key, {}]));
  const runs = { auto: { manual: false }, orphan: { manual: true }, failed: { manual: false, turn: "failed" },
    settled: { manual: false, turn: "turn-settled" }, invisible: { manual: false } };
  const visible = new Map(keys.slice(0, -1).map(key => [key, "entry"]));
  assert.deepEqual(wakeKeys(completions, visible, runs), ["auto"]);
  assert.deepEqual(processingKeys(completions, visible, runs), ["auto", "orphan", "failed"]);
  const recorded = new Set();
  retireRecorded(completions, new Map(), runs, recorded);
  assert.equal(completions.size, 5, "visible alone is not durable proof");
  retireRecorded(completions, visible, runs, recorded);
  assert.deepEqual([...recorded], ["orphan", "settled"]);
  assert.deepEqual([...completions.keys()], ["auto", "failed", "invisible"]);
});

test("state uses the normal XDG location or the explicit product override", () => {
  assert.equal(stateDirectory({}, "/no-such-root/home"), "/no-such-root/home/.local/state/pi-subagents");
  assert.equal(stateDirectory({ XDG_STATE_HOME: "/no-such-root/state" }, "/no-such-root/home"), "/no-such-root/state/pi-subagents");
  assert.equal(stateDirectory({ PI_SUBAGENTS_STATE_DIR: "/no-such-root/custom", XDG_STATE_HOME: "/no-such-root/state" }), "/no-such-root/custom");
  assert.throws(() => stateDirectory({ PI_SUBAGENTS_STATE_DIR: "relative" }), /absolute/);
  assert.throws(() => stateDirectory({ XDG_STATE_HOME: "relative" }), /absolute/);
});

test("replayed completions do not wake, but current-session starts and follow-ups do", t => {
  const { directory, owner, key, state } = fixture(t);
  assert.equal(loadState(directory, owner).paused, false);
  atomicJSON(directory, "adapter.json", state);
  const restored = loadState(directory, owner);
  assert.equal(restored.paused, false);
  assert.deepEqual(restored.runs[key], { manual: true });
  const started = `${randomUUID()}:1`, followUp = key.replace(/:1$/, ":2");
  restored.runs[started] = { manual: false };
  restored.runs[followUp] = { manual: false };
  const completions = new Map([key, started, followUp].map(key => [key, {}]));
  const visible = new Map([...completions.keys()].map(key => [key, "entry"]));
  assert.deepEqual(wakeKeys(completions, visible, restored.runs), [started, followUp]);
  state.paused = true;
  atomicJSON(directory, "adapter.json", state);
  assert.equal(loadState(directory, owner).paused, true, "an actual abort pause is preserved");
});
