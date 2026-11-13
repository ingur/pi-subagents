import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the observer without loading Pi or a terminal UI.
const source = stripTypeScriptTypes(readFileSync(new URL("../src/lib/interaction.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function observeEditor", "function observeEditor");

test("editor observation composes, restores the prior factory, and fails visibly open on replacement", () => {
  const observeEditor = runInNewContext(source + "\nobserveEditor;", {
    CustomEditor: class { focused = true; },
  });
  const editor = { focused: false }, previous = () => editor;
  let installed = previous, component;
  const ctx = { sessionManager: { getSessionId: () => "session" }, ui: {
    getEditorComponent: () => installed,
    setEditorComponent: factory => { installed = factory; component = factory?.(); },
  } };
  const first = observeEditor(ctx), second = observeEditor(ctx);
  assert.equal(component, editor);
  assert.equal(first.focusUnavailable, false);
  assert.equal(first.focused, false);
  editor.focused = true;
  assert.equal(first.focused, true);
  first.release();
  assert.notEqual(installed, previous);
  second.release();
  assert.equal(installed, previous);
  const third = observeEditor(ctx), replacement = () => ({ focused: false });
  ctx.ui.setEditorComponent(replacement);
  assert.equal(third.focusUnavailable, true);
  assert.equal(third.focused, true, "a detached observer must not block delivery forever");
  third.release();
  assert.equal(installed, replacement, "release cannot overwrite a newer editor");
});
