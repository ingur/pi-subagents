import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicJSON } from "../src/lib/state.mjs";
import { ownerState, processIdentity } from "../src/lib/process.mjs";
import { capturePiCommand } from "../src/command.mjs";
import { SubagentManager } from "../src/runner.mjs";

// This is a CLI protocol/process fixture, not provider integration evidence.
const fixture = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
let batch;
const emit = value => {
  const line = JSON.stringify(value) + "\n";
  if (batch) batch.push(line); else process.stdout.write(line);
};
const session = arg("--session");
const directory = path.dirname(session);
const old = fs.existsSync(session) ? fs.readFileSync(session, "utf8") : "";
const prompts = [];
let config, buffer = "", active = false;
function save(name, text) {
  const file = path.join(directory, name);
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
}
function gate(name, resume) {
  const file = path.join(directory, name);
  const watcher = fs.watch(directory, () => {
    if (fs.existsSync(file)) { watcher.close(); resume(); }
  });
  save(name + ".ready", "");
}
const acknowledge = (command, disposition) => emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition } });
function begin() {
  active = true;
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial α" } });
}
function end(settled = true, output) {
  const message = { role: "assistant", content: config.empty ? [] : [{ type: "text", text: output || "first α" }, { type: "thinking", thinking: "private" }, { type: "text", text: config.echo ? prompts.map(value => value.message).join("\n") : old ? "retained follow-up" : "second" }], stopReason: config.reason || "stop", ...(config.error ? { errorMessage: config.error } : {}) };
  emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: [...(config.largeEnd ? [{ role: "toolResult", content: [{ type: "image", data: "x".repeat(20 * 1024 * 1024) }] }] : []), message] });
  if (settled) { active = false; emit({ type: "agent_settled", aborted: config.aborted || false }); }
}
function receive(command) {
  if (command.type !== "prompt" || command.streamingBehavior !== "steer" || !command.id) throw new Error("Invalid native prompt command");
  prompts.push(command);
  if (!config) config = command.message.startsWith("CASE:") ? JSON.parse(command.message.slice(5).split("\n\n")[0]) : {};
  if (!old && prompts.length === 1) fs.writeFileSync(session, JSON.stringify({ type: "session", id: crypto.randomUUID(), cwd: process.cwd() }) + "\n");
  fs.appendFileSync(session, JSON.stringify({ type: "message", message: { role: "user", content: command.message } }) + "\n");
  save("capture.json", JSON.stringify({ args, task: prompts[0].message, prompts, old, env: { terminal: process.env.HC_TERMINAL_ID, secret: process.env.OPENAI_API_KEY, profile: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR } }));
  if (prompts.length > 1) {
    if (config.rejectSend) { emit({ type: "response", id: command.id, command: "prompt", success: false, error: "send rejected" }); end(); return; }
    if (config.sendExit) { process.exit(0); }
    if (config.sendHoldAck) return;
    if (config.raceSend) {
      end();
      acknowledge(command, "started");
      begin();
      if (config.noReplySend) { active = false; emit({ type: "agent_settled", aborted: false }); }
      else end();
    } else {
      acknowledge(command, active ? "queued" : "started");
      if (!active) { begin(); end(); }
    }
    return;
  }
  if (config.rejectPrompt) {
    batch = [];
    emit({ type: "response", id: command.id, command: "prompt", success: false, error: "prompt rejected" });
    begin(); end();
    process.stdout.write(batch.join(""));
    batch = undefined;
    return;
  }
  if (config.wrongId) acknowledge({ id: "unrelated" }, "started");
  else if (!config.missingAck) acknowledge(command, config.handled ? "handled" : "started");
  begin();
  if (config.hold) {
    process.on("SIGTERM", () => {});
    const child = cp.spawn("bash", ["-c", 'trap "" TERM; sleep 60 & echo "$!" > "$1"; wait', "fixture", path.join(directory, "grandchild.pid")], { detached: true, stdio: "ignore" });
    save("descendant.pid", String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (config.malformed) { process.stdout.write("not JSON\n"); setInterval(() => {}, 1000); return; }
  if (config.signal) { process.kill(process.pid, "SIGKILL"); return; }
  if (config.raceSend || config.rejectSend || config.sendExit) return;
  if (config.retry) {
    end(false);
    gate("retry", () => { emit({ type: "auto_retry_start" }); begin(); end(true, "retry α"); });
    return;
  }
  if (config.progressGate) { gate("progress", () => end()); return; }
  end(!config.noSettled);
  if (config.stderr) process.stderr.write(config.stderr);
  if (config.missingAck || config.noSettled || config.exit) process.exit(config.exit || 0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    receive(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  save("stdin-ended.json", JSON.stringify({ active }));
  if (active) process.exitCode = 19;
  if (config.shutdownGate) gate("shutdown", () => {});
});
`;

async function until(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const finished = (manager, id) => until(() => {
  const value = manager.result(id);
  return !["queued", "running", "stopping"].includes(value.status) && value;
}, "finished child");
const launch = (cwd, task = "task") => ({ title: "title", cwd, task, model: "test/exact-model", thinking: "off" });
const scenario = value => `CASE:${JSON.stringify(value)}`;

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-")));
  const cwd = join(root, "work");
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  for (const directory of [cwd, bin, stateDir]) mkdirSync(directory);
  writeFileSync(join(bin, "pi"), fixture, { mode: 0o700 });
  const command = capturePiCommand({ execPath: process.execPath, execArgv: [], argv: [process.execPath, join(bin, "pi")],
    env: { ...process.env, PATH: process.env.PATH, HC_TERMINAL_ID: "parent-only", OPENAI_API_KEY: "fixture-key-not-a-credential",
      PI_CODING_AGENT_DIR: join(root, "normal-agent-home"), PI_CODING_AGENT_SESSION_DIR: join(root, "normal-sessions") } });
  const managers = [];
  const owner = randomUUID();
  const create = onChange => {
    const manager = new SubagentManager({ stateDir, owner, onChange, command });
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    try { for (const manager of managers) await manager.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, cwd, stateDir, owner, create, command };
}

test("literal stdin, normal resources, captured Pi command and retained attempt identities", async t => {
  const { root, cwd, stateDir, owner, create } = setup(t);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
  const manager = create(() => { throw new Error("UI callback failure"); });
  assert.throws(() => create(), /owner|lock/i);
  const task = "  @/definitely-not-a-file --session /not-allowed\n$HOME; echo unsafe\u2028keep Unicode  ";
  const accepted = await manager.start({ ...launch(cwd, task), thinking: "max" });
  assert.equal(accepted.run, 1);
  const first = await finished(manager, accepted.id);
  assert.equal(first.status, "succeeded");
  assert.equal(first.output, "first α\nsecond");
  assert.equal(first.task, task);
  const childDir = join(stateDir, owner, first.id);
  const capture = JSON.parse(readFileSync(join(childDir, "capture.json"), "utf8"));
  assert.equal(capture.task, task);
  assert(!capture.args.includes(task));
  assert.equal(capture.args[capture.args.indexOf("--mode") + 1], "rpc");
  assert(!capture.args.includes("--print"));
  assert.equal(capture.args[capture.args.indexOf("--session") + 1], join(childDir, "session.jsonl"));
  assert(capture.args.includes("--no-extensions"));
  for (const flag of ["--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) assert(!capture.args.includes(flag));
  assert.equal(capture.env.terminal, undefined);
  assert.equal(capture.env.secret, "fixture-key-not-a-credential");
  assert.equal(capture.env.profile, join(root, "normal-agent-home"));
  assert.equal(capture.env.sessions, join(root, "normal-sessions"));
  assert.equal(capture.args[capture.args.indexOf("--session-dir") + 1], childDir);
  assert.throws(() => manager.result(randomUUID()), /Unknown subagent/);
  await assert.rejects(manager.start({ task: "follow", resume: first.id, model: first.model }), /override/);
  const savedFirst = readFileSync(first.resultPath, "utf8");
  const second = await manager.send({ id: first.id, text: "follow-up" });
  assert.equal(second.delivery, "queued");
  assert.equal(second.id, first.id);
  assert.deepEqual([first.title, second.title], ["title", "title"]);
  assert.equal(second.run, 2);
  assert.equal(second.cwd, first.cwd);
  assert.equal(second.model, first.model);
  assert.equal(second.thinking, first.thinking);
  const final = await finished(manager, second.id);
  assert.equal(final.output, "first α\nretained follow-up");
  assert.notEqual(final.resultPath, first.resultPath);
  assert.equal(readFileSync(first.resultPath, "utf8"), savedFirst);
  assert.equal(manager.list().length, 1);
  await manager.close();
  const replay = [];
  const reopened = create(value => replay.push(value));
  await Promise.resolve();
  assert.deepEqual(replay.map(value => `${value.id}:${value.run}`), [`${first.id}:1`, `${first.id}:2`]);
  assert.equal(reopened.result(first.id).run, 2);
});

test("queued cancellation and acknowledged steering preserve ownership until process-group cleanup", async t => {
  const { cwd, stateDir, owner, create } = setup(t);
  const manager = create();
  const children = [];
  for (let i = 0; i < 5; i++) children.push(await manager.start(launch(cwd, scenario({ hold: true }))));
  assert.equal(manager.list().filter(value => value.status === "running").length, 4);
  assert.equal(manager.result(children[4].id).status, "queued");
  await assert.rejects(manager.start({ resume: children[0].id, task: "overlap" }), /already working/);
  const queued = await manager.stop(children[4].id);
  assert.equal(queued.status, "cancelled");
  assert(!existsSync(join(stateDir, owner, queued.id, "session.jsonl")));
  const firstDir = join(stateDir, owner, children[0].id);
  await until(() => existsSync(join(firstDir, "descendant.pid")), "detached tool process");
  const descendant = processIdentity(Number(readFileSync(join(firstDir, "descendant.pid"), "utf8")));
  await until(() => existsSync(join(firstDir, "grandchild.pid")) && readFileSync(join(firstDir, "grandchild.pid"), "utf8").trim(), "bash descendant");
  const grandchild = processIdentity(Number(readFileSync(join(firstDir, "grandchild.pid"), "utf8")));
  const sent = await manager.send({ id: children[0].id, text: "finish this tool, then inspect the result" });
  assert.equal(sent.run, 1);
  assert.equal(sent.delivery, "queued");
  assert.equal(ownerState(descendant), "live");
  const capture = JSON.parse(readFileSync(join(firstDir, "capture.json"), "utf8"));
  assert.equal(capture.prompts[1].message, "finish this tool, then inspect the result");
  assert.notEqual(capture.prompts[0].id, capture.prompts[1].id);
  const stopped = await manager.stop(children[0].id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.output, "partial α");
  assert.equal(ownerState(descendant), "dead");
  assert.equal(ownerState(grandchild), "dead");
  assert.deepEqual(await manager.stop(stopped.id), stopped);
  await manager.close();
  assert(manager.list().every(value => value.status === "cancelled"));
  await assert.rejects(manager.start(launch(cwd)), /closed/);
});

test("JSON errors, partial output, stop reasons, signal and nonzero exits cannot become success", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  for (const config of [
    { reason: "error", error: "authentication rejected", empty: true },
    { reason: "aborted", empty: true },
    { reason: "length" },
    { exit: 7, stderr: "CLI failure details" },
    { signal: true },
    { malformed: true },
    { wrongId: true },
    { missingAck: true },
    { handled: true },
    { aborted: true },
    { noSettled: true },
  ]) {
    const child = await manager.start(launch(cwd, scenario(config)));
    const result = await finished(manager, child.id);
    assert.equal(result.status, "failed", `${JSON.stringify(config)}: ${result.error}`);
    assert(result.error);
    if (!config.wrongId && !config.handled) assert(result.output.includes("α"));
    if (config.error) assert.match(result.error, /authentication rejected/);
    if (config.stderr) assert.match(result.error, /CLI failure details/);
    if (config.malformed) assert.match(result.error, /Invalid Pi JSON/);
    assert.equal(JSON.parse(readFileSync(result.resultPath, "utf8")).output, result.output);
  }
});

test("a rejected initial prompt stays failed when successful completion events follow in the same burst", async t => {
  const { cwd, create } = setup(t), manager = create();
  const child = await manager.start(launch(cwd, scenario({ rejectPrompt: true })));
  const result = await finished(manager, child.id);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Pi rejected prompt/);
  assert.equal(JSON.parse(readFileSync(result.resultPath, "utf8")).status, "failed");
});

test("dead-owner recovery interrupts queued work without replay and validates retained paths", async t => {
  const { cwd, stateDir, owner, create } = setup(t);
  const manager = create();
  const started = await manager.start(launch(cwd));
  const result = await finished(manager, started.id);
  await manager.close();
  const original = JSON.parse(readFileSync(result.resultPath, "utf8"));
  atomicJSON(dirname(result.resultPath), "run-2.json", { ...original, title: undefined, run: 2, status: "queued", task: "must not replay", output: "", resultPath: join(dirname(result.resultPath), "run-2.json"), processes: [] });
  const replay = [];
  const recovered = create(value => replay.push(value));
  await Promise.resolve();
  assert.equal(recovered.result(result.id).status, "interrupted");
  assert.match(recovered.result(result.id).error, /incomplete/);
  assert.equal(recovered.result(result.id).title, "must not replay");
  assert.equal(replay.length, 2);
  assert.equal(JSON.parse(readFileSync(join(dirname(result.resultPath), "capture.json"), "utf8")).task, "task");
  const sessionPath = join(stateDir, owner, result.id, "session.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: randomUUID(), cwd: "/wrong" }) + "\n");
  await assert.rejects(recovered.start({ resume: result.id, task: "follow" }), /saved conversation is invalid/);
  await assert.rejects(recovered.start({ resume: "../../other", task: "follow" }), /UUID/);
  await assert.rejects(recovered.start({ ...launch(cwd), cwd: `${cwd}/..` }), /canonical/);
  await assert.rejects(recovered.start({ ...launch(cwd), title: " " }), /title must be nonempty/);
});

test("restart detects live orphaned work, blocks duplicate writers, and permits stop then retained follow-up", async t => {
  const { root, cwd, stateDir, owner, create } = setup(t);
  const ready = join(root, "orphan-ready.json");
  const launcherPath = join(root, "crash-parent.mjs");
  const runnerPath = fileURLToPath(new URL("../src/runner.mjs", import.meta.url));
  writeFileSync(launcherPath, `import { SubagentManager } from ${JSON.stringify(runnerPath)};
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const manager = new SubagentManager(${JSON.stringify({ stateDir, owner, command: { executable: process.execPath, args: [join(root, "bin", "pi")], env: process.env } })});
const child = await manager.start(${JSON.stringify(launch(cwd, scenario({ hold: true })))});
const directory = dirname(child.resultPath), grandchild = join(directory, "grandchild.pid");
await new Promise(resolve => {
  const check = () => { if (existsSync(grandchild) && readFileSync(grandchild, "utf8").trim()) { watcher.close(); resolve(); } };
  const watcher = watch(directory, check);
  check();
});
manager.monitorProcesses();
writeFileSync(${JSON.stringify(ready)}, JSON.stringify(manager.result(child.id)));
process.exit(0);
`);
  const parent = spawn(process.execPath, [launcherPath], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  parent.stderr.setEncoding("utf8");
  parent.stderr.on("data", chunk => stderr += chunk);
  const exitCode = await new Promise((resolve, reject) => { parent.once("error", reject); parent.once("exit", resolve); });
  assert.equal(exitCode, 0, stderr);
  const child = JSON.parse(readFileSync(ready, "utf8"));
  const recovered = create();
  assert.equal(recovered.result(child.id).status, "interrupted");
  await assert.rejects(recovered.start({ resume: child.id, task: "overlap" }), /may still have processes/);
  assert.equal((await recovered.stop(child.id)).status, "cancelled");
  const next = await recovered.start({ resume: child.id, task: "follow-up" });
  assert.equal(next.run, 2);
  assert.equal((await finished(recovered, child.id)).status, "succeeded");
  assert.equal(readdirSync(join(stateDir, owner)).filter(name => name === child.id).length, 1);
});

test("missing captured executable is a launch failure, not a successful empty response", async t => {
  const { cwd, root, create, command } = setup(t);
  command.executable = join(root, "missing-pi");
  const manager = create();
  const accepted = await manager.start(launch(cwd));
  const result = await finished(manager, accepted.id);
  assert.equal(result.status, "failed");
  assert.match(result.error, /ENOENT/);
  assert.equal(result.output, "");
});

test("uncertain spawn ownership is never cleared by restart or an unverified stop", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const started = await manager.start(launch(cwd));
  const result = await finished(manager, started.id);
  await manager.close();
  const record = JSON.parse(readFileSync(result.resultPath, "utf8"));
  atomicJSON(dirname(result.resultPath), "run-1.json", { ...record, status: "running", launchPending: true, processes: [] });
  const recovered = create();
  assert.equal(recovered.result(result.id).status, "interrupted");
  await assert.rejects(recovered.start({ resume: result.id, task: "unsafe follow-up" }), /may still have processes/);
  assert.equal((await recovered.stop(result.id)).status, "interrupted");
  await assert.rejects(recovered.start({ resume: result.id, task: "still unsafe" }), /may still have processes/);
});

test("forget frees the slot of a stuck subagent and is refused while its processes live", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const stuck = await finished(manager, (await manager.start(launch(cwd))).id);
  const alive = await finished(manager, (await manager.start(launch(cwd))).id);
  await manager.close();
  const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  t.after(() => sleeper.kill("SIGKILL"));
  const saved = child => JSON.parse(readFileSync(child.resultPath, "utf8"));
  atomicJSON(dirname(stuck.resultPath), "run-1.json", { ...saved(stuck), status: "running", launchPending: true, processes: [] });
  atomicJSON(dirname(alive.resultPath), "run-1.json", { ...saved(alive), status: "running", processes: [{ ...processIdentity(sleeper.pid), group: sleeper.pid }] });
  const recovered = create();
  assert.throws(() => recovered.forget(alive.id), /stop it first/);
  for (let i = 0; i < 2; i++) await recovered.start(launch(cwd, scenario({ hold: true })));
  const waiting = await recovered.start(launch(cwd));
  assert.equal(recovered.result(waiting.id).status, "queued", "two stuck records and two running fill the slots");
  recovered.forget(stuck.id);
  assert.equal(existsSync(dirname(stuck.resultPath)), false);
  assert.throws(() => recovered.result(stuck.id), /Unknown subagent/);
  assert.equal((await finished(recovered, waiting.id)).status, "succeeded");
  sleeper.kill("SIGKILL");
  await new Promise(resolve => sleeper.once("exit", resolve));
  recovered.forget(alive.id);
  assert.equal(recovered.list().some(child => child.id === alive.id), false);
});

test("boot identity prevents stale PID metadata from claiming a new process", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const started = await manager.start(launch(cwd));
  const result = await finished(manager, started.id);
  await manager.close();
  const record = JSON.parse(readFileSync(result.resultPath, "utf8"));
  const current = processIdentity();
  atomicJSON(dirname(result.resultPath), "run-1.json", { ...record, status: "running", processes: [{ ...current, boot: "different-boot", group: current.pid }] });
  const recovered = create();
  assert.match(recovered.result(result.id).error, /incomplete/);
  await recovered.stop(result.id);
  assert.equal(ownerState(current), "live");
  const next = await recovered.start({ resume: result.id, task: "safe follow-up" });
  assert.equal((await finished(recovered, next.id)).status, "succeeded");
});

test("agent_end does not close RPC before automatic retry and agent_settled", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ retry: true })));
  const directory = dirname(child.resultPath);
  await until(() => existsSync(join(directory, "retry.ready")) && manager.result(child.id).output.includes("first"), "unsettled turn");
  assert.equal(manager.result(child.id).status, "running");
  assert.equal(existsSync(join(directory, "stdin-ended.json")), false);
  writeFileSync(join(directory, "retry"), "");
  const result = await finished(manager, child.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "retry α\nsecond");
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(result.resultPath), "stdin-ended.json"), "utf8")), { active: false });
});

test("queued sends are saved in order and included exactly once when a slot opens", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const busy = [];
  for (let i = 0; i < 4; i++) busy.push(await manager.start(launch(cwd, scenario({ hold: true }))));
  const child = await manager.start(launch(cwd, "original task"));
  assert.equal((await manager.send({ id: child.id, text: "first instruction" })).delivery, "queued");
  assert.equal((await manager.send({ id: child.id, text: "second instruction" })).delivery, "queued");
  assert.deepEqual(JSON.parse(readFileSync(child.resultPath, "utf8")).instructions, ["first instruction", "second instruction"]);
  await manager.stop(busy[0].id);
  const result = await finished(manager, child.id);
  assert.equal(result.status, "succeeded");
  const capture = JSON.parse(readFileSync(join(dirname(result.resultPath), "capture.json"), "utf8"));
  assert.equal(capture.task, "original task\n\nfirst instruction\n\nsecond instruction");
  assert.equal(capture.prompts.length, 1);
});

test("send racing agent_settled starts a retained native turn without premature EOF", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ raceSend: true, echo: true })));
  await until(() => manager.result(child.id).output.includes("partial"), "initial prompt acceptance");
  const sent = await manager.send({ id: child.id, text: "arrived while settling" });
  assert.equal(sent.delivery, "started");
  assert.equal(sent.run, 1);
  const result = await finished(manager, child.id);
  assert.equal(result.status, "succeeded");
  assert.match(result.output, /arrived while settling/);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(result.resultPath), "stdin-ended.json"), "utf8")), { active: false });
});

test("correlated send rejection is not acceptance and does not abort existing work", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ rejectSend: true })));
  await assert.rejects(manager.send({ id: child.id, text: "rejected instruction" }), /send rejected/);
  assert.equal((await finished(manager, child.id)).status, "succeeded");
});

test("exit before a send acknowledgement rejects uncertain delivery instead of succeeding", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ sendExit: true })));
  await assert.rejects(manager.send({ id: child.id, text: "unacknowledged instruction" }), /acknowledg|acceptance is unknown/);
  assert.equal((await finished(manager, child.id)).status, "failed");
});

test("cancelling an in-flight send rejects its waiter and never replays it", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ sendHoldAck: true, hold: true })));
  const sent = assert.rejects(manager.send({ id: child.id, text: "not acknowledged" }), /stopped|acknowledg|unknown/i);
  const capture = join(dirname(child.resultPath), "capture.json");
  await until(() => existsSync(capture) && JSON.parse(readFileSync(capture, "utf8")).prompts.length === 2, "pending send");
  const stopping = manager.stop(child.id);
  await assert.rejects(manager.send({ id: child.id, text: "cannot restart cancelled work" }), /stopping/);
  assert.equal((await stopping).status, "cancelled");
  await sent;
  assert.equal(manager.result(child.id).run, 1);
});

test("a settled-race continuation cannot reuse the previous turn's successful assistant", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ raceSend: true, noReplySend: true })));
  await until(() => manager.result(child.id).output.includes("partial"), "initial prompt acceptance");
  assert.equal((await manager.send({ id: child.id, text: "a new turn" })).delivery, "started");
  const result = await finished(manager, child.id);
  assert.equal(result.status, "failed");
  assert.match(result.error, /without a complete assistant response/);
});

test("send after settled EOF waits for cleanup before opening the retained transcript", async t => {
  const { cwd, create } = setup(t);
  const manager = create();
  const child = await manager.start(launch(cwd, scenario({ shutdownGate: true })));
  const directory = dirname(child.resultPath);
  await until(() => existsSync(join(directory, "shutdown.ready")), "settled EOF");
  const pending = manager.send({ id: child.id, text: "after EOF" });
  await Promise.resolve();
  assert.equal(manager.result(child.id).run, 1, "the next writer must wait for the old process");
  writeFileSync(join(directory, "shutdown"), "");
  const sent = await pending;
  assert.equal(sent.run, 2);
  assert.equal(sent.delivery, "queued");
  const result = await finished(manager, child.id);
  assert.equal(result.status, "succeeded");
  assert.match(result.output, /retained follow-up/);
});

test("a large agent_end is discarded without losing the authoritative assistant outcome", async t => {
  const { cwd, create } = setup(t), manager = create();
  for (const config of [{ largeEnd: true }, { largeEnd: true, reason: "error", error: "provider failed" }]) {
    const child = await manager.start(launch(cwd, scenario(config)));
    const result = await finished(manager, child.id);
    assert.equal(result.status, config.error ? "failed" : "succeeded");
    assert.equal(result.output, "first α\nsecond");
    assert.equal(result.error, config.error);
  }
});

test("streaming progress stays in memory and completion is durably published exactly once", async t => {
  const { cwd, create } = setup(t);
  const notices = [], activeAtCompletion = [];
  const manager = create(value => {
    notices.push(value);
    if (value.status === "succeeded") {
      activeAtCompletion.push(manager.list().some(child => ["queued", "running", "stopping"].includes(child.status)));
    }
  });
  const child = await manager.start(launch(cwd, scenario({ progressGate: true })));
  await until(() => notices.some(value => value.output === "partial α"), "streaming progress notice");
  const running = JSON.parse(readFileSync(child.resultPath, "utf8"));
  assert.equal(running.status, "running");
  assert.equal(running.version, 1);
  assert.equal(running.output, "", "progress alone must not rewrite durable metadata");
  writeFileSync(join(dirname(child.resultPath), "progress"), "");
  const result = await finished(manager, child.id);
  const saved = JSON.parse(readFileSync(child.resultPath, "utf8"));
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.output, result.output);
  assert.deepEqual(notices.filter(value => value.status === "succeeded"), [result]);
  assert.deepEqual(activeAtCompletion, [false], "the completion callback must see a terminal list entry");
  assert.deepEqual(manager.list(), [result]);
  assert.equal(manager.running.size, 0);
  assert.equal(manager.unresolved.size, 0);
});

test("captured command preserves Node arguments and the wrapper environment by value", () => {
  const host = { execPath: "/nix/store/node/bin/node", execArgv: ["--conditions=custom"],
    argv: ["node", "/nix/store/pi/cli.js", "--session", "/parent/session.jsonl"],
    env: { PATH: "/nix/store/tools/bin:/usr/bin", PI_CODING_AGENT_DIR: "/normal/home" } };
  const command = capturePiCommand(host);
  host.env.PATH = "/other/pi";
  host.execArgv.push("--other");
  assert.deepEqual(command, { executable: host.execPath, args: ["--conditions=custom", "/nix/store/pi/cli.js"],
    env: { PATH: "/nix/store/tools/bin:/usr/bin", PI_CODING_AGENT_DIR: "/normal/home" } });
});
