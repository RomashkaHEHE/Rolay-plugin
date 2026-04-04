import { normalizePath } from "obsidian";

export function normalizeSyncRoot(syncRoot: string): string {
  const trimmed = syncRoot.trim();
  if (!trimmed) {
    return "";
  }

  return normalizePath(trimmed);
}

export function normalizeRoomFolderName(folderName: string): string {
  return folderName.trim();
}

export function isValidRoomFolderName(folderName: string): boolean {
  const normalized = normalizeRoomFolderName(folderName);
  return Boolean(normalized) && !/[\\/]/.test(normalized);
}

export function getRoomRoot(syncRoot: string, folderName: string | null | undefined): string {
  const normalizedSyncRoot = normalizeSyncRoot(syncRoot);
  const normalizedFolderName = normalizeRoomFolderName(folderName ?? "");

  if (!normalizedFolderName) {
    return normalizedSyncRoot;
  }

  if (!normalizedSyncRoot) {
    return normalizedFolderName;
  }

  return normalizePath(`${normalizedSyncRoot}/${normalizedFolderName}`);
}

export function toLocalPathForRoom(
  syncRoot: string,
  folderName: string,
  serverPath: string
): string {
  const roomRoot = getRoomRoot(syncRoot, folderName);
  const normalizedServerPath = normalizePath(serverPath);

  if (!roomRoot) {
    return normalizedServerPath;
  }

  if (!normalizedServerPath) {
    return roomRoot;
  }

  return normalizePath(`${roomRoot}/${normalizedServerPath}`);
}

export function toServerPathForRoom(
  localPath: string,
  syncRoot: string,
  folderName: string | null | undefined
): string | null {
  const normalizedLocalPath = normalizePath(localPath);
  const roomRoot = getRoomRoot(syncRoot, folderName);

  if (!roomRoot) {
    return normalizedLocalPath;
  }

  if (normalizedLocalPath === roomRoot) {
    return "";
  }

  if (!normalizedLocalPath.startsWith(`${roomRoot}/`)) {
    return null;
  }

  return normalizedLocalPath.slice(roomRoot.length + 1);
}

export function isManagedPathForRoom(
  localPath: string,
  syncRoot: string,
  folderName: string | null | undefined
): boolean {
  const normalizedLocalPath = normalizePath(localPath);
  const roomRoot = getRoomRoot(syncRoot, folderName);

  if (!roomRoot) {
    return true;
  }

  return normalizedLocalPath === roomRoot || normalizedLocalPath.startsWith(`${roomRoot}/`);
}
