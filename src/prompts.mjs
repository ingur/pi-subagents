export const MESSAGE_TYPE = "pi-subagents.completion";
export const WAKE_TYPE = "pi-subagents.wake";

export const toolDescriptions = {
  start: "Start a background subagent on a task and return at once with its id. The subagent has none of this conversation and only the built-in tools, not tools added by extensions. Its result arrives as a notice when it finishes.",
  send: "Send a further instruction to a subagent. A running subagent takes it into its current work. A finished one continues with its earlier context and reports again when done.",
  list: "List your subagents with their status.",
  result: "Read a subagent's latest output, for example to check on one that is still running. A completion notice already contains the result. Long output is cut; the full text is in the file at resultPath.",
  stop: "Stop a subagent. Edits it has already made stay.",
};

export const parameterDescriptions = {
  task: "Complete instructions: the goal, the files it may change, how to check the work, and what to report.",
  cwd: "Directory to work in. Defaults to yours.",
  model: "Exact \"provider/model\". Defaults to yours. Models added by extensions are not available.",
  thinking: "Reasoning effort. Defaults to yours.",
  id: "Subagent id from subagent_start or subagent_list.",
  text: "The instruction.",
};

export const parentInstructions = `subagent_start runs a task in a background subagent while you keep working. Use it for self-contained work that can run alongside yours, such as a review, a search, or an isolated change.
A subagent starts with none of this conversation; the task text is all it knows. It works in the same files as you, so give each subagent files that nothing else is editing.
When a subagent finishes, its result arrives here as a notice and starts your next turn, so carry on or end your turn instead of polling. The result is the subagent's own account; check what matters before you report it as done.`;

export const childInstructions = `You are a subagent doing one task for another agent, the parent. Nobody reads your messages while you work. Only your final message is returned to the parent, so put the whole result there.
You have the task text and this repository's usual context, not the parent's conversation. If something essential is missing, say so in your result instead of guessing.
You share the working files with the parent and possibly other agents. Change only what the task covers and leave other changes alone. Unless the task says otherwise, do not commit, install dependencies, change global configuration, or start other agents or long-running services, because the parent cannot see or clean those up.
End with what you did or found, the files involved, the checks you actually ran and their outcome, and anything left undone or uncertain.`;

export const notes = {
  started: "Its result will arrive as a notice when it finishes.",
  paused: "Results will not start a turn by themselves until the user sends a message. Read them with subagent_result.",
};

export const wakeInstruction = "Subagent results are in the notices above. Continue your task with them. Anything the user has said since comes first.";

export const help = [
  "/subagents (list/status)",
  "/subagents list",
  "/subagents result ID",
  "/subagents stop ID",
  "/subagents forget ID (drop a finished or stuck subagent and free its slot)",
  "An aborted turn, or a failed or unclear turn on subagent results, pauses automatic wakes until you send a message; Esc/Ctrl+C while idle does not.",
  "Completions replayed after start/reload are shown without waking the parent; new starts and follow-ups can wake normally.",
  "Quitting, /reload, /new, /resume, /fork and /clone stop running subagents. Subagents use your normal login, context and skills, but no extensions.",
].join("\n");

const OUTPUT_LIMIT = 8000;
const ERROR_LIMIT = 2000;

export function shortText(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function preview(child) {
  const output = child.output ?? "", error = child.error ?? "";
  return { output: output.slice(0, OUTPUT_LIMIT), error: error.slice(0, ERROR_LIMIT), cut: output.length > OUTPUT_LIMIT || error.length > ERROR_LIMIT };
}

export function compactChild(child) {
  return {
    id: child.id, status: child.status, task: shortText(child.task, 80),
    ...(child.activity ? { activity: shortText(child.activity) } : {}),
    ...(child.error ? { error: shortText(child.error, 300) } : {}),
  };
}

export function boundedResult(child) {
  const { output, error, cut } = preview(child);
  return {
    id: child.id, status: child.status,
    ...(child.activity ? { activity: shortText(child.activity) } : {}),
    output,
    ...(error ? { error } : {}),
    ...(cut ? { truncated: true, resultPath: child.resultPath, note: "The output above is cut. The full text is in the file at resultPath." } : {}),
  };
}

export function formatCompletion(child, replayed) {
  const { output, error, cut } = preview(child);
  const run = child.run > 1 ? `, follow-up ${child.run - 1}` : "";
  return [
    `Result from subagent ${child.id}${run} (your background agent, not the user): ${child.status}.\nTask: ${shortText(child.task)}`,
    error && `Error: ${error}`,
    output || "The subagent returned no text.",
    cut && `The output above is cut. Full output: ${child.resultPath}`,
    replayed && "This result is from before a restart and may already have been handled.",
  ].filter(Boolean).join("\n\n");
}
