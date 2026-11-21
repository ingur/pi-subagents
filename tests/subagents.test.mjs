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

async function harness(t, manager) {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = { handlers: {}, tools: {}, commands: {}, sent: [], idle: true };
  class SubagentManager {
    constructor(options) { h.onChange = options.onChange; Object.assign(this, manager(h)); }
  }
  const subagents = runInNewContext(`${source}\nsubagents;`, {
    ...prompts, ...state, about: prompts.parameterDescriptions, stateDirectory: () => directory, mayDeliver, atomicJSON, sessionId,
    SubagentManager, existsSync: () => true, realpathSync, statSync, join, resolve, Type: new Proxy({}, { get: () => () => ({}) }),
    observeEditor: () => ({ focused: true, release() {} }), Date: { now: () => 0 }, setInterval: fn => { h.tick = fn; return { unref() {} }; },
  });
  subagents({
    on: (name, handler) => { h.handlers[name] = handler; }, registerTool: tool => { h.tools[tool.name] = tool; }, registerMessageRenderer() {},
    registerCommand: (name, command) => { h.commands[name] = command; }, getThinkingLevel: () => "off",
    sendMessage: (message, options) => h.sent.push({ type: "custom_message", id: `${h.sent.length}`, ...message, turn: options.triggerTurn }),
  });
  const owner = randomUUID();
  h.ctx = {
    mode: "tui", hasUI: true, cwd: directory, model: { provider: "p", id: "m" }, modelRegistry: { find: () => true },
    isIdle: () => h.idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => owner, getSessionFile: () => "session.jsonl", getEntries: () => h.sent },
    ui: { setStatus() {}, notify() {}, onTerminalInput() {}, getEditorText: () => "", theme: { fg: (_color, text) => text } },
  };
  await h.handlers.session_start({}, h.ctx);
  h.call = (tool, args) => h.tools[tool].execute(tool, args, undefined, undefined, h.ctx);
  return h;
}

test("stopping a subagent shows its notice but does not start a turn", async t => {
  const child = { id: randomUUID(), run: 1, title: "title", status: "queued", finished: false, task: "task", output: "" };
  const h = await harness(t, h => ({
    list: () => [], result: () => ({ ...child }), start: async () => ({ ...child }),
    // The wake timer may fire while a stop is still in progress.
    async stop() { Object.assign(child, { status: "cancelled", finished: true }); h.onChange({ ...child }); h.tick(); return { ...child }; },
  }));
  await h.call("subagent_start", { title: "title", task: "task" });
  await h.call("subagent_stop", { id: child.id });
  h.tick();
  assert.deepEqual(h.sent.map(entry => [entry.turn, entry.details.title]), [[false, "title"]]);
});

test("forgetting a subagent forgets its notice", async t => {
  const child = { id: randomUUID(), run: 1, title: "title", status: "succeeded", finished: true, task: "task", output: "done" };
  let forgotten = false;
  const h = await harness(t, () => ({
    list: () => forgotten ? [] : [{ ...child }], start: async () => ({ ...child, status: "queued", finished: false }), forget() { forgotten = true; },
  }));
  h.idle = false;
  await h.call("subagent_start", { title: "title", task: "task" });
  h.onChange({ ...child });
  h.tick();
  await h.commands.subagents.handler(`forget ${child.id}`, h.ctx);
  h.idle = true;
  h.tick();
  assert.deepEqual(h.sent, []);
});

test("a cut result names its file only once the subagent has finished and was saved", () => {
  const child = { id: randomUUID(), run: 1, title: "title", status: "running", finished: false, output: "x".repeat(9000), resultPath: "/state/run-1.json" };
  const done = { ...child, status: "succeeded", finished: true }, lost = { ...done, unsaved: "disk full" };
  assert.deepEqual([child, done, lost].map(each => prompts.boundedResult(each).resultPath), [undefined, child.resultPath, undefined]);
  assert.deepEqual([child, done, lost].map(each => prompts.formatCompletion(each, false).includes(child.resultPath)), [false, true, false]);
  assert.match(prompts.boundedResult(lost).unsaved, /disk full/);
});
