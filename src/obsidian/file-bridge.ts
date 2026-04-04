import {
  TFile,
  TFolder,
  normalizePath,
  type App,
  type TAbstractFile
} from "obsidian";
import type { FileEntry, TreeSnapshotResponse } from "../types/protocol";
import {
  getRoomRoot,
  isManagedPathForRoom,
  toLocalPathForRoom,
  toServerPathForRoom
} from "../sync/path-mapper";

type RemotePathChangeType = "rename_entry" | "move_entry";

interface DownloadedRoomContext {
  workspaceId: string;
  folderName: string;
}

interface ResolvedRoomPath extends DownloadedRoomContext {
  serverPath: string;
}

interface FileBridgeConfig {
  app: App;
  getSyncRoot: () => string;
  getFolderName: (workspaceId: string) => string | null;
  getDownloadedRooms: () => DownloadedRoomContext[];
  getEntryByPath: (workspaceId: string, path: string) => FileEntry | null;
  log: (message: string) => void;
  onCreateFolder: (workspaceId: string, path: string) => Promise<void>;
  onCreateMarkdown: (workspaceId: string, path: string, localContent: string) => Promise<void>;
  onRenameOrMove: (
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: RemotePathChangeType
  ) => Promise<void>;
  onDeleteEntry: (workspaceId: string, entry: FileEntry) => Promise<void>;
}

export class FileBridge {
  private readonly app: App;
  private readonly getSyncRoot: () => string;
  private readonly getFolderName: (workspaceId: string) => string | null;
  private readonly getDownloadedRooms: () => DownloadedRoomContext[];
  private readonly getEntryByPath: (workspaceId: string, path: string) => FileEntry | null;
  private readonly log: (message: string) => void;
  private readonly onCreateFolder: (workspaceId: string, path: string) => Promise<void>;
  private readonly onCreateMarkdown: (workspaceId: string, path: string, localContent: string) => Promise<void>;
  private readonly onRenameOrMove: (
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: RemotePathChangeType
  ) => Promise<void>;
  private readonly onDeleteEntry: (workspaceId: string, entry: FileEntry) => Promise<void>;
  private readonly suppressedPrefixes = new Map<string, number>();

  constructor(config: FileBridgeConfig) {
    this.app = config.app;
    this.getSyncRoot = config.getSyncRoot;
    this.getFolderName = config.getFolderName;
    this.getDownloadedRooms = config.getDownloadedRooms;
    this.getEntryByPath = config.getEntryByPath;
    this.log = config.log;
    this.onCreateFolder = config.onCreateFolder;
    this.onCreateMarkdown = config.onCreateMarkdown;
    this.onRenameOrMove = config.onRenameOrMove;
    this.onDeleteEntry = config.onDeleteEntry;
  }

  async applySnapshot(snapshot: TreeSnapshotResponse, previousEntries: FileEntry[]): Promise<void> {
    const folderName = this.getFolderName(snapshot.workspace.id);
    if (!folderName) {
      return;
    }

    const roomRoot = this.getRoomRoot(folderName);
    if (roomRoot) {
      await this.ensureFolderExists(roomRoot);
    }

    const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]));
    const nextById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const activePathSet = new Set(
      snapshot.entries
        .filter((entry) => !entry.deleted)
        .map((entry) => normalizePath(entry.path))
    );

    const renamedEntries = snapshot.entries
      .filter((entry) => !entry.deleted)
      .filter((entry) => {
        const previous = previousById.get(entry.id);
        return previous && !previous.deleted && previous.path !== entry.path;
      });

    for (const entry of renamedEntries) {
      const previous = previousById.get(entry.id);
      if (previous) {
        await this.safeApply(`rename local ${previous.path} -> ${entry.path}`, async () => {
          await this.renameLocalPath(folderName, previous.path, entry.path);
        });
      }
    }

    const activeEntries = snapshot.entries
      .filter((entry) => !entry.deleted)
      .sort(compareEntriesForMaterialization);

    for (const entry of activeEntries) {
      await this.safeApply(`materialize ${entry.path}`, async () => {
        await this.ensureLocalEntry(folderName, entry);
      });
    }

    const deletedEntries = previousEntries.filter((previous) => {
      if (previous.deleted) {
        return false;
      }

      if (activePathSet.has(normalizePath(previous.path))) {
        return false;
      }

      const next = nextById.get(previous.id);
      return !next || next.deleted;
    });

    for (const entry of deletedEntries.sort(compareEntriesForDeletion)) {
      await this.safeApply(`trash ${entry.path}`, async () => {
        await this.trashLocalEntry(folderName, entry.path);
      });
    }
  }

  async handleVaultCreate(file: TAbstractFile): Promise<void> {
    const resolved = this.resolveRoomPath(file.path);
    if (!resolved || this.isSuppressedPath(file.path)) {
      return;
    }

    if (this.getEntryByPath(resolved.workspaceId, resolved.serverPath)) {
      return;
    }

    if (file instanceof TFolder) {
      await this.onCreateFolder(resolved.workspaceId, resolved.serverPath);
      return;
    }

    if (file instanceof TFile && file.extension === "md") {
      await this.onCreateMarkdown(
        resolved.workspaceId,
        resolved.serverPath,
        await this.readMarkdownFile(file)
      );
      return;
    }

    this.log(`Ignoring unsupported local create for ${file.path}. Blob upload is not implemented yet.`);
  }

  async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.isSuppressedPath(oldPath) || this.isSuppressedPath(file.path)) {
      return;
    }

    const oldResolved = this.resolveRoomPath(oldPath);
    const newResolved = this.resolveRoomPath(file.path);

    if (!oldResolved && !newResolved) {
      return;
    }

    if (!oldResolved && newResolved) {
      await this.handleVaultCreate(file);
      return;
    }

    if (oldResolved && !newResolved) {
      const entry = this.getEntryByPath(oldResolved.workspaceId, oldResolved.serverPath);
      if (!entry) {
        return;
      }

      await this.onDeleteEntry(oldResolved.workspaceId, entry);
      return;
    }

    if (!oldResolved || !newResolved) {
      return;
    }

    if (oldResolved.workspaceId !== newResolved.workspaceId) {
      this.log(`Managed path ${oldPath} was moved across room roots. Cross-room moves are not supported.`);
      return;
    }

    const entry = this.getEntryByPath(oldResolved.workspaceId, oldResolved.serverPath);
    if (!entry) {
      return;
    }

    const type: RemotePathChangeType =
      getParentPath(oldResolved.serverPath) === getParentPath(newResolved.serverPath)
        ? "rename_entry"
        : "move_entry";

    await this.onRenameOrMove(oldResolved.workspaceId, entry, newResolved.serverPath, type);
  }

  async handleVaultDelete(file: TAbstractFile): Promise<void> {
    const resolved = this.resolveRoomPath(file.path);
    if (!resolved || this.isSuppressedPath(file.path)) {
      return;
    }

    const roomRoot = this.getRoomRoot(resolved.folderName);
    if (!this.app.vault.getAbstractFileByPath(roomRoot)) {
      this.log(`Skipping remote delete for ${file.path} because the local room root is no longer installed.`);
      return;
    }

    const entry = this.getEntryByPath(resolved.workspaceId, resolved.serverPath);
    if (!entry) {
      return;
    }

    await this.onDeleteEntry(resolved.workspaceId, entry);
  }

  toLocalPath(workspaceId: string, serverPath: string): string | null {
    const folderName = this.getFolderName(workspaceId);
    if (!folderName) {
      return null;
    }

    return toLocalPathForRoom(this.getSyncRoot(), folderName, serverPath);
  }

  private resolveRoomPath(localPath: string): ResolvedRoomPath | null {
    for (const room of this.getDownloadedRooms()) {
      if (!isManagedPathForRoom(localPath, this.getSyncRoot(), room.folderName)) {
        continue;
      }

      const serverPath = toServerPathForRoom(localPath, this.getSyncRoot(), room.folderName);
      if (serverPath === null) {
        continue;
      }

      return {
        ...room,
        serverPath
      };
    }

    return null;
  }

  private async renameLocalPath(
    folderName: string,
    oldServerPath: string,
    newServerPath: string
  ): Promise<void> {
    const oldLocalPath = toLocalPathForRoom(this.getSyncRoot(), folderName, oldServerPath);
    const newLocalPath = toLocalPathForRoom(this.getSyncRoot(), folderName, newServerPath);
    if (oldLocalPath === newLocalPath) {
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(oldLocalPath);
    if (!existing) {
      return;
    }

    const destination = this.app.vault.getAbstractFileByPath(newLocalPath);
    if (destination && destination.path !== existing.path) {
      this.log(`Skipped local rename to ${newLocalPath} because that path already exists.`);
      return;
    }

    await this.ensureFolderExists(getParentPath(newLocalPath));
    await this.withSuppressedPaths([oldLocalPath, newLocalPath], async () => {
      await this.app.fileManager.renameFile(existing, newLocalPath);
    });
  }

  private async ensureLocalEntry(folderName: string, entry: FileEntry): Promise<void> {
    const localPath = toLocalPathForRoom(this.getSyncRoot(), folderName, entry.path);
    const existing = this.app.vault.getAbstractFileByPath(localPath);

    if (entry.kind === "folder") {
      await this.ensureFolderExists(localPath);
      return;
    }

    await this.ensureFolderExists(getParentPath(localPath));

    if (existing) {
      return;
    }

    if (entry.kind === "markdown") {
      await this.withSuppressedPaths([localPath], async () => {
        await this.app.vault.create(localPath, "");
      });
      return;
    }

    this.log(`Skipping binary materialization for ${entry.path} until blob download is implemented.`);
  }

  private async trashLocalEntry(folderName: string, serverPath: string): Promise<void> {
    const localPath = toLocalPathForRoom(this.getSyncRoot(), folderName, serverPath);
    const existing = this.app.vault.getAbstractFileByPath(localPath);
    if (!existing) {
      return;
    }

    await this.withSuppressedPaths([localPath], async () => {
      await this.app.vault.trash(existing, false);
    });
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalizedFolderPath = normalizePath(folderPath);
    if (!normalizedFolderPath) {
      return;
    }

    const segments = normalizedFolderPath.split("/");
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`Expected folder at ${currentPath}, but a file already exists there.`);
      }

      await this.withSuppressedPaths([currentPath], async () => {
        await this.app.vault.createFolder(currentPath);
      });
    }
  }

  private getRoomRoot(folderName: string): string {
    return getRoomRoot(this.getSyncRoot(), folderName);
  }

  private async readMarkdownFile(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch (error) {
      this.log(`Failed to read markdown content for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  private isSuppressedPath(path: string): boolean {
    const normalizedPath = normalizePath(path);

    for (const prefix of this.suppressedPrefixes.keys()) {
      if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
        return true;
      }
    }

    return false;
  }

  private async withSuppressedPaths(paths: string[], work: () => Promise<void>): Promise<void> {
    const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)).filter(Boolean))];
    for (const path of normalizedPaths) {
      this.incrementSuppression(path);
    }

    try {
      await work();
    } finally {
      window.setTimeout(() => {
        for (const path of normalizedPaths) {
          this.decrementSuppression(path);
        }
      }, 750);
    }
  }

  async runWithSuppressedPaths(paths: string[], work: () => Promise<void>): Promise<void> {
    await this.withSuppressedPaths(paths, work);
  }

  private incrementSuppression(path: string): void {
    this.suppressedPrefixes.set(path, (this.suppressedPrefixes.get(path) ?? 0) + 1);
  }

  private decrementSuppression(path: string): void {
    const currentCount = this.suppressedPrefixes.get(path);
    if (!currentCount) {
      return;
    }

    if (currentCount <= 1) {
      this.suppressedPrefixes.delete(path);
      return;
    }

    this.suppressedPrefixes.set(path, currentCount - 1);
  }

  private async safeApply(label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

function compareEntriesForMaterialization(left: FileEntry, right: FileEntry): number {
  if (left.kind === "folder" && right.kind !== "folder") {
    return -1;
  }

  if (left.kind !== "folder" && right.kind === "folder") {
    return 1;
  }

  return left.path.localeCompare(right.path);
}

function compareEntriesForDeletion(left: FileEntry, right: FileEntry): number {
  return right.path.length - left.path.length;
}
