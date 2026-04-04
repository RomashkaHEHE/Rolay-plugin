import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { MarkdownView, editorInfoField, type App, type Editor } from "obsidian";

export interface SharedCursorSelection {
  anchor: number;
  head: number;
}

export interface SharedCursorPresence {
  clientId: number;
  userId: string;
  displayName: string;
  color: string;
  selection: SharedCursorSelection;
}

export interface PresenceSelectionChangePayload {
  filePath: string;
  editor: Editor;
  focused: boolean;
}

const setRemotePresenceEffect = StateEffect.define<SharedCursorPresence[]>();

const remotePresenceField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(setRemotePresenceEffect)) {
        nextDecorations = buildRemotePresenceDecorations(transaction.state.doc.length, effect.value);
      }
    }

    return nextDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export function createSharedPresenceExtension(
  onSelectionChange: (payload: PresenceSelectionChangePayload) => void
): Extension {
  return [
    remotePresenceField,
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged && !update.focusChanged) {
        return;
      }

      const editorInfo = update.state.field(editorInfoField, false);
      if (!editorInfo?.file || !editorInfo.editor) {
        return;
      }

      onSelectionChange({
        filePath: editorInfo.file.path,
        editor: editorInfo.editor,
        focused: update.view.hasFocus
      });
    })
  ];
}

export function getCodeMirrorEditorView(editor: Editor | undefined): EditorView | null {
  const candidate = (editor as Editor & { cm?: unknown } | undefined)?.cm;
  return isEditorView(candidate) ? candidate : null;
}

export function getMarkdownEditorViewsForFile(app: App, filePath: string): EditorView[] {
  return getMarkdownViewsForFile(app, filePath)
    .map((view) => getCodeMirrorEditorView(view.editor))
    .filter((view): view is EditorView => view !== null);
}

export function getMarkdownViewsForFile(app: App, filePath: string): MarkdownView[] {
  return app.workspace
    .getLeavesOfType("markdown")
    .map((leaf) => leaf.view)
    .filter((view): view is MarkdownView => view instanceof MarkdownView)
    .filter((view) => view.file?.path === filePath);
}

export function setRemotePresenceDecorations(view: EditorView, presences: SharedCursorPresence[]): void {
  view.dispatch({
    effects: setRemotePresenceEffect.of(presences)
  });
}

function buildRemotePresenceDecorations(
  documentLength: number,
  presences: SharedCursorPresence[]
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  for (const presence of presences) {
    const anchor = clampOffset(presence.selection.anchor, documentLength);
    const head = clampOffset(presence.selection.head, documentLength);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    if (from !== to) {
      ranges.push({
        from,
        to,
        decoration: Decoration.mark({
          class: "rolay-shared-selection",
          attributes: {
            style: `background-color: ${withAlphaChannel(presence.color, 0.18)};`
          }
        })
      });
    }

    ranges.push({
      from: head,
      to: head,
      decoration: Decoration.widget({
        side: 1,
        widget: new SharedCursorWidget(presence.displayName, presence.color)
      })
    });
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);

  for (const range of ranges) {
    builder.add(range.from, range.to, range.decoration);
  }

  return builder.finish();
}

function clampOffset(offset: number, documentLength: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(0, Math.min(documentLength, Math.floor(offset)));
}

function withAlphaChannel(color: string, alpha: number): string {
  if (color.startsWith("hsl(") && color.endsWith(")")) {
    return `${color.slice(0, -1)} / ${alpha})`;
  }

  return color;
}

function isEditorView(value: unknown): value is EditorView {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "dispatch" in value
    && "state" in value
    && "dom" in value
    && "hasFocus" in value;
}

class SharedCursorWidget extends WidgetType {
  private readonly displayName: string;
  private readonly color: string;

  constructor(displayName: string, color: string) {
    super();
    this.displayName = displayName;
    this.color = color;
  }

  override eq(other: SharedCursorWidget): boolean {
    return this.displayName === other.displayName && this.color === other.color;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "rolay-shared-cursor";
    wrapper.style.setProperty("--rolay-presence-color", this.color);
    wrapper.setAttribute("aria-hidden", "true");

    const caret = document.createElement("span");
    caret.className = "rolay-shared-cursor__caret";

    const label = document.createElement("span");
    label.className = "rolay-shared-cursor__label";
    label.textContent = this.displayName;

    wrapper.append(caret, label);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
