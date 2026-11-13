// Copied from pi-projects pi/, which no longer has a copy; this one is maintained here.
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

export interface EditorFocus {
  readonly focused: boolean;
  readonly focusUnavailable: boolean;
  release(): void;
}

interface EditorObservation {
  ctx: ExtensionContext;
  editor?: EditorComponent & { focused?: boolean };
  previous?: EditorFactory;
  wrapper?: EditorFactory;
  users: number;
}

// Pi loads each extension with moduleCache:false; share the observer across those module instances.
const key = Symbol.for("pi.extensions.editor-observer");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, EditorObservation> };
const editors = shared[key] ??= new Map<string, EditorObservation>();

export function observeEditor(ctx: ExtensionContext): EditorFocus {
  const id = ctx.sessionManager.getSessionId();
  let observation = editors.get(id);
  if (!observation) {
    observation = { ctx, users: 0, previous: ctx.ui.getEditorComponent() };
    editors.set(id, observation);
    const current = observation;
    try {
      current.wrapper = (tui, theme, keybindings) => {
        current.editor = current.previous?.(tui, theme, keybindings) ??
          new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
        return current.editor;
      };
      ctx.ui.setEditorComponent(current.wrapper);
    } catch (error) {
      editors.delete(id);
      throw error;
    }
  }
  observation.users++;
  const current = observation;
  let released = false;
  return {
    get focusUnavailable() {
      return current.ctx.ui.getEditorComponent() !== current.wrapper || typeof current.editor?.focused !== "boolean";
    },
    get focused() { return this.focusUnavailable || current.editor?.focused === true; },
    release() {
      if (released) return;
      released = true;
      if (--current.users === 0 && editors.get(id) === current) {
        editors.delete(id);
        if (current.ctx.ui.getEditorComponent() === current.wrapper) current.ctx.ui.setEditorComponent(current.previous);
      }
    },
  };
}
