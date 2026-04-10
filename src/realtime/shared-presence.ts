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

interface SharedCursorUiState {
  endOfLineSince: number | null;
  inlineVisible: boolean;
}

const setRemotePresenceEffect = StateEffect.define<SharedCursorPresence[]>();
const END_OF_LINE_LABEL_DELAY_MS = 1000;
const sharedCursorUiState = new Map<string, SharedCursorUiState>();

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
  cleanupSharedCursorUiState(presences);
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
            style: `background-color: ${withAlphaChannel(presence.color, 0.05)};`
          }
        })
      });
    }

    ranges.push({
      from: head,
      to: head,
      decoration: Decoration.widget({
        side: 1,
        widget: new SharedCursorWidget(
          getSharedCursorKey(presence),
          presence.displayName,
          presence.color,
          from !== to
        )
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
  private readonly cursorKey: string;
  private readonly displayName: string;
  private readonly color: string;
  private readonly hasSelection: boolean;

  constructor(cursorKey: string, displayName: string, color: string, hasSelection: boolean) {
    super();
    this.cursorKey = cursorKey;
    this.displayName = displayName;
    this.color = color;
    this.hasSelection = hasSelection;
  }

  override eq(other: SharedCursorWidget): boolean {
    return this.cursorKey === other.cursorKey
      && this.displayName === other.displayName
      && this.color === other.color
      && this.hasSelection === other.hasSelection;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "rolay-shared-cursor";
    wrapper.style.setProperty("--rolay-presence-color", this.color);
    wrapper.setAttribute("aria-hidden", "true");

    const caret = document.createElement("span");
    caret.className = "rolay-shared-cursor__caret";

    const hitbox = document.createElement("span");
    hitbox.className = "rolay-shared-cursor__hitbox";

    const label = document.createElement("span");
    label.className = "rolay-shared-cursor__label";
    label.textContent = this.displayName;

    const uiState = getSharedCursorUiState(this.cursorKey);
    let autoRevealHandle: number | null = null;
    let hovered = false;
    const line = wrapper.closest(".cm-line");

    const clearAutoReveal = () => {
      if (autoRevealHandle !== null) {
        window.clearTimeout(autoRevealHandle);
        autoRevealHandle = null;
      }
    };

    const updateInlineVisibility = (visible: boolean) => {
      uiState.inlineVisible = visible;
      wrapper.classList.toggle("rolay-shared-cursor--inline-visible", visible);
    };

    const scheduleAutoReveal = (delayMs: number) => {
      clearAutoReveal();
      autoRevealHandle = window.setTimeout(() => {
        if (!wrapper.isConnected) {
          return;
        }

        if (!wrapper.classList.contains("rolay-shared-cursor--end")) {
          return;
        }

        updateInlineVisibility(true);
        autoRevealHandle = null;
      }, Math.max(0, delayMs));
    };

    const applyEndOfLineMode = () => {
      const isEndOfLine = !this.hasSelection && isCursorAtVisualLineEnd(wrapper);
      wrapper.classList.toggle("rolay-shared-cursor--end", isEndOfLine);

      if (isEndOfLine) {
        if (uiState.endOfLineSince === null) {
          uiState.endOfLineSince = Date.now();
        }

        if (hovered) {
          clearAutoReveal();
          updateInlineVisibility(true);
          return;
        }

        const elapsedMs = Date.now() - uiState.endOfLineSince;
        if (uiState.inlineVisible || elapsedMs >= END_OF_LINE_LABEL_DELAY_MS) {
          clearAutoReveal();
          updateInlineVisibility(true);
          return;
        }

        updateInlineVisibility(false);
        scheduleAutoReveal(END_OF_LINE_LABEL_DELAY_MS - elapsedMs);
        return;
      }

      uiState.endOfLineSince = null;
      uiState.inlineVisible = false;
      clearAutoReveal();
      wrapper.classList.remove("rolay-shared-cursor--inline-visible");
    };

    wrapper.addEventListener("mouseenter", () => {
      hovered = true;
      if (wrapper.classList.contains("rolay-shared-cursor--end")) {
        clearAutoReveal();
        updateInlineVisibility(true);
      }
    });

    wrapper.addEventListener("mouseleave", () => {
      hovered = false;
    });

    let mutationObserver: MutationObserver | null = null;
    if (line instanceof HTMLElement) {
      mutationObserver = new MutationObserver(() => {
        if (!wrapper.isConnected) {
          mutationObserver?.disconnect();
          clearAutoReveal();
          return;
        }

        applyEndOfLineMode();
      });
    }

    if (mutationObserver && line instanceof HTMLElement) {
      mutationObserver.observe(line, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    const cleanup = () => {
      mutationObserver?.disconnect();
      clearAutoReveal();
    };

    Object.assign(wrapper, {
      __rolayCursorCleanup: cleanup
    });

    requestAnimationFrame(() => {
      if (!wrapper.isConnected) {
        cleanup();
        return;
      }
      applyEndOfLineMode();
    });

    wrapper.append(hitbox, caret, label);
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    const cleanup = (dom as HTMLElement & { __rolayCursorCleanup?: () => void }).__rolayCursorCleanup;
    cleanup?.();
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function getSharedCursorKey(presence: SharedCursorPresence): string {
  return `${presence.userId}:${presence.clientId}`;
}

function getSharedCursorUiState(cursorKey: string): SharedCursorUiState {
  const existing = sharedCursorUiState.get(cursorKey);
  if (existing) {
    return existing;
  }

  const created: SharedCursorUiState = {
    endOfLineSince: null,
    inlineVisible: false
  };
  sharedCursorUiState.set(cursorKey, created);
  return created;
}

function cleanupSharedCursorUiState(presences: SharedCursorPresence[]): void {
  const activeKeys = new Set(presences.map((presence) => getSharedCursorKey(presence)));
  for (const cursorKey of sharedCursorUiState.keys()) {
    if (!activeKeys.has(cursorKey)) {
      sharedCursorUiState.delete(cursorKey);
    }
  }
}

function isCursorAtVisualLineEnd(wrapper: HTMLElement): boolean {
  const line = wrapper.closest(".cm-line");
  if (!(line instanceof HTMLElement)) {
    return false;
  }

  return !hasFollowingVisibleContent(wrapper, line);
}

function hasFollowingVisibleContent(startNode: Node, line: HTMLElement): boolean {
  let current: Node | null = startNode;
  while (current && current !== line) {
    let sibling = current.nextSibling;
    while (sibling) {
      if (nodeContainsVisibleContent(sibling)) {
        return true;
      }
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }

  return false;
}

function nodeContainsVisibleContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").length > 0;
  }

  if (!(node instanceof HTMLElement)) {
    return false;
  }

  if (node.classList.contains("rolay-shared-cursor") || node.classList.contains("cm-widgetBuffer")) {
    return false;
  }

  if (node.tagName === "BR") {
    return false;
  }

  if ((node.textContent ?? "").length > 0) {
    return true;
  }

  return Array.from(node.childNodes).some((child) => nodeContainsVisibleContent(child));
}
