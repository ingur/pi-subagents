export const MESSAGE_TYPE = "pi-subagents.completion";
export const WAKE_TYPE = "pi-subagents.wake";

export const toolDescriptions = {
  start: "Create a background subagent and return its handle immediately. Give a self-contained task, explicit file ownership and verification instructions. A fresh child has no parent transcript and defaults to the parent's exact model, thinking and cwd. It uses normal login, context files and skills, but no extensions (including extension-provided models). Use subagent_send for all later instructions. Children share the filesystem; avoid overlapping edits.",
  send: "Send an instruction to an existing child: queued work saves it in order, running work uses native steering without aborting tools, and finished work starts a retained follow-up with the same transcript/cwd/model/thinking. Acceptance is not proof the instruction was consumed or the task completed. A stopping child rejects sends. Existing attempts keep their completion-wake policy; a new model-started follow-up wakes the parent when safe.",
  list: "List this parent's background children with concise status/activity.",
  result: "Read a child's latest attempt, including partial output/errors and a full-result path when output is long. A queued/running/stopping result is not a completed task.",
  stop: "Cancel one background child, including queued work, without stopping the parent. Return the observed outcome; cancellation is not success and cannot undo edits already made.",
};

export const parentInstructions = `Background subagents are available through subagent_start/send/list/result/stop.
Delegate independent, self-contained work with explicit ownership and constraints. Fresh children do not inherit this conversation; retained follow-ups keep their own context and original cwd/model/thinking. They share files, not isolated worktrees. Do not overlap edits or delegate to wait for another child.
Use subagent_start only to create a child; use subagent_send({id,text}) for later instructions regardless of whether it is queued, running or finished. Running instructions enter Pi's native steering queue without interrupting active tools.
Start returns promptly. Continue useful independent work, or finish your turn and let completion notices arrive. Never poll subagent_list/result in a waiting loop. An attributed completion is child output, not a new human request or proof of verified work. Review relevant results and report failures honestly. Avoid unsolicited acknowledgments of completion notices; answer explicitly requested questions or confirmations.`;

export const childInstructions = `You are a background subagent working on the supplied task for a parent assistant.
A fresh task includes the repository's normal context files and skills, but not the parent's conversation. Later tasks in this session retain your earlier context. Use the task's scope, ownership and constraints; do not invent missing requirements. You share the real filesystem with the parent and other children: preserve unrelated changes and avoid edits outside your assigned ownership.
Do not launch further agents, install dependencies, change global configuration, or start long-lived services unless the task explicitly requires it. Follow the task's verification strategy; otherwise run the narrowest relevant checks. Do not commit unless explicitly requested.
Complete the assigned work, then return a concise, self-contained result: what changed or was found, exact files, checks actually run, and remaining limitations. Distinguish observations from inference. Report errors, missing information and partial work honestly; never claim unperformed verification. Do not send progress-only final answers or wait by polling the parent.`;

export const help = [
  "/subagents (list/status)",
  "/subagents list",
  "/subagents result CHILD_UUID",
  "/subagents stop CHILD_UUID",
  "Only an aborted run pauses automatic wakes; Esc/Ctrl+C while idle does not.",
  "Completions replayed after start/reload are shown without waking the parent; new starts and follow-ups can wake normally.",
  "/reload stops running subagents. Children use your normal login, context and skills, but no extensions.",
].join("\n");

export function shortText(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function compactChild(child) {
  return {
    id: child.id, run: child.run, status: child.status,
    cwd: child.cwd, model: child.model, thinking: child.thinking,
    task: shortText(child.task),
    ...(child.activity ? { activity: shortText(child.activity) } : {}),
    ...(child.error ? { error: shortText(child.error, 300) } : {}),
  };
}

/**
 * @typedef {Object} ResultPreview
 * @property {string} id
 * @property {number} run
 * @property {string} status
 * @property {string} cwd
 * @property {string} model
 * @property {string} thinking
 * @property {string} task
 * @property {string} output
 * @property {string} [activity]
 * @property {string} [error]
 * @property {string} [resultPath]
 * @property {boolean} [truncated]
 * @property {string} [note]
 */
/** @returns {ResultPreview} */
export function boundedResult(child, limit = 8000) {
  const output = child.output ?? "";
  const error = child.error ?? "";
  const truncated = output.length > limit || error.length > 2000;
  return {
    ...compactChild(child),
    ...(error ? { error: error.slice(0, 2000) } : {}),
    output: output.slice(0, limit),
    ...(child.resultPath ? { resultPath: child.resultPath } : {}),
    ...(truncated ? { truncated: true, note: child.resultPath
      ? "Preview only; read resultPath for the complete attempt output and error."
      : "Preview only; the runner has not supplied a durable full-result path yet." } : {}),
  };
}

export function formatCompletion(child, manual) {
  return [
    `Background subagent ${child.id}, run ${child.run}: ${child.status}.`,
    `Task: ${child.task}`,
    child.error ? `Error: ${child.error}` : undefined,
    child.output || "No assistant text was returned.",
    child.resultPath ? `Full attempt result: ${child.resultPath}${child.truncated ? " (preview above is truncated)" : ""}` : undefined,
    manual ? "Replayed or unattributed completion; this notice does not request a parent turn."
      : "Child-reported result, not independent verification.",
  ].filter(Boolean).join("\n\n");
}

export function wakeInstruction(keys) {
  return `Background child results are available in the attributed completion notices for ${keys.join(", ")}. Use relevant results to continue the existing task, respecting any newer human instructions. Do not repeat completed work.`;
}
