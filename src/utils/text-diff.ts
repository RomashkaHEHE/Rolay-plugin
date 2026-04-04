import type { Editor, EditorPosition } from "obsidian";

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
  nextText: string
): void {
  const patch = diffText(currentText, nextText);
  if (patch.deleteCount === 0 && patch.insertText.length === 0) {
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
