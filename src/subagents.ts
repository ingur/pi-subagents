import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { observeEditor, type EditorFocus } from "./lib/interaction.ts";
import { mayDeliver } from "./lib/delivery.mjs";
import { atomicJSON, sessionId } from "./lib/state.mjs";
import { SubagentManager } from "./runner.mjs";
import { MESSAGE_TYPE, WAKE_TYPE, boundedResult, compactChild, formatCompletion, help, notes, parameterDescriptions as about, parentInstructions, toolDescriptions, wakeInstruction } from "./prompts.mjs";
import { loadState, processingKeys, receiptEntries, retireRecorded, settleTurn, stateDirectory, wakeKeys, type State } from "./state.mjs";

type Child = {
  id: string; run: number; title: string; status: string; finished: boolean; cwd: string; model: string; thinking: string; task: string;
  activity?: string; error?: string; output?: string; resultPath?: string; note?: string; unsaved?: string;
};
type Args = { id?: string; title?: string; task?: string; text?: string };
type Details = { status?: string; output?: string; error?: string; subagents?: Pick<Child, "title" | "status" | "activity">[] };
type Result = { content: { type: string; text?: string }[]; details: Details };
type Receipts = { visible: Map<string, string>; persisted: Map<string, string> };
type Runtime = {
  owner: string; directory: string; sessionFile: string; ctx: ExtensionContext; manager: SubagentManager;
  state: State; completions: Map<string, Child>; recorded: Set<string>;
  editor: EditorFocus; unsubscribe?: () => void; timer?: NodeJS.Timeout;
  lastInteraction: number; promptOpen: number; launching: number; lastStatus?: string; fault?: string;
  inFlight?: { keys: string[]; at: number }; processing: string[]; outcome?: "completed" | "aborted" | "error";
};

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const startSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 80, description: about.title }),
  task: Type.String({ minLength: 1, description: about.task }),
  cwd: Type.Optional(Type.String({ minLength: 1, description: about.cwd })),
  model: Type.Optional(Type.String({ minLength: 1, description: about.model })),
  thinking: Type.Optional(Type.Union(thinkingLevels.map(level => Type.Literal(level)), { description: about.thinking })),
}, { additionalProperties: false });
const idSchema = Type.Object({ id: Type.String({ minLength: 1, description: about.id }) }, { additionalProperties: false });
const sendSchema = Type.Object({
  id: Type.String({ minLength: 1, description: about.id }), text: Type.String({ minLength: 1, description: about.text }),
}, { additionalProperties: false });
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const keyOf = (child: Pick<Child, "id" | "run">) => `${child.id}:${child.run}`;
const toolResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

function toolLine(theme: Theme, name: string, object = "") {
  return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", object)}`, 0, 0);
}

const resultText = (details: Details) => [details.status, details.error, details.output].filter(Boolean).join("\n\n");
const outputs: Record<string, (args: Args, details: Details) => string> = {
  subagent_start: args => args.task ?? "",
  subagent_send: args => args.text ?? "",
  subagent_list: (_args, details) => (details.subagents ?? []).map(child => [child.title, child.status, child.activity].filter(Boolean).join(" · ")).join("\n"),
  subagent_result: (_args, details) => resultText(details),
  subagent_stop: (_args, details) => resultText(details),
};

function under(theme: Theme, tool: string, args: Args, result: Result, expanded: boolean, refused: boolean) {
  if (refused) return new Text(theme.fg("error", result.content.map(part => part.text ?? "").join("\n")), 0, 0);
  const output = expanded ? outputs[tool](args, result.details) : "";
  return new Text(output && output.split("\n").map(line => theme.fg("toolOutput", line)).join("\n"), 0, 0);
}

function launchArguments(value: unknown, ctx: ExtensionContext, pi: ExtensionAPI) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a start JSON object");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !["title", "task", "cwd", "model", "thinking"].includes(key))) throw new Error("Unknown start option");
  if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title must be nonempty text");
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
  return { title: args.title, task: args.task, cwd, model: `${model.provider}/${model.id}`, thinking };
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
    r.ctx.ui.setStatus("subagents", r.ctx.ui.theme.fg("error", `subagents: error · automatic wakes paused: ${message}`));
  }

  function save(r: Runtime) {
    try { atomicJSON(r.directory, "adapter.json", r.state); }
    catch (error) { report(r, error); throw error; }
  }

  function pause(r: Runtime, paused: boolean) {
    r.state.paused = paused;
    save(r);
  }

  function remember(r: Runtime, child: Child) {
    if (!child.finished) return;
    const key = keyOf(child);
    if (!r.recorded.has(key)) r.completions.set(key, child);
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
      subagents: r.manager.list().map((child: Child) => compactChild(child)),
      ...(r.state.paused ? { note: notes.paused } : {}),
      ...(r.fault ? { error: r.fault } : {}),
    };
  }

  function result(r: Runtime, id: string) {
    const child = r.manager.result(sessionId(id));
    remember(r, child);
    return boundedResult(child);
  }

  async function start(r: Runtime, args: unknown, ctx: ExtensionContext) {
    if (r.fault) throw new Error(`Subagents are unavailable in this session because of an internal error: ${r.fault}. Tell the user.`);
    const launch = launchArguments(args, ctx, pi);
    r.launching++;
    try {
      const child = await r.manager.start(launch);
      const key = keyOf(child);
      r.state.runs[key] = { ...r.state.runs[key], manual: false };
      try { save(r); }
      catch (error) { throw new Error(`Subagent ${child.id} was started, but its result will not arrive by itself because of an internal error: ${describeError(error)}. Read it later with subagent_result, and tell the user.`); }
      remember(r, child);
      return { id: child.id, title: child.title, status: child.status, note: notes.started };
    } finally { r.launching--; }
  }

  async function send(r: Runtime, args: unknown) {
    if (r.fault) throw new Error(`Subagents are unavailable in this session because of an internal error: ${r.fault}. Tell the user.`);
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
      catch (error) { throw new Error(`The instruction was sent to subagent ${id}, but its result will not arrive by itself because of an internal error: ${describeError(error)}. Read it later with subagent_result, and tell the user.`); }
      remember(r, child);
      return { id: child.id, title: child.title, status: child.status, note: child.note };
    } finally { r.launching--; }
  }

  async function stop(r: Runtime, id: string) {
    // Handled before stopping: whoever stops a run already knows, so its notice must not start a turn.
    const key = keyOf(r.manager.result(sessionId(id)));
    r.state.runs[key] = { manual: false, ...r.state.runs[key], turn: "turn-settled" };
    const child = await r.manager.stop(id);
    remember(r, child);
    return boundedResult(child);
  }

  function forget(r: Runtime, id: string) {
    r.manager.forget(sessionId(id));
    for (const [key, child] of r.completions) if (child.id === id) r.completions.delete(key);
    return list(r);
  }

  function tick(r: Runtime) {
    if (runtime !== r || r.owner !== r.ctx.sessionManager.getSessionId() || r.fault) return;
    try {
      if (r.inFlight && r.ctx.isIdle() && Date.now() - r.inFlight.at > 3000) {
        for (const key of r.inFlight.keys) r.state.runs[key].turn = "uncertain";
        r.inFlight = undefined;
        r.processing = [];
        pause(r, true);
      }
      let seen = r.completions.size ? receipts(r) : { visible: new Map(), persisted: new Map() };
      retireRecorded(r.completions, seen.persisted, r.state.runs, r.recorded);
      const active = r.manager.list().filter((child: Child) => !child.finished).length;
      const waiting = [...r.completions.keys()].filter(key => !seen.visible.has(key) ||
        (!r.state.runs[key].manual && !r.state.runs[key].turn)).length;
      const model = r.ctx.model;
      const modelSelected = !!model && !!r.ctx.modelRegistry.find(model.provider, model.id);
      const notes = [`${active} active`, `${waiting} waiting`, r.state.paused && "automatic wakes paused", !modelSelected && waiting && "select a model for automatic wake", r.editor.focusUnavailable && "editor focus unavailable"];
      const status = active || waiting ? `subagents: ${notes.filter(Boolean).join(" · ")}` : undefined;
      if (status !== r.lastStatus) { r.ctx.ui.setStatus("subagents", status && r.ctx.ui.theme.fg("dim", status)); r.lastStatus = status; }
      const gate = {
        idle: r.ctx.isIdle(), focused: r.editor.focused, pending: r.ctx.hasPendingMessages(), draft: r.ctx.ui.getEditorText(),
        lastInteraction: r.lastInteraction, promptOpen: r.promptOpen, inFlight: !!r.inFlight || r.launching > 0,
      };
      // Displaying a notice is safe while wakes are paused and does not require model/auth.
      if (!mayDeliver({ ...gate, modelSelected: true, paused: false })) return;
      for (const [key, child] of r.completions) {
        if (seen.visible.has(key)) continue;
        pi.sendMessage({ customType: MESSAGE_TYPE, content: formatCompletion(child, r.state.runs[key].manual), display: true,
          details: { version: 1, owner: r.owner, id: child.id, run: child.run, title: child.title, status: child.status } }, { triggerTurn: false });
        seen = receipts(r);
        if (!seen.visible.has(key)) throw new Error(`Completion notice ${key} was not observed; reload to reconcile it (no parent wake requested)`);
      }
      if (!mayDeliver({ ...gate, modelSelected, paused: r.state.paused })) return;
      const keys = wakeKeys(r.completions, seen.visible, r.state.runs);
      if (!keys.length) return;
      for (const key of keys) r.state.runs[key].turn = "attempting";
      r.inFlight = { keys, at: Date.now() };
      save(r);
      pi.sendMessage({ customType: WAKE_TYPE, content: wakeInstruction, display: false,
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
    } catch (error) {
      try { await cleanup(); } catch (closeError) { ctx.ui.notify(`Subagent cleanup: ${describeError(closeError)}`, "error"); }
      failure = `Subagents disabled: ${describeError(error)}`;
      ctx.ui.setStatus("subagents", ctx.ui.theme.fg("error", failure));
      ctx.ui.notify(failure, "error");
    }
  });
  pi.on("session_shutdown", async () => { await cleanup(); });
  pi.on("input", event => {
    if (runtime && event.source === "interactive") {
      runtime.lastInteraction = Date.now();
      pause(runtime, false);
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

  const titleOf = (id?: string) => runtime?.manager.list().find((child: Child) => child.id === id)?.title;
  const drawn = (name: string, object: (args: Args) => string | undefined) => ({
    renderCall: (args: Args, theme: Theme) => toolLine(theme, name, object(args)),
    renderResult: (result: Result, options: { expanded: boolean }, theme: Theme, context: { args: Args; isError: boolean }) =>
      under(theme, name, context.args, result, options.expanded, context.isError),
  });

  pi.registerMessageRenderer<{ title?: string; status: string }>(MESSAGE_TYPE, (message, options, theme) => {
    const { title, status } = message.details!;
    const line = `${theme.bold(["subagent", title].filter(Boolean).join(" "))} ${theme.fg(status === "succeeded" ? "success" : "error", status)}`;
    return new Text(options.expanded ? `${line}\n\n${message.content}` : line, options.outputPad, 0);
  });

  pi.registerTool({ name: "subagent_start", label: "Start background subagent", description: toolDescriptions.start, parameters: startSchema,
    ...drawn("subagent_start", args => args.title),
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent launch cancelled before acceptance");
      return toolResult(await start(bound(ctx), args, ctx));
    } });
  pi.registerTool({ name: "subagent_send", label: "Send to background subagent", description: toolDescriptions.send, parameters: sendSchema,
    ...drawn("subagent_send", args => titleOf(args.id)),
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Subagent send cancelled before acceptance");
      return toolResult(await send(bound(ctx), args));
    } });
  pi.registerTool({ name: "subagent_list", label: "List background subagents", description: toolDescriptions.list, parameters: Type.Object({}, { additionalProperties: false }),
    ...drawn("subagent_list", () => undefined),
    async execute(_id, _args, _signal, _update, ctx) { return toolResult(list(bound(ctx))); } });
  pi.registerTool({ name: "subagent_result", label: "Read subagent result", description: toolDescriptions.result, parameters: idSchema,
    ...drawn("subagent_result", args => titleOf(args.id)),
    async execute(_id, args, _signal, _update, ctx) { return toolResult(result(bound(ctx), args.id)); } });
  pi.registerTool({ name: "subagent_stop", label: "Stop background subagent", description: toolDescriptions.stop, parameters: idSchema,
    ...drawn("subagent_stop", args => titleOf(args.id)),
    async execute(_id, args, _signal, _update, ctx) { return toolResult(await stop(bound(ctx), args.id)); } });

  pi.registerCommand("subagents", {
    description: "Background subagents: list, result ID, stop ID, forget ID",
    getArgumentCompletions: (prefix: string) => {
      const items = ["list", "result", "stop", "forget"].filter(verb => verb.startsWith(prefix)).map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
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
        else if (verb === "forget") value = forget(r, body);
        else throw new Error(help);
        ctx.ui.notify(JSON.stringify(value, null, 2), "info");
      } catch (error) { ctx.ui.notify(`Subagents: ${describeError(error)}`, "error"); }
    },
  });
}
