import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { mayDeliver } from "../src/lib/delivery.mjs";
import { atomicJSON, sessionId } from "../src/lib/state.mjs";
import * as prompts from "../src/prompts.mjs";
import * as state from "../src/state.mjs";

// Exercise the extension's glue with a fake Pi and manager; timers run by hand.
const source = stripTypeScriptTypes(readFileSync(new URL("../src/subagents.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default function", "function");

test("stopping a subagent shows its notice but does not start a turn", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = { id: randomUUID(), run: 1, status: "queued", task: "task", output: "" };
  let tick, onChange;
  class SubagentManager {
    constructor(options) { onChange = options.onChange; }
    list() { return []; }
    result() { return { ...child }; }
    async start() { return { ...child }; }
    // The wake timer may fire while a stop is still in progress.
    async stop() { child.status = "cancelled"; onChange({ ...child }); tick(); return { ...child }; }
  }
  const subagents = runInNewContext(`${source}\nsubagents;`, {
    ...prompts, ...state, about: prompts.parameterDescriptions, stateDirectory: () => directory, mayDeliver, atomicJSON, sessionId,
    SubagentManager, existsSync: () => true, realpathSync, statSync, join, resolve, Type: new Proxy({}, { get: () => () => ({}) }),
    observeEditor: () => ({ focused: true, release() {} }), Date: { now: () => 0 }, setInterval: fn => { tick = fn; return { unref() {} }; },
  });
  const handlers = {}, tools = {}, entries = [], turns = [];
  subagents({
    on: (name, handler) => { handlers[name] = handler; }, registerTool: tool => { tools[tool.name] = tool; }, registerCommand() {},
    getThinkingLevel: () => "off",
    sendMessage: (message, options) => { turns.push(options.triggerTurn); entries.push({ type: "custom_message", id: `${entries.length}`, ...message }); },
  });
  const owner = randomUUID();
  const ctx = {
    mode: "tui", hasUI: true, cwd: directory, model: { provider: "p", id: "m" }, modelRegistry: { find: () => true },
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => owner, getSessionFile: () => "session.jsonl", getEntries: () => entries },
    ui: { setStatus() {}, notify() {}, onTerminalInput() {}, getEditorText: () => "" },
  };
  await handlers.session_start({}, ctx);
  await tools.subagent_start.execute("start", { task: "task" }, undefined, undefined, ctx);
  await tools.subagent_stop.execute("stop", { id: child.id }, undefined, undefined, ctx);
  tick();
  assert.deepEqual(turns, [false]);
});
