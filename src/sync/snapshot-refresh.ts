import type { FileEntry } from "../types/protocol";

export type MarkdownBootstrapPolicy = "always" | "if-markdown-tree-changed";

export interface SnapshotRefreshOptions {
  targetCursor?: number | null;
  markdownBootstrapPolicy?: MarkdownBootstrapPolicy;
}

export interface SnapshotRefreshRequest {
  reason: string;
  targetCursor: number | null;
  force: boolean;
  markdownBootstrapPolicy: MarkdownBootstrapPolicy;
}

export function createSnapshotRefreshRequest(
  reason: string,
  options: SnapshotRefreshOptions = {}
): SnapshotRefreshRequest {
  const targetCursor =
    typeof options.targetCursor === "number" && Number.isFinite(options.targetCursor)
      ? Math.max(0, Math.trunc(options.targetCursor))
      : null;

  return {
    reason,
    targetCursor,
    force: targetCursor === null,
    markdownBootstrapPolicy: options.markdownBootstrapPolicy ?? "always"
  };
}

export function shouldScheduleRemoteMarkdownSettle(
  syncActive: boolean,
  localPath: string,
  serverPath: string,
  scheduleMarkdownSettle = true
): boolean {
  return Boolean(
    syncActive &&
    scheduleMarkdownSettle &&
    (/\.(md|markdown)$/i.test(localPath) || /\.md$/i.test(serverPath))
  );
}

export function mergeSnapshotRefreshRequests(
  current: SnapshotRefreshRequest | null,
  incoming: SnapshotRefreshRequest
): SnapshotRefreshRequest {
  if (!current) {
    return incoming;
  }

  return {
    reason: mergeReasons(current.reason, incoming.reason),
    targetCursor: maxCursor(current.targetCursor, incoming.targetCursor),
    force: current.force || incoming.force,
    markdownBootstrapPolicy:
      current.markdownBootstrapPolicy === "always" || incoming.markdownBootstrapPolicy === "always"
        ? "always"
        : "if-markdown-tree-changed"
  };
}

export function isSnapshotRefreshCovered(
  request: SnapshotRefreshRequest,
  lastAppliedSnapshotCursor: number | null
): boolean {
  return (
    !request.force &&
    request.targetCursor !== null &&
    lastAppliedSnapshotCursor !== null &&
    lastAppliedSnapshotCursor >= request.targetCursor
  );
}

export function hasActiveMarkdownTreeChanged(
  previousEntries: FileEntry[],
  nextEntries: FileEntry[]
): boolean {
  return !doesActiveMarkdownTreeMatch(
    nextEntries,
    createActiveMarkdownTreeSignature(previousEntries)
  );
}

export function doesActiveMarkdownTreeMatch(
  entries: FileEntry[],
  targetPathsByEntryId: ReadonlyMap<string, string>
): boolean {
  const activeMarkdownPaths = createActiveMarkdownTreeSignature(entries);
  if (activeMarkdownPaths.size !== targetPathsByEntryId.size) {
    return false;
  }

  for (const [entryId, targetPath] of targetPathsByEntryId) {
    if (activeMarkdownPaths.get(entryId) !== targetPath) {
      return false;
    }
  }

  return true;
}

export function createActiveMarkdownTreeSignature(
  entries: FileEntry[]
): Map<string, string> {
  return new Map(
    entries
      .filter((entry) => entry.kind === "markdown" && !entry.deleted)
      .map((entry) => [entry.id, normalizeServerPath(entry.path)])
  );
}

function normalizeServerPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function maxCursor(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function mergeReasons(left: string, right: string): string {
  if (left === right) {
    return left;
  }

  return [...new Set([...left.split("+"), ...right.split("+")])].slice(0, 4).join("+");
}
