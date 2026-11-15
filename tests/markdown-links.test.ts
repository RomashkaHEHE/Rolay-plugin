import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { mergePluginData } from "../src/settings/data";
import {
  applyLinkEdits, createLinkRewriteState, includesMarkdownState, planPortableLinkEdits,
  resolveRoomLink, type LinkTarget
} from "../src/sync/markdown-links";

const source = "course/lecture.md";
const targets: LinkTarget[] = [
  { id: "pdf", path: "course/files/paper.pdf" },
  { id: "md", path: "course/other.md" },
  { id: "png", path: "course/image.png" },
  { id: "audio", path: "course/audio.mp3" }
];
const remoteResolver = (path: string) => resolveRoomLink(decodeURIComponent(path), source, targets);
const localResolver = (path: string) => remoteResolver(path.replace(/^vault-room\//, "/"));
const plan = (remote: string, local: string) => planPortableLinkEdits(remote, local, source, remoteResolver, localResolver);

test("wiki links and embeds reconcile all target file types without changing labels or anchors", () => {
  const before = "[[other#Heading|Note]] ![[image.png|500]] [[files/paper.pdf]] ![[audio.mp3]]";
  const local = "[[vault-room/course/other.md#Heading|Note]] ![[vault-room/course/image.png|500]] [[vault-room/course/files/paper.pdf]] ![[vault-room/course/audio.mp3]]";
  const edits = plan(before, local);
  assert.ok(edits);
  assert.equal(applyLinkEdits(before, edits), "[[./other.md#Heading|Note]] ![[./image.png|500]] [[./files/paper.pdf]] ![[./audio.mp3]]");
});

test("Markdown URLs preserve title, fragment, labels and parentheses in file names", () => {
  const entries = [{ id: "file", path: "course/files/a (b).pdf" }];
  const resolve = (path: string) => resolveRoomLink(decodeURIComponent(path), source, entries);
  const before = '[Paper](<files/a (b).pdf#page=3> "title")';
  const local = '[Paper](<course/files/a (b).pdf#page=3> "title")';
  const edits = planPortableLinkEdits(before, local, source, resolve, resolve);
  assert.ok(edits);
  assert.equal(applyLinkEdits(before, edits), '[Paper](<./files/a%20%28b%29.pdf#page=3> "title")');
});

test("new room folder names never appear in portable destination paths", () => {
  const before = "[[paper.pdf]]";
  const local = "[[vault-room/course/files/paper.pdf]]";
  assert.equal(applyLinkEdits(before, plan(before, local)!), "[[./files/paper.pdf]]");
});

test("moving or renaming a target follows its ID through an observed alias", () => {
  const moved = [{ id: "pdf", path: "resources/new.pdf" }];
  const old = (path: string) => resolveRoomLink(path, source, moved, new Map([["course/files/paper.pdf", "pdf"]]));
  const current = (path: string) => resolveRoomLink(path, source, moved);
  const before = "[[files/paper.pdf]]";
  const edits = planPortableLinkEdits(before, "[[resources/new.pdf]]", source, old, current);
  assert.ok(edits);
  assert.equal(applyLinkEdits(before, edits), "[[../resources/new.pdf]]");
});

test("outside-room and different-target links are never silently substituted", () => {
  assert.equal(plan("[[image.png]]", "[[archive/English/image.png]]"), null);
  assert.equal(plan("[[image.png]]", "[[audio.mp3]]"), null);
  assert.equal(plan("[[image.png]]", "[[https://example.test/image.png]]"), null);
});

test("ordinary text, aliases, fragments and link deletion are not treated as automatic rewrites", () => {
  assert.equal(plan("Text [[image.png]]", "Changed [[vault-room/course/image.png]]"), null);
  assert.equal(plan("[[image.png|a]]", "[[vault-room/course/image.png|b]]"), null);
  assert.equal(plan("[[other#One]]", "[[vault-room/course/other.md#Two]]"), null);
  assert.equal(plan("[[image.png]]", ""), null);
});

test("code fences, inline code and comments are not rewritten", () => {
  for (const wrap of [(x: string) => `\`${x}\``, (x: string) => `\`\`\`md\n${x}\n\`\`\``,
    (x: string) => `~~~md\n${x}\n~~~`, (x: string) => `<!-- ${x} -->`]) {
    assert.equal(plan(wrap("[[image.png]]"), wrap("[[vault-room/course/image.png]]")), null);
  }
});

test("ambiguous names fail safely while explicit relative paths resolve unambiguously", () => {
  const entries = [{ id: "a", path: "one/a.pdf" }, { id: "b", path: "two/a.pdf" }];
  assert.equal(resolveRoomLink("a.pdf", source, entries), null);
  assert.equal(resolveRoomLink("../one/a.pdf", source, entries)?.id, "a");
  assert.equal(resolveRoomLink("../../../one/a.pdf", source, entries), null);
  assert.equal(resolveRoomLink("deleted.pdf", source, entries), null);
});

test("link edits merge with concurrent remote prose and retries are idempotent", () => {
  const base = new Y.Doc();
  base.getText("content").insert(0, "Intro [[image.png]]\nEnd");
  const state = Y.encodeStateAsUpdate(base);
  const before = base.getText("content").toString();
  const edits = plan(before, "Intro [[vault-room/course/image.png]]\nEnd")!;
  const pending = createLinkRewriteState(state, edits);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, state);
  remote.getText("content").insert(0, "Remote edit\n");
  assert.equal(includesMarkdownState(Y.encodeStateAsUpdate(remote), pending), false);
  Y.applyUpdate(remote, pending);
  const expected = "Remote edit\nIntro [[./image.png]]\nEnd";
  assert.equal(remote.getText("content").toString(), expected);
  Y.applyUpdate(remote, pending);
  assert.equal(remote.getText("content").toString(), expected);
  assert.equal(includesMarkdownState(Y.encodeStateAsUpdate(remote), pending), true);
  base.destroy(); remote.destroy();
});

test("link rewrite outbox survives settings normalization and a process restart", () => {
  const originalText = "[[vault-room/course/image.png]]";
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "[[image.png]]");
  const state = createLinkRewriteState(Y.encodeStateAsUpdate(doc), plan("[[image.png]]", originalText)!);
  const data = mergePluginData({ pendingMarkdownMerges: {
    note: { entryId: "note", workspaceId: "room", localPath: "vault-room/course/lecture.md",
      filePath: source, createdAt: "", lastAttemptAt: null, lastError: null,
      linkRewrite: { encodedState: Buffer.from(state).toString("base64"), originalText } }
  } });
  const restored = mergePluginData(JSON.parse(JSON.stringify(data)));
  const pending = restored.pendingMarkdownMerges.note.linkRewrite!;
  assert.equal(pending.originalText, originalText);
  const update = Buffer.from(pending.encodedState, "base64");
  Y.applyUpdate(doc, update);
  assert.equal(doc.getText("content").toString(), "[[./image.png]]");
  assert.equal(includesMarkdownState(Y.encodeStateAsUpdate(doc), update), true);
  doc.destroy();
});
