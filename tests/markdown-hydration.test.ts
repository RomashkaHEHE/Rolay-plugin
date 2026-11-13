import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownHydrationAction, needsLockedMarkdownDownload } from "../src/sync/markdown-hydration";

test("preload preserves local link rewrites and edits while updating unchanged baselines", () => {
  assert.equal(getMarkdownHydrationAction("![[room/image.png]]", "![[image.png]]", "![[image.png]]"), "preserve-local");
  assert.equal(getMarkdownHydrationAction("local edit", "remote edit", null), "preserve-local");
  assert.equal(getMarkdownHydrationAction("baseline", "remote edit", "baseline"), "write");
  assert.equal(getMarkdownHydrationAction("", "remote edit", null), "write");
  assert.equal(getMarkdownHydrationAction("same", "same", null), "unchanged");
});

test("local divergence stays protected without repeatedly downloading an already received document", () => {
  const locked = new Set(["local-edit.md", "missing.md"]);
  const diverged = new Set(["local-edit.md"]);
  assert.equal(needsLockedMarkdownDownload("local-edit.md", locked, diverged), false);
  assert.equal(locked.has("local-edit.md"), true);
  assert.equal(needsLockedMarkdownDownload("missing.md", locked, diverged), true);
  assert.equal(needsLockedMarkdownDownload("ready.md", locked, diverged), false);
  diverged.clear();
  assert.equal(needsLockedMarkdownDownload("local-edit.md", locked, diverged), true);
});
