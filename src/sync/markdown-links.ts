import * as Y from "yjs";

export interface LinkTarget { id: string; path: string }
export interface LinkEdit { start: number; end: number; text: string }
interface LinkSlot { start: number; end: number; path: string; markdown: boolean }

export function resolveRoomLink(
  link: string, sourcePath: string, entries: readonly LinkTarget[],
  aliases: ReadonlyMap<string, string> = new Map()
): LinkTarget | null {
  const path = cleanPath(link);
  if (!link || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(link)) { return null; }
  const parent = sourcePath.split("/").slice(0, -1).join("/");
  const candidates = link.startsWith("/") ? [path] : [cleanPath(`${parent}/${link}`), path];
  for (const candidate of candidates) {
    if (!candidate) { continue; }
    const matches = entries.filter(e => e.path === candidate || e.path === `${candidate}.md`);
    if (matches.length === 1) { return matches[0]; }
    if (matches.length > 1) { return null; }
    const alias = aliases.get(candidate);
    if (alias) { return entries.find(e => e.id === alias) ?? null; }
  }
  if (link.startsWith(".") || link.startsWith("/")) { return null; }
  const matches = entries.filter(e => e.path.endsWith(`/${path}`) || e.path.endsWith(`/${path}.md`));
  return matches.length === 1 ? matches[0] : null;
}

export function planPortableLinkEdits(
  remote: string, local: string, sourcePath: string,
  resolveRemote: (path: string) => LinkTarget | null,
  resolveLocal: (path: string) => LinkTarget | null
): LinkEdit[] | null {
  const before = linkSlots(remote), after = linkSlots(local);
  if (before.length !== after.length || skeleton(remote, before) !== skeleton(local, after)) { return null; }
  const edits: LinkEdit[] = [];
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (a.path === b.path) { continue; }
    const oldTarget = resolveRemote(a.path), newTarget = resolveLocal(b.path);
    if (!oldTarget || !newTarget || oldTarget.id !== newTarget.id) { return null; }
    let path = relativeLink(sourcePath, newTarget.path);
    if (a.markdown) { path = encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29"); }
    if (path !== a.path) { edits.push({ start: a.start, end: a.end, text: path }); }
  }
  return edits;
}

export function applyLinkEdits(text: string, edits: readonly LinkEdit[]): string {
  for (const edit of [...edits].reverse()) { text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); }
  return text;
}

export function createLinkRewriteState(state: Uint8Array, edits: readonly LinkEdit[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    const content = doc.getText("content");
    doc.transact(() => {
      for (const edit of [...edits].reverse()) {
        content.delete(edit.start, edit.end - edit.start);
        content.insert(edit.start, edit.text);
      }
    });
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

export function includesMarkdownState(remote: Uint8Array, pending: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, remote);
    const before = doc.getText("content").toString();
    const vector = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, pending);
    const afterVector = Y.encodeStateVector(doc);
    return before === doc.getText("content").toString() &&
      vector.length === afterVector.length && vector.every((byte, i) => byte === afterVector[i]);
  } finally { doc.destroy(); }
}

function relativeLink(source: string, target: string): string {
  const parent = source.split("/").slice(0, -1), parts = target.split("/");
  while (parent.length && parts.length && parent[0] === parts[0]) { parent.shift(); parts.shift(); }
  return parent.length ? "../".repeat(parent.length) + parts.join("/") : `./${parts.join("/")}`;
}

function cleanPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") { if (!parts.length) { return ""; } parts.pop(); }
    else if (part && part !== ".") { parts.push(part); }
  }
  return parts.join("/");
}

function skeleton(text: string, slots: LinkSlot[]): string {
  return applyLinkEdits(text, slots.map(slot => ({ ...slot, text: "\u0000" })));
}

function linkSlots(text: string): LinkSlot[] {
  // Ignore code and comments; only destination spans may change, never labels or prose.
  const ignored = [...text.matchAll(/(`+)[\s\S]*?\1|<!--[\s\S]*?-->|^ {0,3}~~~[^\n]*\n[\s\S]*?^ {0,3}~~~[^\n]*/gm)]
    .map(match => [match.index!, match.index! + match[0].length]);
  const slots: LinkSlot[] = [];
  const pattern = /\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\(\s*/g;
  for (const match of text.matchAll(pattern)) {
    if (ignored.some(([start, end]) => match.index! >= start && match.index! < end)) { continue; }
    if (match[1] !== undefined) {
      const path = match[1].split(/[|#]/, 1)[0];
      if (path) { slots.push({ start: match.index! + 2, end: match.index! + 2 + path.length, path, markdown: false }); }
      continue;
    }
    let start = match.index! + match[0].length, end = start, depth = 0;
    const angle = text[start] === "<";
    if (angle) { start++; end++; }
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === "\\") { end++; continue; }
      if (angle ? char === ">" : (char === ")" && depth === 0) || /\s/.test(char)) { break; }
      if (char === "(") { depth++; } else if (char === ")") { depth--; }
    }
    const raw = text.slice(start, end), path = raw.split("#", 1)[0];
    if (path && end < text.length) { slots.push({ start, end: start + path.length, path, markdown: true }); }
  }
  return slots.filter((slot, i) => i === 0 || slot.start >= slots[i - 1].end);
}
