import type { FileEntry, TreeSnapshotResponse, Workspace } from "../types/protocol";

export class TreeStore {
  private workspace: Workspace | null = null;
  private cursor: number | null = null;
  private readonly entriesById = new Map<string, FileEntry>();
  private readonly entriesByPath = new Map<string, FileEntry>();

  clear(): void {
    this.workspace = null;
    this.cursor = null;
    this.entriesById.clear();
    this.entriesByPath.clear();
  }

  applySnapshot(snapshot: TreeSnapshotResponse): void {
    this.workspace = snapshot.workspace;
    this.cursor = snapshot.cursor;
    this.entriesById.clear();
    this.entriesByPath.clear();

    for (const entry of snapshot.entries) {
      this.entriesById.set(entry.id, entry);
      if (!entry.deleted) {
        this.entriesByPath.set(normalizePath(entry.path), entry);
      }
    }
  }

  recordCursor(cursor: number): void {
    this.cursor = cursor;
  }

  getCursor(): number | null {
    return this.cursor;
  }

  getWorkspace(): Workspace | null {
    return this.workspace;
  }

  getWorkspaceId(): string | null {
    return this.workspace?.id ?? null;
  }

  getEntries(): FileEntry[] {
    return [...this.entriesById.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  getEntryById(entryId: string): FileEntry | null {
    return this.entriesById.get(entryId) ?? null;
  }

  getEntryByPath(path: string): FileEntry | null {
    return this.entriesByPath.get(normalizePath(path)) ?? null;
  }

  upsertEntry(entry: FileEntry): void {
    const previousEntry = this.entriesById.get(entry.id);
    if (previousEntry) {
      this.entriesByPath.delete(normalizePath(previousEntry.path));
    }

    this.entriesById.set(entry.id, entry);
    if (!entry.deleted) {
      this.entriesByPath.set(normalizePath(entry.path), entry);
    }
  }

  markEntryDeleted(entryId: string): void {
    const existingEntry = this.entriesById.get(entryId);
    if (!existingEntry) {
      return;
    }

    this.entriesByPath.delete(normalizePath(existingEntry.path));
    this.entriesById.set(entryId, {
      ...existingEntry,
      deleted: true
    });
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
