import assert from "node:assert/strict";
import test from "node:test";
import {
  createActiveMarkdownTreeSignature,
  createSnapshotRefreshRequest,
  doesActiveMarkdownTreeMatch,
  hasActiveMarkdownTreeChanged,
  isSnapshotRefreshCovered,
  mergeSnapshotRefreshRequests,
  shouldScheduleRemoteMarkdownSettle
} from "../src/sync/snapshot-refresh";
import type { EntryKind, FileEntry } from "../src/types/protocol";

test("coalesces duplicate cursors and drops a request already covered by a snapshot", () => {
  const first = createSnapshotRefreshRequest("event-stream", {
    targetCursor: 12,
    markdownBootstrapPolicy: "if-markdown-tree-changed"
  });
  const duplicate = createSnapshotRefreshRequest("local-op", {
    targetCursor: 12,
    markdownBootstrapPolicy: "if-markdown-tree-changed"
  });
  const merged = mergeSnapshotRefreshRequests(first, duplicate);

  assert.equal(merged.targetCursor, 12);
  assert.equal(merged.force, false);
  assert.equal(merged.markdownBootstrapPolicy, "if-markdown-tree-changed");
  assert.equal(isSnapshotRefreshCovered(merged, 12), true);
});

test("keeps a newer cursor pending and separates forced tree refresh from Markdown policy", () => {
  const cursorRequest = createSnapshotRefreshRequest("event-stream", {
    targetCursor: 12,
    markdownBootstrapPolicy: "if-markdown-tree-changed"
  });
  const newerRequest = createSnapshotRefreshRequest("local-op", {
    targetCursor: 13,
    markdownBootstrapPolicy: "if-markdown-tree-changed"
  });
  const withNewerCursor = mergeSnapshotRefreshRequests(cursorRequest, newerRequest);

  assert.equal(withNewerCursor.targetCursor, 13);
  assert.equal(isSnapshotRefreshCovered(withNewerCursor, 12), false);

  const forced = createSnapshotRefreshRequest("failed-operation", {
    markdownBootstrapPolicy: "if-markdown-tree-changed"
  });
  assert.equal(forced.force, true);
  assert.equal(forced.markdownBootstrapPolicy, "if-markdown-tree-changed");
  const withForcedRefresh = mergeSnapshotRefreshRequests(withNewerCursor, forced);
  assert.equal(withForcedRefresh.force, true);
  assert.equal(withForcedRefresh.markdownBootstrapPolicy, "if-markdown-tree-changed");
  assert.equal(isSnapshotRefreshCovered(withForcedRefresh, 99), false);

  const forcedRecovery = createSnapshotRefreshRequest("failed-operation");
  assert.equal(forcedRecovery.markdownBootstrapPolicy, "always");
  const withForcedRecovery = mergeSnapshotRefreshRequests(withNewerCursor, forcedRecovery);
  assert.equal(withForcedRecovery.markdownBootstrapPolicy, "always");
});

test("does not schedule Markdown settle for inactive startup observations", () => {
  assert.equal(
    shouldScheduleRemoteMarkdownSettle(false, "main/Notes/one.md", "Notes/one.md"),
    false
  );
  assert.equal(
    shouldScheduleRemoteMarkdownSettle(true, "main/Notes/one.md", "Notes/one.md", false),
    false
  );
  assert.equal(
    shouldScheduleRemoteMarkdownSettle(true, "main/Notes/one.md", "Notes/one.md"),
    true
  );
  assert.equal(
    shouldScheduleRemoteMarkdownSettle(true, "main/Images/one.png", "Images/one.png"),
    false
  );
});

test("ignores binary-only tree changes for Markdown bootstrap decisions", () => {
  const previous = [
    entry("md-1", "Notes/one.md", "markdown"),
    entry("blob-1", "Images/one.png", "binary")
  ];
  const next = [
    entry("md-1", "Notes/one.md", "markdown"),
    entry("blob-1", "Images/renamed.png", "binary"),
    entry("blob-2", "Images/two.png", "binary")
  ];

  assert.equal(hasActiveMarkdownTreeChanged(previous, next), false);
});

test("detects Markdown create, delete, rename, and parent-folder path changes", () => {
  const original = [
    entry("md-1", "Folder/one.md", "markdown"),
    entry("md-2", "Folder/two.md", "markdown")
  ];

  assert.equal(
    hasActiveMarkdownTreeChanged(original, [
      ...original,
      entry("md-3", "Folder/three.md", "markdown")
    ]),
    true
  );
  assert.equal(
    hasActiveMarkdownTreeChanged(original, [
      entry("md-1", "Folder/one.md", "markdown"),
      entry("md-2", "Folder/two.md", "markdown", true)
    ]),
    true
  );
  assert.equal(
    hasActiveMarkdownTreeChanged(original, [
      entry("md-1", "Folder/renamed.md", "markdown"),
      original[1]
    ]),
    true
  );
  assert.equal(
    hasActiveMarkdownTreeChanged(original, [
      entry("md-1", "Moved/one.md", "markdown"),
      entry("md-2", "Moved/two.md", "markdown")
    ]),
    true
  );
});

test("requires an active bootstrap target to match every Markdown id and path", () => {
  const bootstrapEntries = [
    entry("md-1", "Folder/one.md", "markdown"),
    entry("md-2", "Folder/two.md", "markdown")
  ];
  const target = createActiveMarkdownTreeSignature(bootstrapEntries);

  assert.equal(doesActiveMarkdownTreeMatch(bootstrapEntries, target), true);
  assert.equal(
    doesActiveMarkdownTreeMatch(
      [...bootstrapEntries, entry("md-3", "Folder/new.md", "markdown")],
      target
    ),
    false
  );
  assert.equal(
    doesActiveMarkdownTreeMatch([bootstrapEntries[0]], target),
    false
  );
  assert.equal(
    doesActiveMarkdownTreeMatch(
      [entry("md-1", "Folder/renamed.md", "markdown"), bootstrapEntries[1]],
      target
    ),
    false
  );
  assert.equal(
    doesActiveMarkdownTreeMatch(
      [
        entry("md-1", "Folder\\one.md", "markdown"),
        entry("md-2", "Folder\\two.md", "markdown")
      ],
      target
    ),
    true
  );
});

function entry(
  id: string,
  path: string,
  kind: EntryKind,
  deleted = false
): FileEntry {
  return {
    id,
    path,
    kind,
    contentMode:
      kind === "markdown" ? "crdt" : kind === "binary" ? "blob" : "none",
    entryVersion: 1,
    deleted,
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}
