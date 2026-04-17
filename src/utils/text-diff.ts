import type { Editor, EditorPosition } from "obsidian";
import type { EditorView } from "@codemirror/view";

export interface TextPatch {
  start: number;
  deleteCount: number;
  insertText: string;
}

export function diffText(currentText: string, nextText: string): TextPatch {
  if (currentText === nextText) {
    return {
      start: 0,
      deleteCount: 0,
      insertText: ""
    };
  }

  let start = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (start < maxPrefix && currentText[start] === nextText[start]) {
    start += 1;
  }

  let currentEnd = currentText.length;
  let nextEnd = nextText.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    currentText[currentEnd - 1] === nextText[nextEnd - 1]
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    deleteCount: currentEnd - start,
    insertText: nextText.slice(start, nextEnd)
  };
}

export function applyTextPatchToEditor(
  editor: Editor,
  currentText: string,
  nextText: string,
  editorView?: EditorView | null
): void {
  const patch = diffText(currentText, nextText);
  if (patch.deleteCount === 0 && patch.insertText.length === 0) {
    return;
  }

  if (editorView) {
    const preservedScrollTop = editorView.scrollDOM.scrollTop;
    const preservedScrollLeft = editorView.scrollDOM.scrollLeft;

    // Applying remote text through CodeMirror transactions keeps document state
    // consistent, but collaborative edits must not forcibly reveal the patch
    // location and pull the local reader to another part of the note.
    editorView.dispatch({
      changes: {
        from: patch.start,
        to: patch.start + patch.deleteCount,
        insert: patch.insertText
      }
    });

    // Remote CRDT patches should not yank the local reader/editor viewport to a
    // different position. CodeMirror keeps document/selection state correct, so
    // we only restore the viewport that the local user already had.
    editorView.scrollDOM.scrollTop = preservedScrollTop;
    editorView.scrollDOM.scrollLeft = preservedScrollLeft;
    window.requestAnimationFrame(() => {
      if (!editorView.dom.isConnected) {
        return;
      }

      editorView.scrollDOM.scrollTop = preservedScrollTop;
      editorView.scrollDOM.scrollLeft = preservedScrollLeft;
    });
    return;
  }

  const from = offsetToEditorPosition(currentText, patch.start);
  const to = offsetToEditorPosition(currentText, patch.start + patch.deleteCount);
  editor.replaceRange(patch.insertText, from, to);
}

export function offsetToEditorPosition(text: string, offset: number): EditorPosition {
  let line = 0;
  let ch = 0;

  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      ch = 0;
    } else {
      ch += 1;
    }
  }

  return { line, ch };
}
