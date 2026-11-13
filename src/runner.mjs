import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { acquireLock, atomicJSON, readJSON, sessionId, UUID } from "./lib/state.mjs";
import { observeTree, processIdentity, processTable, requireProcessSupport, signalTree } from "./lib/process.mjs";
import { capturePiCommand } from "./command.mjs";
import { childInstructions } from "./prompts.mjs";

const ACTIVE = new Set(["queued", "running", "stopping"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const CONCURRENCY = 4;
const MAX_LINE = 16 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => error instanceof Error ? error.message : String(error);
const text = content => Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || !statSync(path).isDirectory()) throw new Error(`Unsafe subagent directory: ${path}`);
}
function regularFile(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || realpathSync(path) !== path) throw new Error(`Unsafe subagent file: ${path}`);
}
function settings({ cwd, model, thinking }) {
  if (!isAbsolute(cwd || "") || realpathSync(cwd) !== cwd || !statSync(cwd).isDirectory()) throw new Error("Subagent cwd must be an absolute canonical directory");
  if (typeof model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(model) || model.includes("\0")) throw new Error("Subagent model must be an exact provider/model identifier");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("Invalid subagent thinking level");
}
function descriptor(record) {
  const { id, run, status, cwd, model, thinking, task, activity, error, output, resultPath } = record;
  return { id, run, status, cwd, model, thinking, task, activity, error, output, resultPath };
}

// Pi's JSON message_update deliberately omits message/partial; use content-indexed deltas.
class EventReader {
  constructor(record, changed, received) {
    this.record = record;
    this.changed = changed;
    this.received = received;
    this.blocks = [];
    this.buffer = "";
    this.discarding = false;
    this.decoder = new StringDecoder("utf8");
    this.ended = false;
  }
  push(chunk, final = false) {
    const input = final ? this.decoder.end() : this.decoder.write(chunk);
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf("\n", offset);
      const end = newline === -1 ? input.length : newline;
      if (!this.discarding) {
        this.buffer += input.slice(offset, end);
        // Pi emits type first. agent_end repeats the whole run; message_end is authoritative.
        if (/^\s*\{\s*"type"\s*:\s*"agent_end"\s*[,}]/.test(this.buffer)) {
          this.discarding = true;
          this.buffer = "";
        } else if (this.buffer.length > MAX_LINE) throw new Error("Pi JSON event exceeds the 16 MiB parser limit");
      }
      if (newline === -1) break;
      if (!this.discarding) this.line(this.buffer);
      this.buffer = "";
      this.discarding = false;
      offset = newline + 1;
    }
    if (final && this.buffer) { this.line(this.buffer); this.buffer = ""; }
  }
  assistant(value) {
    this.seenAssistant = true;
    this.stopReason = value.stopReason;
    this.assistantError = value.errorMessage;
    const finalText = text(value.content);
    this.record.output = finalText || (value.stopReason === "stop" ? "" : this.record.output);
  }
  line(line) {
    if (!line.trim()) return;
    if (line.length > MAX_LINE) throw new Error("Pi JSON event exceeds the 16 MiB parser limit");
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Invalid Pi JSON event: ${line.slice(0, 200)}`); }
    if (!event || typeof event.type !== "string") throw new Error("Pi emitted an event without a type");
    switch (event.type) {
      case "agent_start":
      case "auto_retry_start":
        this.ended = false;
        this.record.activity = event.type === "auto_retry_start" ? "Retrying" : "Working";
        break;
      case "message_start":
        if (event.message?.role === "assistant") { this.blocks = []; this.record.activity = "Thinking"; }
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta" && Number.isSafeInteger(delta.contentIndex) && delta.contentIndex >= 0 && delta.contentIndex < 100000 && typeof delta.delta === "string") {
          this.blocks[delta.contentIndex] = (this.blocks[delta.contentIndex] || "") + delta.delta;
          this.record.output = this.blocks.filter(value => value !== undefined).join("\n");
          this.record.activity = "Responding";
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant") this.assistant(event.message);
        break;
      case "tool_execution_start":
        this.record.activity = `Tool: ${event.toolName || "unknown"}`;
        break;
      case "tool_execution_end":
        this.record.activity = "Working";
        break;
      case "agent_settled":
        this.ended = true;
        this.aborted = event.aborted === true;
        break;
    }
    this.received(event);
    this.changed();
  }
  failure() {
    if (!this.seenAssistant || !this.ended) return "Pi exited without a complete assistant response";
    if (this.aborted) return "Pi settled after an abort";
    if (this.stopReason !== "stop") return this.assistantError || `Assistant stopped with ${this.stopReason || "unknown stop reason"}`;
    return undefined;
  }
}


export class SubagentManager {
  constructor({ stateDir, owner, onChange, command = capturePiCommand() }) {
    requireProcessSupport();
    if (!isAbsolute(stateDir || "")) throw new Error("Subagent stateDir must be absolute");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(stateDir);
    this.owner = sessionId(owner);
    this.onChange = onChange;
    this.command = command;
    this.root = join(this.stateDir, this.owner);
    directory(this.root);
    this.lock = acquireLock(join(this.root, ".manager-lock"));
    this.records = new Map();
    this.running = new Map();
    this.unresolved = new Set();
    this.closed = false;
    const replay = [];
    try {
      for (const id of readdirSync(this.root).filter(name => UUID.test(name))) {
        const childDir = join(this.root, id);
        directory(childDir);
        const files = readdirSync(childDir).filter(name => /^run-[1-9]\d*\.json$/.test(name)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)));
        for (const file of files) {
          regularFile(join(childDir, file));
          const record = readJSON(join(childDir, file));
          if (record?.version !== 1 || record.owner !== this.owner || record.id !== id || !Number.isSafeInteger(record.run) || `run-${record.run}.json` !== file || (!ACTIVE.has(record.status) && !TERMINAL.has(record.status)) || record.resultPath !== join(childDir, file)) throw new Error(`Invalid owned subagent metadata: ${file}`);
          if (ACTIVE.has(record.status)) {
            record.status = "interrupted";
            record.activity = undefined;
            const tree = observeTree(record);
            record.error = tree.live.length || tree.uncertain || record.launchPending
              ? "Parent stopped; live or uncertain child work remains. Stop it before resuming."
              : "Parent stopped before this attempt finished; work was not replayed.";
            this.persist(record);
          }
          this.records.set(id, record);
          if (TERMINAL.has(record.status)) replay.push(descriptor(record));
        }
        const latest = this.records.get(id);
        if (latest?.status === "interrupted") {
          const tree = observeTree(latest);
          if (tree.live.length || tree.uncertain || latest.launchPending) this.unresolved.add(id);
        }
      }
    } catch (error) { this.lock.release(); throw error; }
    this.monitor = setInterval(() => this.monitorProcesses(), 1000);
    this.monitor.unref();
    queueMicrotask(() => { if (!this.closed) for (const value of replay) this.notify(value); });
  }
  notify(value) {
    try { Promise.resolve(this.onChange?.(value)).catch(() => {}); } catch { /* UI failures must not break process cleanup. */ }
  }
  persist(record) {
    const path = record.resultPath;
    regularFile(path);
    atomicJSON(join(this.root, record.id), basename(path), record);
  }
  publish(record) { this.persist(record); this.notify(descriptor(record)); }
  get(id) {
    sessionId(id);
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown subagent for this parent session");
    return record;
  }
  list() { return [...this.records.values()].map(descriptor); }
  result(id) { return descriptor(this.get(id)); }
  async start({ task, cwd, model, thinking, resume }) {
    if (this.closed) throw new Error("Subagent manager is closed");
    if (typeof task !== "string" || !task.trim()) throw new Error("Subagent task must be nonempty text");
    let previous;
    if (resume !== undefined) {
      if (cwd !== undefined || model !== undefined || thinking !== undefined) throw new Error("A follow-up cannot override cwd, model, or thinking");
      previous = this.get(resume);
      if (ACTIVE.has(previous.status) || this.running.has(resume)) throw new Error("This child already has an active attempt");
      const tree = observeTree(previous);
      if (tree.live.length || tree.uncertain || previous.launchPending) throw new Error("Live or uncertain child work blocks resume; stop it first");
      ({ cwd, model, thinking } = previous);
      const sessionPath = join(this.root, previous.id, "session.jsonl");
      regularFile(sessionPath);
      if (!existsSync(sessionPath)) throw new Error("No retained child transcript exists; start a new child instead");
      const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n", 1)[0]);
      if (header.type !== "session" || !UUID.test(header.id) || header.cwd !== cwd) throw new Error("Retained child transcript identity or cwd is invalid");
    }
    settings({ cwd, model, thinking });
    const id = previous?.id || randomUUID();
    const run = previous ? previous.run + 1 : 1;
    const childDir = join(this.root, id);
    directory(childDir);
    const record = { version: 1, owner: this.owner, id, run, status: "queued", cwd, model, thinking, task, instructions: [], output: "", resultPath: join(childDir, `run-${run}.json`), processes: [] };
    this.persist(record);
    this.unresolved.delete(id);
    this.records.set(id, record);
    this.notify(descriptor(record));
    // Acceptance is independent of subprocess lifetime, including when all slots are occupied.
    queueMicrotask(() => this.pump());
    return descriptor(record);
  }
  async send({ id, text }) {
    if (this.closed) throw new Error("Subagent manager is closed");
    if (typeof text !== "string" || !text.trim()) throw new Error("Subagent text must be nonempty");
    const record = this.get(id);
    if (record.status === "queued") {
      (record.instructions ||= []).push(text);
      this.publish(record);
      return { ...descriptor(record), delivery: "queued", note: "Saved in order for launch; not yet consumed." };
    }
    const runtime = this.running.get(id);
    if (record.status === "stopping" || runtime?.cancelled) throw new Error("This child is stopping; the instruction was not sent");
    if (runtime) {
      await runtime.ready;
      if (runtime.cancelled || runtime.failure) throw new Error(runtime.failure || "This child was cancelled; the instruction was not sent");
      if (!runtime.inputClosing && !runtime.finished) {
        // Unlike raw steer, prompt+steer starts a retained turn if Pi became idle before receipt.
        const disposition = await runtime.prompt(text);
        if (runtime.cancelled) throw new Error("Child cancelled after send; instruction consumption is unknown");
        return { ...descriptor(record), delivery: disposition, note: "Pi acknowledged the instruction; this is not proof of consumption or completion." };
      }
      const result = await runtime.done;
      if (result.status !== "succeeded") throw new Error(`Child ${result.status} during send; instruction was not replayed: ${result.error || "unknown outcome"}`);
      return this.send({ id, text });
    }
    const child = await this.start({ resume: id, task: text });
    return { ...child, delivery: "queued", note: "Retained follow-up accepted with the same transcript and settings; not yet consumed." };
  }
  pump() {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (this.running.size + this.unresolved.size >= CONCURRENCY) break;
      if (record.status !== "queued") continue;
      const runtime = { cancelled: false, failure: undefined };
      runtime.ready = new Promise((resolve, reject) => { runtime.accepted = resolve; runtime.rejected = reject; });
      runtime.ready.catch(() => {});
      this.running.set(record.id, runtime);
      runtime.done = this.execute(record, runtime).finally(() => { this.running.delete(record.id); this.pump(); });
      // Every run also has a caller-independent rejection handler.
      runtime.done.catch(() => {});
    }
  }
  monitorProcesses() {
    if (!this.running.size) return;
    let rows;
    try { rows = processTable(); }
    catch (error) {
      for (const runtime of this.running.values()) runtime.fail(error);
      return;
    }
    for (const [id, runtime] of this.running) {
      if (!runtime.child || runtime.finished) continue;
      try {
        const record = this.get(id);
        const before = JSON.stringify(record.processes);
        observeTree(record, rows);
        if (JSON.stringify(record.processes) !== before) this.persist(record);
      } catch (error) { runtime.fail(error); }
    }
  }
  async terminate(record, runtime) {
    if (runtime.termination) return runtime.termination;
    runtime.termination = (async () => {
      try {
        let tree;
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          tree = observeTree(record);
          this.persist(record);
          signalTree(tree, signal);
          const deadline = Date.now() + 1500;
          do {
            tree = observeTree(record);
            // A process can exit during observation; wait for a consistent ownership snapshot.
            if (!tree.live.length && !tree.uncertain) return;
            await delay(process.platform === "darwin" ? 200 : 30);
          } while (Date.now() < deadline);
        }
        return tree.live.length
          ? "Child processes remain alive after SIGKILL; resume remains blocked"
          : "Child process ownership is uncertain; resume remains blocked";
      } catch (error) { return `Unable to verify child cleanup: ${message(error)}`; }
    })();
    return runtime.termination;
  }
  async execute(record, runtime) {
    let progress;
    let shutdownTimer;
    let child;
    let closeObserved = false;
    let closed;
    let exitCode;
    let exitSignal;
    let stderr = "";
    let cleanupError;
    const pending = new Map();
    const rejectPending = error => {
      runtime.rejected(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
    };
    const changed = () => {
      if (progress || runtime.finished) return;
      progress = setTimeout(() => {
        progress = undefined;
        this.notify(descriptor(record));
      }, 200);
    };
    const fail = error => {
      runtime.failure ||= message(error);
      rejectPending(new Error(runtime.failure));
      if (child) void this.terminate(record, runtime);
    };
    runtime.fail = fail;
    const finishInput = () => {
      if (!runtime.promptAccepted || !reader.ended || pending.size || runtime.inputClosing || runtime.failure || runtime.cancelled) return;
      runtime.inputClosing = true;
      child.stdin.end();
      shutdownTimer = setTimeout(() => fail(new Error("Pi did not exit after settled RPC shutdown")), 5000);
    };
    const reader = new EventReader(record, changed, event => {
      if (event.type === "response") {
        const request = pending.get(event.id);
        if (!request || event.command !== "prompt" || typeof event.success !== "boolean") throw new Error("Uncorrelated or invalid Pi RPC response");
        pending.delete(event.id);
        clearTimeout(request.timer);
        if (!event.success) {
          const error = new Error(`Pi rejected prompt ${event.id}: ${event.error || "unknown error"}`);
          request.reject(error);
          if (request.initial) fail(error);
        } else {
          const disposition = event.data?.disposition;
          if (!["started", "queued", "handled"].includes(disposition) || (request.initial && disposition !== "started")) {
            const error = new Error(`Unexpected Pi prompt disposition: ${disposition || "missing"}`);
            request.reject(error);
            fail(error);
          } else {
            // Pi emits a started acknowledgement before that run's agent_start/agent_settled.
            if (disposition === "started") {
              reader.ended = false;
              reader.seenAssistant = false;
              reader.stopReason = undefined;
              reader.assistantError = undefined;
            }
            if (request.initial) { runtime.promptAccepted = true; runtime.accepted(); }
            request.resolve(disposition);
          }
        }
      }
      finishInput();
    });
    runtime.prompt = (instruction, initial = false) => {
      if (runtime.inputClosing || runtime.finished || runtime.cancelled || runtime.failure) return Promise.reject(new Error("Pi RPC is no longer accepting instructions"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`Pi prompt acknowledgement timed out (${id}); acceptance is unknown`)), 30000);
        pending.set(id, { resolve, reject, timer, initial });
        // Node's write queue preserves order and its callback reports pipe failure.
        child.stdin.write(JSON.stringify({ id, type: "prompt", message: instruction, streamingBehavior: "steer" }) + "\n", error => { if (error) fail(error); });
      });
    };
    try {
      const childDir = join(this.root, record.id);
      const sessionPath = join(childDir, "session.jsonl");
      regularFile(sessionPath);
      const env = { ...this.command.env };
      delete env.HC_TERMINAL_ID;
      const slash = record.model.indexOf("/");
      const args = [...this.command.args, "--mode", "rpc", "--no-extensions", "--provider", record.model.slice(0, slash), "--model", record.model.slice(slash + 1), "--thinking", record.thinking, "--session", sessionPath, "--session-dir", childDir, "--append-system-prompt", childInstructions];
      record.status = "running";
      // A crash between spawn and identity persistence must never silently permit another writer.
      record.launchPending = true;
      this.publish(record);
      child = spawn(this.command.executable, args, { cwd: record.cwd, env, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      runtime.child = child;
      let exited;
      const exit = new Promise(resolve => { exited = resolve; });
      closed = new Promise(resolve => child.once("close", () => { closeObserved = true; resolve(); }));
      child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; exited(); });
      child.once("error", error => { runtime.failure ||= message(error); exited(); });
      const stderrPath = join(childDir, `run-${record.run}.stderr.log`);
      regularFile(stderrPath);
      child.stdout.on("data", chunk => {
        try {
          if (!runtime.failure) reader.push(chunk);
        } catch (error) { fail(error); }
      });
      child.stdout.once("end", () => { if (!runtime.failure) { try { reader.push(undefined, true); } catch (error) { fail(error); } } });
      child.stdout.on("error", fail);
      child.stderr.on("error", fail);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        stderr = (stderr + chunk).slice(-32768);
        try { appendFileSync(stderrPath, chunk, { mode: 0o600 }); } catch (error) { fail(error); }
      });
      child.stdin.on("error", fail);
      if (child.pid) {
        record.processes = [{ ...processIdentity(child.pid), group: child.pid }];
        record.launchPending = false;
        this.persist(record);
      } else { record.launchPending = false; this.persist(record); }
      const instruction = [record.task, ...(record.instructions || [])].join("\n\n");
      void runtime.prompt(instruction, true).catch(fail);
      if (runtime.cancelled) void this.terminate(record, runtime);
      await exit;
      if (!runtime.cancelled && (pending.size || !runtime.promptAccepted)) runtime.failure ||= "Pi exited before a correlated prompt acknowledgement; acceptance is unknown";
      rejectPending(new Error(runtime.failure || (runtime.cancelled ? "Child cancelled; instruction consumption is unknown" : "Pi exited before acknowledging the instruction")));
      cleanupError = await this.terminate(record, runtime);
    } catch (error) {
      runtime.failure ||= message(error);
      if (child) cleanupError = await this.terminate(record, runtime);
      else record.launchPending = false;
    } finally {
      clearTimeout(shutdownTimer);
      rejectPending(new Error(runtime.failure || (runtime.cancelled ? "Child cancelled; instruction consumption is unknown" : "Pi RPC closed")));
      if (child && !closeObserved) {
        await Promise.race([closed, delay(1000)]);
        if (!closeObserved) {
          cleanupError ||= "Child stdio did not close after process cleanup; ownership remains uncertain";
          record.launchPending = true;
          child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        }
      }
      runtime.finished = true;
      clearTimeout(progress);
      record.activity = undefined;
      record.error = cleanupError || runtime.failure || (exitSignal ? `Pi terminated by ${exitSignal}` : exitCode !== 0 ? `Pi exited with code ${exitCode ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}` : reader.failure());
      if (cleanupError || record.launchPending) record.status = "interrupted";
      else if (runtime.cancelled) { record.status = "cancelled"; record.error = runtime.failure || "Cancelled by parent"; }
      else record.status = record.error ? "failed" : "succeeded";
      if (record.error && stderr.trim() && !record.error.includes(stderr.trim())) record.error += `\n${stderr.trim()}`;
      if (record.status === "interrupted") this.unresolved.add(record.id);
      else this.unresolved.delete(record.id);
      this.publish(record);
    }
    return descriptor(record);
  }
  async stop(id) {
    const record = this.get(id);
    const runtime = this.running.get(id);
    if (runtime) {
      runtime.cancelled = true;
      record.status = "stopping";
      let publishError;
      try { this.publish(record); } catch (error) { publishError = error; }
      await this.terminate(record, runtime);
      const result = await runtime.done;
      if (publishError) throw publishError;
      return result;
    }
    if (record.status === "queued") {
      record.status = "cancelled";
      record.error = "Cancelled before launch";
      this.publish(record);
    } else {
      const tree = observeTree(record);
      if (tree.live.length || tree.uncertain || record.launchPending) {
        const cleanupError = await this.terminate(record, {});
        record.status = cleanupError || record.launchPending ? "interrupted" : "cancelled";
        record.error = cleanupError || (record.launchPending ? "Launch ownership is unknown; cannot safely resume this child" : "Interrupted child work was stopped");
        if (record.status === "interrupted") this.unresolved.add(id);
        else this.unresolved.delete(id);
        this.publish(record);
      } else this.unresolved.delete(id);
    }
    this.pump();
    return descriptor(record);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.monitor);
    this.closing = (async () => {
      try {
        const results = await Promise.allSettled([...this.records.keys()].map(id => this.stop(id)));
        const rejected = results.find(value => value.status === "rejected");
        if (rejected) throw rejected.reason;
      } finally { this.lock.release(); }
    })();
    return this.closing;
  }
}
