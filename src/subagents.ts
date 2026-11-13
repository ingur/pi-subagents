import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { observeEditor, type EditorFocus } from "./lib/interaction.ts";
import { mayDeliver } from "./lib/delivery.mjs";
import { atomicJSON, sessionId } from "./lib/state.mjs";
import { SubagentManager } from "./runner.mjs";
import { MESSAGE_TYPE, WAKE_TYPE, boundedResult, compactChild, formatCompletion, help, parentInstructions, toolDescriptions, wakeInstruction } from "./prompts.mjs";
import type { ResultPreview } from "./prompts.mjs";
import { loadState, processingKeys, receiptEntries, retireRecorded, settleTurn, stateDirectory, wakeKeys, type State } from "./state.mjs";

type Child = {
  id: string; run: number; status: string; cwd: string; model: string; thinking: string; task: string;
  activity?: string; error?: string; output?: string; resultPath?: string;
};
type Receipts = { visible: Map<string, string>; persisted: Map<string, string> };
type Runtime = {
  owner: string; directory: string; sessionFile: string; ctx: ExtensionContext; manager: SubagentManager;
  state: State; completions: Map<string, ResultPreview>; recorded: Set<string>;
  editor: EditorFocus; unsubscribe?: () => void; timer?: NodeJS.Timeout;
  lastInteraction: number; promptOpen: number; launching: number; lastStatus?: string; fault?: string;
  inFlight?: { keys: string[]; at: number }; processing: string[]; outcome?: "completed" | "aborted" | "error";
};

const terminal: Record<string, true | undefined> = { succeeded: true, failed: true, cancelled: true, interrupted: true };
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const startSchema = Type.Object({
  task: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })), model: Type.Optional(Type.String({ minLength: 1 })),
  thinking: Type.Optional(Type.Union(thinkingLevels.map(level => Type.Literal(level)))),
}, { additionalProperties: false });
const idSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const sendSchema = Type.Object({ id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const keyOf = (child: Pick<Child, "id" | "run">) => `${child.id}:${child.run}`;
const toolResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });

function launchArguments(value: unknown, ctx: ExtensionContext, pi: ExtensionAPI) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a start JSON object");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !["task", "cwd", "model", "thinking"].includes(key))) throw new Error("Unknown start option");
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task must be nonempty text");
  for (const key of ["cwd", "model", "thinking"]) {
    if (key in args && (typeof args[key] !== "string" || !(args[key] as string).trim())) throw new Error(`${key} must be nonempty text`);
  }
  let model = ctx.model;
  if (typeof args.model === "string") {
    const all = ctx.modelRegistry.getAll();
    const canonical = all.filter(candidate => `${candidate.provider}/${candidate.id}` === args.model);
    const matches = canonical.length ? canonical : all.filter(candidate => candidate.id === args.model);
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous model; use exact provider/model" : "Unknown model; select an exact registered provider/model");
    model = matches[0];
  }
  if (!model || !ctx.modelRegistry.find(model.provider, model.id)) throw new Error("Select a registered parent model or supply exact model: provider/model");
  const thinking = typeof args.thinking === "string" ? args.thinking : pi.getThinkingLevel();
  if (!thinkingLevels.includes(thinking)) throw new Error(`Unknown thinking level: ${thinking}`);
  const cwd = realpathSync(resolve(ctx.cwd, typeof args.cwd === "string" ? args.cwd : "."));
  if (!statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
  return { task: args.task, cwd, model: `${model.provider}/${model.id}`, thinking };
}

export default function subagents(pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let failure = "Subagents require an interactive persistent Pi session";

  function bound(ctx: ExtensionContext) {
    if (!runtime || runtime.owner !== ctx.sessionManager.getSessionId()) throw new Error(failure);
    return runtime;
  }

  function report(r: Runtime, error: unknown) {
    const message = describeError(error);
    if (r.fault !== message) r.ctx.ui.notify(`Subagents: ${message}`, "error");
    r.fault = message;
    r.state.paused = true;
    r.ctx.ui.setStatus("subagents", `subagents: error; automatic wakes paused: ${message}`);
  }

  function save(r: Runtime) {
    try { atomicJSON(r.directory, "adapter.json", r.state); }
    catch (error) { report(r, error); throw error; }
  }

  function pause(r: Runtime, paused: boolean, reason: string) {
    r.state.paused = paused;
    r.state.reason = reason;
    save(r);
  }

  function remember(r: Runtime, child: Child) {
    if (!terminal[child.status]) return;
    const key = keyOf(child);
    if (!r.recorded.has(key)) r.completions.set(key, boundedResult(child));
    if (!r.state.runs[key]) {
      // An origin lost before metadata was saved must never become an automatic wake.
      r.state.runs[key] = { manual: true };
      save(r);
    }
  }

  function receipts(r: Runtime): Receipts {
    const visible = receiptEntries(r.ctx.sessionManager.getEntries(), r.owner);
    // Pi appends synchronously and rolls memory back on write failure; setup-only sessions have no file.
    return { visible, persisted: existsSync(r.sessionFile) ? visible : new Map() };
  }

  function list(r: Runtime) {
    return {
      children: r.manager.list().map((child: Child) => compactChild(child)),
      automaticRepliesPaused: r.state.paused,
      ...(r.state.paused ? { reason: r.state.reason } : {}),
      ...(r.fault ? { error: r.fault } : {}),
    };
  }

  function result(r: Runtime, id: string) {
    const child = r.manager.result(sessionId(id));
    remember(r, child);
    return boundedResult(child);
  }

  async function start(r: Runtime, args: unknown, ctx: ExtensionContext) {
    if (r.fault) throw new Error(`Notification state is unavailable: ${r.fault}`);
    const launch = launchArguments(args, ctx, pi);
    r.launching++;
    try {
      const child = await r.manager.start(launch);
      const key = keyOf(child);
      r.state.runs[key] = { ...r.state.runs[key], manual: false };
      try { save(r); }
      catch (error) { throw new Error(`Child ${child.id}, run ${child.run} was accepted, but notification state could not be saved: ${describeError(error)}. Inspect /subagents list; automatic wakes are paused.`); }
      remember(r, child);
      return { ...compactChild(child), automaticWake: true };
    } finally { r.launching--; }
  }

  async function send(r: Runtime, args: unknown) {
    if (r.fault) throw new Error(`Notification state is unavailable: ${r.fault}`);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected a send JSON object");
    const value = args as Record<string, unknown>;
    if (Object.keys(value).some(key => !["id", "text"].includes(key)) || typeof value.text !== "string" || !value.text.trim()) throw new Error("send requires id and nonempty text only");
    const id = sessionId(value.id);
    const previous = r.manager.result(id);
    remember(r, previous);
    r.launching++;
    try {
      const child = await r.manager.send({ id, text: value.text });
      const key = keyOf(child);
      // Existing attempts retain their wake policy; a retained follow-up has a new origin.
      if (child.run !== previous.run || !r.state.runs[key]) r.state.runs[key] = { manual: false };
      try { save(r); }
      catch (error) { throw new Error(`Instruction for child ${id}, run ${child.run} was accepted, but notification state could not be saved: ${describeError(error)}. Inspect /subagents list; automatic wakes are paused.`); }
      remember(r, child);
      return { ...compactChild(child), delivery: child.delivery, note: child.note, automaticWake: !r.state.runs[key].manual };
    } finally { r.launching--; }
  }

  async function stop(r: Runtime, id: string) {
    const child = await r.manager.stop(sessionId(id));
    remember(r, child);
    return boundedResult(child);
  }

  function tick(r: Runtime) {
    if (runtime !== r || r.owner !== r.ctx.sessionManager.getSessionId() || r.fault) return;
    try {
      if (r.inFlight && r.ctx.isIdle() && Date.now() - r.inFlight.at > 3000) {
        for (const key of r.inFlight.keys) r.state.runs[key].turn = "uncertain";
        r.inFlight = undefined;
        r.processing = [];
        pause(r, true, "Parent wake did not settle observably; inspect the Pi error and results, then submit a human prompt");
      }
      let seen = r.completions.size ? receipts(r) : { visible: new Map(), persisted: new Map() };
      retireRecorded(r.completions, seen.persisted, r.state.runs, r.recorded);
      const active = r.manager.list().filter((child: Child) => !terminal[child.status]).length;
      const waiting = [...r.completions.keys()].filter(key => !seen.visible.has(key) ||
        (!r.state.runs[key].manual && !r.state.runs[key].turn)).length;
      const uncertain = Object.values(r.state.runs).filter(attempt => ["uncertain", "failed", "aborted"].includes(attempt.turn ?? "")).length;
      const model = r.ctx.model;
      const modelSelected = !!model && !!r.ctx.modelRegistry.find(model.provider, model.id);
      const status = `${active} active; ${waiting} waiting${r.state.paused ? "; automatic wakes paused" : ""}${uncertain ? `; ${uncertain} parent turns incomplete (/subagents list)` : ""}${!modelSelected && waiting ? "; select a model for automatic wake" : ""}${r.editor.focusUnavailable ? "; editor focus unavailable" : ""}`;
      if (status !== r.lastStatus) { r.ctx.ui.setStatus("subagents", `subagents: ${status}`); r.lastStatus = status; }
      const gate = {
        idle: r.ctx.isIdle(), focused: r.editor.focused, pending: r.ctx.hasPendingMessages(), draft: r.ctx.ui.getEditorText(),
        lastInteraction: r.lastInteraction, promptOpen: r.promptOpen, inFlight: !!r.inFlight || r.launching > 0,
      };
      // Displaying a notice is safe while wakes are paused and does not require model/auth.
      if (!mayDeliver({ ...gate, modelSelected: true, paused: false })) return;
      for (const [key, child] of r.completions) {
        if (seen.visible.has(key)) continue;
        pi.sendMessage({ customType: MESSAGE_TYPE, content: formatCompletion(child, r.state.runs[key].manual), display: true,
          details: { version: 1, owner: r.owner, id: child.id, run: child.run, status: child.status } }, { triggerTurn: false });
        seen = receipts(r);
        if (!seen.visible.has(key)) throw new Error(`Completion notice ${key} was not observed; reload to reconcile it (no parent wake requested)`);
      }
      if (!mayDeliver({ ...gate, modelSelected, paused: r.state.paused })) return;
      const keys = wakeKeys(r.completions, seen.visible, r.state.runs);
      if (!keys.length) return;
      for (const key of keys) r.state.runs[key].turn = "attempting";
      r.inFlight = { keys, at: Date.now() };
      save(r);
      pi.sendMessage({ customType: WAKE_TYPE, content: wakeInstruction(keys), display: false,
        details: { version: 1, owner: r.owner, attempts: keys } }, { triggerTurn: true });
    } catch (error) { report(r, error); }
  }

  async function cleanup() {
    const r = runtime;
    runtime = undefined;
    if (!r) return;
    clearInterval(r.timer);
    try { r.unsubscribe?.(); }
    finally {
      try { r.editor.release(); r.ctx.ui.setStatus("subagents", undefined); }
      finally { await r.manager.close(); }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      await cleanup();
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      const stateDir = stateDirectory();
      const owner = sessionId(ctx.sessionManager.getSessionId());
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;
      const directory = join(stateDir, owner);
      const state = loadState(directory, owner);
      const editor = observeEditor(ctx);
      let manager: SubagentManager;
      try {
        manager = new SubagentManager({ stateDir, owner, onChange: (child: Child) => {
          const r = runtime;
          if (!r || r.manager !== manager) return;
          try { remember(r, child); } catch (error) { report(r, error); }
        } });
      } catch (error) { editor.release(); throw error; }
      const r: Runtime = { owner, directory, sessionFile, ctx, manager, editor, state, completions: new Map(), recorded: new Set(),
        lastInteraction: Date.now(), promptOpen: 0, launching: 0, processing: [] };
      runtime = r;
      save(r);
      for (const child of manager.list()) remember(r, child);
      r.unsubscribe = ctx.ui.onTerminalInput(() => {
        r.lastInteraction = Date.now();
        return undefined;
      });
      r.timer = setInterval(() => tick(r), 750);
      r.timer.unref();
      ctx.ui.setStatus("subagents", "subagents: ready");
    } catch (error) {
      try { await cleanup(); } catch (closeError) { ctx.ui.notify(`Subagent cleanup: ${describeError(closeError)}`, "error"); }
      failure = `Subagents disabled: ${describeError(error)}`;
      ctx.ui.setStatus("subagents", failure);
      ctx.ui.notify(failure, "error");
    }
  });
  pi.on("session_shutdown", async () => { await cleanup(); });
  pi.on("input", event => {
    if (runtime && event.source === "interactive") {
      runtime.lastInteraction = Date.now();
      pause(runtime, false, "Human submitted a prompt");
    }
    return { action: "continue" };
  });
  pi.on("ui_prompt_start", () => { if (runtime) runtime.promptOpen++; });
  pi.on("ui_prompt_end", () => {
    if (!runtime) return;
    runtime.promptOpen = Math.max(0, runtime.promptOpen - 1);
    runtime.lastInteraction = Date.now();
  });
  pi.on("before_agent_start", (event, ctx) => {
    const r = runtime;
    if (!r || r.owner !== ctx.sessionManager.getSessionId()) return;
    const visible = receiptEntries(ctx.sessionManager.getBranch(), r.owner);
    r.processing = processingKeys(r.completions, visible, r.state.runs);
    r.outcome = undefined;
    if (r.processing.length) {
      for (const key of r.processing) r.state.runs[key].turn = "attempting";
      save(r);
    }
    event.systemPromptOptions.sections.subagents = parentInstructions;
  });
  pi.on("agent_before_settle", event => { if (runtime) runtime.outcome = event.outcome; });
  pi.on("agent_settled", event => {
    const r = runtime;
    if (!r) return;
    const changed = settleTurn(r.state, r.processing, r.inFlight?.keys, event.aborted, r.outcome);
    r.processing = [];
    r.inFlight = undefined;
    r.lastInteraction = Date.now();
    if (changed) save(r);
  });

  pi.registerTool({ name: "subagent_start", label: "Start background subagent", description: toolDescriptions.start, parameters: startSchema,
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent launch cancelled before acceptance");
      return toolResult(await start(bound(ctx), args, ctx));
    } });
  pi.registerTool({ name: "subagent_send", label: "Send to background subagent", description: toolDescriptions.send, parameters: sendSchema,
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent send cancelled before acceptance");
      return toolResult(await send(bound(ctx), args));
    } });
  pi.registerTool({ name: "subagent_list", label: "List background subagents", description: toolDescriptions.list, parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) { return toolResult(list(bound(ctx))); } });
  pi.registerTool({ name: "subagent_result", label: "Read subagent result", description: toolDescriptions.result, parameters: idSchema,
    async execute(_id, args, _signal, _update, ctx) { return toolResult(result(bound(ctx), args.id)); } });
  pi.registerTool({ name: "subagent_stop", label: "Stop background subagent", description: toolDescriptions.stop, parameters: idSchema,
    async execute(_id, args, _signal, _update, ctx) { return toolResult(await stop(bound(ctx), args.id)); } });

  pi.registerCommand("subagents", {
    description: "Background children: list, result ID, stop ID",
    handler: async (args, ctx) => {
      const text = args.trim();
      const [verb = ""] = text.split(/\s+/);
      const body = text.slice(verb.length).trim();
      try {
        if (verb === "help") { ctx.ui.notify(help, "info"); return; }
        const r = bound(ctx);
        r.lastInteraction = Date.now();
        let value: unknown;
        if (!verb || verb === "list") value = list(r);
        else if (verb === "result") value = result(r, body);
        else if (verb === "stop") value = await stop(r, body);
        else throw new Error(help);
        ctx.ui.notify(JSON.stringify(value, null, 2), "info");
      } catch (error) { ctx.ui.notify(`Subagents: ${describeError(error)}`, "error"); }
    },
  });
}
