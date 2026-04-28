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
import { isMarkdownPath } from "../utils/file-kind";

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
  hasPendingCreate: (workspaceId: string, path: string) => boolean;
  hasPendingDelete: (workspaceId: string, path: string) => boolean;
  hasPendingBinaryWrite: (localPath: string) => boolean;
  log: (message: string) => void;
  onCreateFolder: (workspaceId: string, path: string) => Promise<void>;
  onCreateMarkdown: (workspaceId: string, path: string, localContent: string) => Promise<void>;
  onCreateBinary: (workspaceId: string, path: string, localContent: ArrayBuffer) => Promise<void>;
  onUpdateBinary: (workspaceId: string, entry: FileEntry, localContent: ArrayBuffer) => Promise<void>;
  onRenameOrMove: (
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: RemotePathChangeType
  ) => Promise<void>;
  onDeleteEntry: (workspaceId: string, entry: FileEntry) => Promise<void>;
  onRemotePathObserved?: (workspaceId: string, localPath: string, serverPath: string) => void;
  wasPathRecentlyObservedAsRemote?: (workspaceId: string, localPath: string) => boolean;
}

export class FileBridge {
  private static readonly REMOTE_CREATE_GUARD_MS = 10_000;
  private static readonly REMOTE_WRITE_GUARD_MS = 4_000;
  private static readonly REMOTE_BINARY_PLACEHOLDER_GUARD_MS = 5 * 60_000;
  private readonly app: App;
  private readonly getSyncRoot: () => string;
  private readonly getFolderName: (workspaceId: string) => string | null;
  private readonly getDownloadedRooms: () => DownloadedRoomContext[];
  private readonly getEntryByPath: (workspaceId: string, path: string) => FileEntry | null;
  private readonly hasPendingCreate: (workspaceId: string, path: string) => boolean;
  private readonly hasPendingDelete: (workspaceId: string, path: string) => boolean;
  private readonly hasPendingBinaryWrite: (localPath: string) => boolean;
  private readonly log: (message: string) => void;
  private readonly onCreateFolder: (workspaceId: string, path: string) => Promise<void>;
  private readonly onCreateMarkdown: (workspaceId: string, path: string, localContent: string) => Promise<void>;
  private readonly onCreateBinary: (workspaceId: string, path: string, localContent: ArrayBuffer) => Promise<void>;
  private readonly onUpdateBinary: (workspaceId: string, entry: FileEntry, localContent: ArrayBuffer) => Promise<void>;
  private readonly onRenameOrMove: (
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: RemotePathChangeType
  ) => Promise<void>;
  private readonly onDeleteEntry: (workspaceId: string, entry: FileEntry) => Promise<void>;
  private readonly onRemotePathObserved?: (workspaceId: string, localPath: string, serverPath: string) => void;
  private readonly wasPathRecentlyObservedAsRemote?: (workspaceId: string, localPath: string) => boolean;
  private readonly suppressedPrefixes = new Map<string, number>();
  private readonly recentRemoteCreates = new Map<string, number>();
  private readonly recentRemoteWrites = new Map<string, number>();
  private readonly recentRemoteRenames = new Map<string, number>();
  private readonly recentRemoteDeletes = new Map<string, number>();
  private readonly protectedRemoteBinaryPlaceholders = new Map<string, number>();

  constructor(config: FileBridgeConfig) {
    this.app = config.app;
    this.getSyncRoot = config.getSyncRoot;
    this.getFolderName = config.getFolderName;
    this.getDownloadedRooms = config.getDownloadedRooms;
    this.getEntryByPath = config.getEntryByPath;
    this.hasPendingCreate = config.hasPendingCreate;
    this.hasPendingDelete = config.hasPendingDelete;
    this.hasPendingBinaryWrite = config.hasPendingBinaryWrite;
    this.log = config.log;
    this.onCreateFolder = config.onCreateFolder;
    this.onCreateMarkdown = config.onCreateMarkdown;
    this.onCreateBinary = config.onCreateBinary;
    this.onUpdateBinary = config.onUpdateBinary;
    this.onRenameOrMove = config.onRenameOrMove;
    this.onDeleteEntry = config.onDeleteEntry;
    this.onRemotePathObserved = config.onRemotePathObserved;
    this.wasPathRecentlyObservedAsRemote = config.wasPathRecentlyObservedAsRemote;
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
      .filter((entry) => !this.hasPendingDelete(snapshot.workspace.id, entry.path))
      .sort(compareEntriesForMaterialization);

    for (const entry of activeEntries) {
      await this.safeApply(`materialize ${entry.path}`, async () => {
        await this.ensureLocalEntry(snapshot.workspace.id, folderName, entry);
      });
    }

    const deletedEntries = previousEntries.filter((previous) => {
      if (previous.deleted) {
        return false;
      }

      if (activePathSet.has(normalizePath(previous.path))) {
        return false;
      }

      if (this.hasPendingCreate(snapshot.workspace.id, previous.path)) {
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

    if (this.consumeRecentRemoteCreate(file.path)) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (this.wasPathRecentlyObservedAsRemote?.(resolved.workspaceId, file.path)) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (
      file instanceof TFile &&
      !isMarkdownPath(file.path) &&
      this.isProtectedRemoteBinaryPlaceholder(file.path) &&
      !this.hasPendingBinaryWrite(file.path)
    ) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (
      this.getEntryByPath(resolved.workspaceId, resolved.serverPath) &&
      !this.hasPendingDelete(resolved.workspaceId, resolved.serverPath)
    ) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (file instanceof TFolder) {
      await this.onCreateFolder(resolved.workspaceId, resolved.serverPath);
      return;
    }

    if (file instanceof TFile && isMarkdownPath(file.path)) {
      await this.onCreateMarkdown(
        resolved.workspaceId,
        resolved.serverPath,
        await this.readMarkdownFile(file)
      );
      return;
    }

    if (file instanceof TFile) {
      const existingEntry = this.getEntryByPath(resolved.workspaceId, resolved.serverPath);
      if (existingEntry && existingEntry.kind === "binary" && !existingEntry.deleted) {
        await this.onUpdateBinary(
          resolved.workspaceId,
          existingEntry,
          await this.readBinaryFile(file)
        );
        return;
      }

      await this.onCreateBinary(
        resolved.workspaceId,
        resolved.serverPath,
        await this.readBinaryFile(file)
      );
      return;
    }
  }

  async handleVaultModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) {
      return;
    }

    const resolved = this.resolveRoomPath(file.path);
    if (!resolved || this.isSuppressedPath(file.path) || isMarkdownPath(file.path)) {
      return;
    }

    if (this.consumeRecentRemoteWrite(file.path) || this.consumeRecentRemoteCreate(file.path)) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (this.wasPathRecentlyObservedAsRemote?.(resolved.workspaceId, file.path)) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    if (
      this.isProtectedRemoteBinaryPlaceholder(file.path) &&
      !this.hasPendingBinaryWrite(file.path)
    ) {
      this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
      return;
    }

    const existingEntry = this.getEntryByPath(resolved.workspaceId, resolved.serverPath);
    if (existingEntry && !existingEntry.deleted) {
      if (!existingEntry.blob && !this.hasPendingBinaryWrite(file.path)) {
        this.onRemotePathObserved?.(resolved.workspaceId, file.path, resolved.serverPath);
        return;
      }

      await this.onUpdateBinary(
        resolved.workspaceId,
        existingEntry,
        await this.readBinaryFile(file)
      );
      return;
    }

    if (!this.hasPendingDelete(resolved.workspaceId, resolved.serverPath)) {
      await this.onCreateBinary(
        resolved.workspaceId,
        resolved.serverPath,
        await this.readBinaryFile(file)
      );
    }
  }

  async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.isSuppressedPath(oldPath) || this.isSuppressedPath(file.path)) {
      return;
    }

    if (this.consumeRecentRemoteRename(oldPath, file.path)) {
      return;
    }

    const oldResolved = this.resolveRoomPath(oldPath);
    const newResolved = this.resolveRoomPath(file.path);

    if (!oldResolved && !newResolved) {
      return;
    }

    if (!oldResolved && newResolved) {
      this.forgetRecentRemoteHistory(file.path);
      await this.handleVaultCreate(file);
      return;
    }

    if (oldResolved && !newResolved) {
      this.forgetRecentRemoteHistory(oldPath);
      this.forgetRecentRemoteHistory(file.path);
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

    this.forgetRecentRemoteHistory(oldPath);
    this.forgetRecentRemoteHistory(file.path);
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

    if (this.consumeRecentRemoteDelete(file.path)) {
      return;
    }

    this.forgetRecentRemoteHistory(file.path);
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
    this.markRecentRemoteRename(oldLocalPath, newLocalPath);
    await this.withSuppressedPaths([oldLocalPath, newLocalPath], async () => {
      await this.app.fileManager.renameFile(existing, newLocalPath);
    });
    this.moveProtectedRemoteBinaryPlaceholder(oldLocalPath, newLocalPath);
  }

  private async ensureLocalEntry(workspaceId: string, folderName: string, entry: FileEntry): Promise<void> {
    const localPath = toLocalPathForRoom(this.getSyncRoot(), folderName, entry.path);
    const existing = await this.getExistingPath(localPath);

    if (entry.kind === "folder") {
      await this.ensureFolderExists(localPath);
      return;
    }

    await this.ensureFolderExists(getParentPath(localPath));

    if (existing) {
      return;
    }

    if (entry.kind === "markdown") {
      this.markRecentRemoteCreate(localPath);
      this.onRemotePathObserved?.(workspaceId, localPath, entry.path);
      await this.withSuppressedPaths([localPath], async () => {
        await this.app.vault.create(localPath, "");
      });
      return;
    }

    this.markRecentRemoteCreate(localPath);
    this.markRecentRemoteWrite(localPath);
    this.markProtectedRemoteBinaryPlaceholder(localPath);
    this.onRemotePathObserved?.(workspaceId, localPath, entry.path);
    await this.withSuppressedPaths([localPath], async () => {
      await this.app.vault.createBinary(localPath, new ArrayBuffer(0));
    });
  }

  private async trashLocalEntry(folderName: string, serverPath: string): Promise<void> {
    const localPath = toLocalPathForRoom(this.getSyncRoot(), folderName, serverPath);
    const existing = this.app.vault.getAbstractFileByPath(localPath);
    if (!existing) {
      return;
    }

    this.markRecentRemoteDelete(localPath);
    this.clearProtectedRemoteBinaryPlaceholder(localPath);
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
      const existing = await this.getExistingPath(currentPath);

      if (existing instanceof TFolder || existing === "exists-on-disk") {
        continue;
      }

      if (existing) {
        throw new Error(`Expected folder at ${currentPath}, but a file already exists there.`);
      }

      this.markRecentRemoteCreate(currentPath);
      await this.withSuppressedPaths([currentPath], async () => {
        await this.app.vault.createFolder(currentPath);
      });
    }
  }

  private async getExistingPath(path: string): Promise<TAbstractFile | "exists-on-disk" | null> {
    // During startup the vault metadata index can be briefly behind the real
    // filesystem. The adapter fallback prevents false "Folder already exists"
    // races while restoring authoritative room snapshots into already
    // installed local folders.
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      return existing;
    }

    try {
      return (await this.app.vault.adapter.exists(normalizePath(path))) ? "exists-on-disk" : null;
    } catch {
      return null;
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

  private async readBinaryFile(file: TFile): Promise<ArrayBuffer> {
    try {
      return await this.app.vault.readBinary(file);
    } catch (error) {
      this.log(`Failed to read binary content for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      return new ArrayBuffer(0);
    }
  }

  async writeBinaryContent(workspaceId: string, serverPath: string, data: ArrayBuffer): Promise<string | null> {
    const folderName = this.getFolderName(workspaceId);
    if (!folderName) {
      return null;
    }

    const localPath = toLocalPathForRoom(this.getSyncRoot(), folderName, serverPath);
    await this.ensureFolderExists(getParentPath(localPath));
    const existing = this.app.vault.getAbstractFileByPath(localPath);

    if (existing instanceof TFile) {
      this.markRecentRemoteWrite(localPath);
      await this.withSuppressedPaths([localPath], async () => {
        await this.app.vault.modifyBinary(existing, data);
      });
      this.clearProtectedRemoteBinaryPlaceholder(localPath);
      return localPath;
    }

    if (existing) {
      throw new Error(`Cannot write binary content to ${localPath} because a folder already exists there.`);
    }

    this.markRecentRemoteCreate(localPath);
    this.markRecentRemoteWrite(localPath);
    this.onRemotePathObserved?.(workspaceId, localPath, serverPath);
    await this.withSuppressedPaths([localPath], async () => {
      await this.app.vault.createBinary(localPath, data);
    });
    this.clearProtectedRemoteBinaryPlaceholder(localPath);
    return localPath;
  }

  getProtectedRemoteBinaryPlaceholderPaths(): string[] {
    return [...this.protectedRemoteBinaryPlaceholders.keys()];
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

  private markRecentRemoteCreate(path: string): void {
    const normalizedPath = normalizePath(path);
    const previousHandle = this.recentRemoteCreates.get(normalizedPath);
    if (previousHandle !== undefined) {
      window.clearTimeout(previousHandle);
    }

    const handle = window.setTimeout(() => {
      this.recentRemoteCreates.delete(normalizedPath);
    }, FileBridge.REMOTE_CREATE_GUARD_MS);
    this.recentRemoteCreates.set(normalizedPath, handle);
  }

  private consumeRecentRemoteCreate(path: string): boolean {
    const normalizedPath = normalizePath(path);
    const handle = this.recentRemoteCreates.get(normalizedPath);
    if (handle === undefined) {
      return false;
    }

    window.clearTimeout(handle);
    this.recentRemoteCreates.delete(normalizedPath);
    this.log(`Ignored create echo for remotely materialized path ${normalizedPath}.`);
    return true;
  }

  private markRecentRemoteWrite(path: string): void {
    const normalizedPath = normalizePath(path);
    const previousHandle = this.recentRemoteWrites.get(normalizedPath);
    if (previousHandle !== undefined) {
      window.clearTimeout(previousHandle);
    }

    const handle = window.setTimeout(() => {
      this.recentRemoteWrites.delete(normalizedPath);
    }, FileBridge.REMOTE_WRITE_GUARD_MS);
    this.recentRemoteWrites.set(normalizedPath, handle);
  }

  private consumeRecentRemoteWrite(path: string): boolean {
    const normalizedPath = normalizePath(path);
    const handle = this.recentRemoteWrites.get(normalizedPath);
    if (handle === undefined) {
      return false;
    }

    window.clearTimeout(handle);
    this.recentRemoteWrites.delete(normalizedPath);
    this.log(`Ignored modify echo for remotely materialized path ${normalizedPath}.`);
    return true;
  }

  private markRecentRemoteRename(oldPath: string, newPath: string): void {
    const key = this.buildRemoteRenameKey(oldPath, newPath);
    const previousHandle = this.recentRemoteRenames.get(key);
    if (previousHandle !== undefined) {
      window.clearTimeout(previousHandle);
    }

    const handle = window.setTimeout(() => {
      this.recentRemoteRenames.delete(key);
    }, FileBridge.REMOTE_CREATE_GUARD_MS);
    this.recentRemoteRenames.set(key, handle);
  }

  private consumeRecentRemoteRename(oldPath: string, newPath: string): boolean {
    const key = this.buildRemoteRenameKey(oldPath, newPath);
    const handle = this.recentRemoteRenames.get(key);
    if (handle === undefined) {
      return false;
    }

    window.clearTimeout(handle);
    this.recentRemoteRenames.delete(key);
    this.log(`Ignored rename echo for remotely materialized path ${normalizePath(oldPath)} -> ${normalizePath(newPath)}.`);
    return true;
  }

  private markRecentRemoteDelete(path: string): void {
    const normalizedPath = normalizePath(path);
    const previousHandle = this.recentRemoteDeletes.get(normalizedPath);
    if (previousHandle !== undefined) {
      window.clearTimeout(previousHandle);
    }

    const handle = window.setTimeout(() => {
      this.recentRemoteDeletes.delete(normalizedPath);
    }, FileBridge.REMOTE_CREATE_GUARD_MS);
    this.recentRemoteDeletes.set(normalizedPath, handle);
  }

  private consumeRecentRemoteDelete(path: string): boolean {
    const normalizedPath = normalizePath(path);
    const handle = this.recentRemoteDeletes.get(normalizedPath);
    if (handle === undefined) {
      return false;
    }

    window.clearTimeout(handle);
    this.recentRemoteDeletes.delete(normalizedPath);
    this.log(`Ignored delete echo for remotely materialized path ${normalizedPath}.`);
    return true;
  }

  private markProtectedRemoteBinaryPlaceholder(path: string): void {
    const normalizedPath = normalizePath(path);
    const previousHandle = this.protectedRemoteBinaryPlaceholders.get(normalizedPath);
    if (previousHandle !== undefined) {
      window.clearTimeout(previousHandle);
    }

    const handle = window.setTimeout(() => {
      this.protectedRemoteBinaryPlaceholders.delete(normalizedPath);
    }, FileBridge.REMOTE_BINARY_PLACEHOLDER_GUARD_MS);
    this.protectedRemoteBinaryPlaceholders.set(normalizedPath, handle);
  }

  private clearProtectedRemoteBinaryPlaceholder(path: string): void {
    const normalizedPath = normalizePath(path);
    const handle = this.protectedRemoteBinaryPlaceholders.get(normalizedPath);
    if (handle === undefined) {
      return;
    }

    window.clearTimeout(handle);
    this.protectedRemoteBinaryPlaceholders.delete(normalizedPath);
  }

  private moveProtectedRemoteBinaryPlaceholder(oldPath: string, newPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const handle = this.protectedRemoteBinaryPlaceholders.get(normalizedOldPath);
    if (handle === undefined) {
      return;
    }

    window.clearTimeout(handle);
    this.protectedRemoteBinaryPlaceholders.delete(normalizedOldPath);
    this.markProtectedRemoteBinaryPlaceholder(newPath);
  }

  private isProtectedRemoteBinaryPlaceholder(path: string): boolean {
    return this.protectedRemoteBinaryPlaceholders.has(normalizePath(path));
  }

  private forgetRecentRemoteHistory(path: string): void {
    const normalizedPath = normalizePath(path);

    const createHandle = this.recentRemoteCreates.get(normalizedPath);
    if (createHandle !== undefined) {
      window.clearTimeout(createHandle);
      this.recentRemoteCreates.delete(normalizedPath);
    }

    const writeHandle = this.recentRemoteWrites.get(normalizedPath);
    if (writeHandle !== undefined) {
      window.clearTimeout(writeHandle);
      this.recentRemoteWrites.delete(normalizedPath);
    }

    const deleteHandle = this.recentRemoteDeletes.get(normalizedPath);
    if (deleteHandle !== undefined) {
      window.clearTimeout(deleteHandle);
      this.recentRemoteDeletes.delete(normalizedPath);
    }

    for (const [key, handle] of [...this.recentRemoteRenames.entries()]) {
      if (!key.startsWith(`${normalizedPath}=>`) && !key.endsWith(`=>${normalizedPath}`)) {
        continue;
      }

      window.clearTimeout(handle);
      this.recentRemoteRenames.delete(key);
    }
  }

  private buildRemoteRenameKey(oldPath: string, newPath: string): string {
    return `${normalizePath(oldPath)}=>${normalizePath(newPath)}`;
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
