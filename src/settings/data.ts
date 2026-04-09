import { Platform } from "obsidian";
import type { GlobalRole, User } from "../types/protocol";
import { normalizeSha256Hash } from "../utils/sha256";

export const ROLAY_SERVER_URL = "http://46.16.36.87:3000";
export const ROLAY_DEVICE_NAME = Platform.isMobile ? "Obsidian Mobile" : "Obsidian Desktop";
export const ROLAY_AUTO_CONNECT = true;

export interface RolayRoomBindingSettings {
  folderName: string;
  downloaded: boolean;
}

export interface RolayPluginSettings {
  serverUrl: string;
  username: string;
  password: string;
  syncRoot: string;
  deviceName: string;
  autoConnect: boolean;
  roomBindings: Record<string, RolayRoomBindingSettings>;
}

export interface RolaySessionState {
  accessToken: string;
  refreshToken: string;
  user: User | null;
  authenticatedAt: string;
}

export interface RolayRoomSyncState {
  lastCursor: number | null;
  lastSnapshotAt: string | null;
}

export interface RolaySyncState {
  rooms: Record<string, RolayRoomSyncState>;
}

export interface RolayLogEntry {
  at: string;
  level: "info" | "error";
  scope: string;
  message: string;
}

export interface RolayCrdtCacheEntry {
  encodedState: string;
  filePath: string;
  updatedAt: string;
}

export interface RolayCrdtCacheState {
  entries: Record<string, RolayCrdtCacheEntry>;
}

export interface RolayBinaryCacheEntry {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  filePath: string;
  updatedAt: string;
}

export interface RolayBinaryCacheState {
  entries: Record<string, RolayBinaryCacheEntry>;
}

export interface RolayPendingMarkdownCreateEntry {
  workspaceId: string;
  localPath: string;
  serverPath: string;
  createdAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface RolayPendingMarkdownMergeEntry {
  workspaceId: string;
  entryId: string;
  localPath: string;
  filePath: string;
  createdAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface RolayPendingBinaryWriteEntry {
  workspaceId: string;
  localPath: string;
  serverPath: string;
  entryId: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface RolayPluginData {
  settings: RolayPluginSettings;
  session: RolaySessionState | null;
  sync: RolaySyncState;
  crdtCache: RolayCrdtCacheState;
  binaryCache: RolayBinaryCacheState;
  pendingMarkdownCreates: Record<string, RolayPendingMarkdownCreateEntry>;
  pendingMarkdownMerges: Record<string, RolayPendingMarkdownMergeEntry>;
  pendingBinaryWrites: Record<string, RolayPendingBinaryWriteEntry>;
  deviceId: string;
  logs: RolayLogEntry[];
}

interface LegacyRoomBindingSettings extends Partial<RolayRoomBindingSettings> {
  localFolderName?: string;
}

interface LegacyRolayPluginSettings {
  serverUrl?: string;
  username?: string;
  password?: string;
  syncRoot?: string;
  deviceName?: string;
  autoConnect?: boolean;
  workspaceId?: string;
  activeRoomId?: string;
  roomBindings?: Record<string, LegacyRoomBindingSettings>;
}

export const DEFAULT_SETTINGS: RolayPluginSettings = {
  serverUrl: ROLAY_SERVER_URL,
  username: "",
  password: "",
  syncRoot: "Rolay",
  deviceName: ROLAY_DEVICE_NAME,
  autoConnect: ROLAY_AUTO_CONNECT,
  roomBindings: {}
};

export function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

export function createDefaultPluginData(): RolayPluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, roomBindings: {} },
    session: null,
    sync: {
      rooms: {}
    },
    crdtCache: {
      entries: {}
    },
    binaryCache: {
      entries: {}
    },
    pendingMarkdownCreates: {},
    pendingMarkdownMerges: {},
    pendingBinaryWrites: {},
    deviceId: createDeviceId(),
    logs: []
  };
}

export function mergePluginData(rawData: Partial<RolayPluginData> | null | undefined): RolayPluginData {
  const defaults = createDefaultPluginData();
  const rawSession = rawData?.session ?? null;
  const rawSettings = (rawData?.settings ?? {}) as LegacyRolayPluginSettings;
  const normalizedSettings: RolayPluginSettings = {
    ...defaults.settings,
    ...rawSettings,
    serverUrl: ROLAY_SERVER_URL,
    syncRoot: (rawSettings.syncRoot ?? defaults.settings.syncRoot).trim(),
    deviceName: ROLAY_DEVICE_NAME,
    autoConnect: ROLAY_AUTO_CONNECT,
    roomBindings: normalizeRoomBindings(rawSettings)
  };
  const hasSessionTokens = Boolean(
    rawSession?.accessToken?.trim() || rawSession?.refreshToken?.trim()
  );
  const normalizedSession = rawSession && hasSessionTokens
    ? {
        ...rawSession,
        accessToken: typeof rawSession.accessToken === "string" ? rawSession.accessToken : "",
        refreshToken: typeof rawSession.refreshToken === "string" ? rawSession.refreshToken : "",
        user: normalizeUser(rawSession.user)
      }
    : defaults.session;

  return {
    ...defaults,
    ...rawData,
    settings: normalizedSettings,
    session: normalizedSession,
    sync: {
      rooms: normalizeRoomSyncMap(rawData?.sync)
    },
    crdtCache: normalizeCrdtCacheState(rawData?.crdtCache),
    binaryCache: normalizeBinaryCacheState(rawData?.binaryCache),
    pendingMarkdownCreates: normalizePendingMarkdownCreates(rawData?.pendingMarkdownCreates),
    pendingMarkdownMerges: normalizePendingMarkdownMerges(rawData?.pendingMarkdownMerges),
    pendingBinaryWrites: normalizePendingBinaryWrites(rawData?.pendingBinaryWrites),
    deviceId: rawData?.deviceId ?? defaults.deviceId,
    logs: Array.isArray(rawData?.logs) ? rawData.logs.slice(-100) : defaults.logs
  };
}

export function getRoomSyncState(
  sync: RolaySyncState,
  roomId: string | null | undefined
): RolayRoomSyncState {
  if (!roomId) {
    return {
      lastCursor: null,
      lastSnapshotAt: null
    };
  }

  return (
    sync.rooms[roomId] ?? {
      lastCursor: null,
      lastSnapshotAt: null
    }
  );
}

export function getRoomBindingSettings(
  settings: RolayPluginSettings,
  roomId: string
): RolayRoomBindingSettings | null {
  return settings.roomBindings[roomId] ?? null;
}

function normalizeRoomBindings(
  rawSettings: LegacyRolayPluginSettings
): Record<string, RolayRoomBindingSettings> {
  const normalized: Record<string, RolayRoomBindingSettings> = {};
  const rawBindings = rawSettings.roomBindings;

  if (rawBindings && typeof rawBindings === "object") {
    for (const [roomId, binding] of Object.entries(rawBindings)) {
      const rawFolderName = (binding.folderName ?? binding.localFolderName ?? "").trim();
      const folderName = rawFolderName === roomId ? "" : rawFolderName;
      normalized[roomId] = {
        folderName,
        downloaded: Boolean(binding.downloaded)
      };
    }
  }

  const legacyActiveRoomId = (rawSettings.activeRoomId ?? rawSettings.workspaceId ?? "").trim();
  if (legacyActiveRoomId && !(legacyActiveRoomId in normalized)) {
    normalized[legacyActiveRoomId] = {
      folderName: "",
      downloaded: true
    };
  }

  return normalized;
}

function normalizeRoomSyncMap(
  rawSync: Partial<RolaySyncState> | undefined
): Record<string, RolayRoomSyncState> {
  const rooms: Record<string, RolayRoomSyncState> = {};
  const rawRooms = rawSync?.rooms;

  if (rawRooms && typeof rawRooms === "object") {
    for (const [roomId, rawState] of Object.entries(rawRooms)) {
      rooms[roomId] = normalizeRoomSyncState(rawState);
    }
  }

  return rooms;
}

function normalizeRoomSyncState(rawState: unknown): RolayRoomSyncState {
  if (!rawState || typeof rawState !== "object") {
    return {
      lastCursor: null,
      lastSnapshotAt: null
    };
  }

  const candidate = rawState as { lastCursor?: unknown; lastSnapshotAt?: unknown };
  return {
    lastCursor: typeof candidate.lastCursor === "number" ? candidate.lastCursor : null,
    lastSnapshotAt: typeof candidate.lastSnapshotAt === "string" ? candidate.lastSnapshotAt : null
  };
}

function normalizeCrdtCacheState(rawCache: unknown): RolayCrdtCacheState {
  if (!rawCache || typeof rawCache !== "object") {
    return {
      entries: {}
    };
  }

  const rawEntries = (rawCache as { entries?: unknown }).entries;
  if (!rawEntries || typeof rawEntries !== "object") {
    return {
      entries: {}
    };
  }

  const entries: Record<string, RolayCrdtCacheEntry> = {};
  for (const [entryId, rawEntry] of Object.entries(rawEntries)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const candidate = rawEntry as Partial<RolayCrdtCacheEntry>;
    if (typeof candidate.encodedState !== "string" || !candidate.encodedState) {
      continue;
    }

    entries[entryId] = {
      encodedState: candidate.encodedState,
      filePath: typeof candidate.filePath === "string" ? candidate.filePath : "",
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString()
    };
  }

  return { entries };
}

function normalizePendingMarkdownCreates(
  rawPendingCreates: unknown
): Record<string, RolayPendingMarkdownCreateEntry> {
  if (!rawPendingCreates || typeof rawPendingCreates !== "object") {
    return {};
  }

  const entries: Record<string, RolayPendingMarkdownCreateEntry> = {};
  for (const [rawLocalPath, rawPendingCreate] of Object.entries(rawPendingCreates)) {
    if (!rawPendingCreate || typeof rawPendingCreate !== "object") {
      continue;
    }

    const candidate = rawPendingCreate as Partial<RolayPendingMarkdownCreateEntry>;
    const localPath = normalizeStoredPath(candidate.localPath ?? rawLocalPath);
    const serverPath = normalizeStoredPath(candidate.serverPath ?? "");
    const workspaceId = typeof candidate.workspaceId === "string" ? candidate.workspaceId.trim() : "";
    if (!localPath || !serverPath || !workspaceId) {
      continue;
    }

    entries[localPath] = {
      workspaceId,
      localPath,
      serverPath,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
      lastAttemptAt: typeof candidate.lastAttemptAt === "string" ? candidate.lastAttemptAt : null,
      lastError: typeof candidate.lastError === "string" ? candidate.lastError : null
    };
  }

  return entries;
}

function normalizePendingMarkdownMerges(
  rawPendingMerges: unknown
): Record<string, RolayPendingMarkdownMergeEntry> {
  if (!rawPendingMerges || typeof rawPendingMerges !== "object") {
    return {};
  }

  const entries: Record<string, RolayPendingMarkdownMergeEntry> = {};
  for (const [rawEntryId, rawPendingMerge] of Object.entries(rawPendingMerges)) {
    if (!rawPendingMerge || typeof rawPendingMerge !== "object") {
      continue;
    }

    const candidate = rawPendingMerge as Partial<RolayPendingMarkdownMergeEntry>;
    const entryId = typeof candidate.entryId === "string" ? candidate.entryId.trim() : rawEntryId.trim();
    const localPath = normalizeStoredPath(candidate.localPath ?? "");
    const filePath = normalizeStoredPath(candidate.filePath ?? "");
    const workspaceId = typeof candidate.workspaceId === "string" ? candidate.workspaceId.trim() : "";
    if (!entryId || !localPath || !filePath || !workspaceId) {
      continue;
    }

    entries[entryId] = {
      workspaceId,
      entryId,
      localPath,
      filePath,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
      lastAttemptAt: typeof candidate.lastAttemptAt === "string" ? candidate.lastAttemptAt : null,
      lastError: typeof candidate.lastError === "string" ? candidate.lastError : null
    };
  }

  return entries;
}

function normalizeBinaryCacheState(rawCache: unknown): RolayBinaryCacheState {
  if (!rawCache || typeof rawCache !== "object") {
    return {
      entries: {}
    };
  }

  const rawEntries = (rawCache as { entries?: unknown }).entries;
  if (!rawEntries || typeof rawEntries !== "object") {
    return {
      entries: {}
    };
  }

  const entries: Record<string, RolayBinaryCacheEntry> = {};
  for (const [entryId, rawEntry] of Object.entries(rawEntries)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const candidate = rawEntry as Partial<RolayBinaryCacheEntry>;
    const normalizedHash = normalizeSha256Hash(candidate.hash);
    if (!normalizedHash) {
      continue;
    }

    entries[entryId] = {
      hash: normalizedHash,
      sizeBytes: typeof candidate.sizeBytes === "number" && candidate.sizeBytes >= 0 ? candidate.sizeBytes : 0,
      mimeType: typeof candidate.mimeType === "string" && candidate.mimeType ? candidate.mimeType : "application/octet-stream",
      filePath: typeof candidate.filePath === "string" ? normalizeStoredPath(candidate.filePath) : "",
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString()
    };
  }

  return { entries };
}

function normalizePendingBinaryWrites(
  rawPendingWrites: unknown
): Record<string, RolayPendingBinaryWriteEntry> {
  if (!rawPendingWrites || typeof rawPendingWrites !== "object") {
    return {};
  }

  const entries: Record<string, RolayPendingBinaryWriteEntry> = {};
  for (const [rawLocalPath, rawPendingWrite] of Object.entries(rawPendingWrites)) {
    if (!rawPendingWrite || typeof rawPendingWrite !== "object") {
      continue;
    }

    const candidate = rawPendingWrite as Partial<RolayPendingBinaryWriteEntry>;
    const localPath = normalizeStoredPath(candidate.localPath ?? rawLocalPath);
    const serverPath = normalizeStoredPath(candidate.serverPath ?? "");
    const workspaceId = typeof candidate.workspaceId === "string" ? candidate.workspaceId.trim() : "";
    if (!localPath || !serverPath || !workspaceId) {
      continue;
    }

    entries[localPath] = {
      workspaceId,
      localPath,
      serverPath,
      entryId: typeof candidate.entryId === "string" && candidate.entryId.trim() ? candidate.entryId.trim() : null,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
      lastAttemptAt: typeof candidate.lastAttemptAt === "string" ? candidate.lastAttemptAt : null,
      lastError: typeof candidate.lastError === "string" ? candidate.lastError : null
    };
  }

  return entries;
}

function normalizeUser(user: User | null | undefined): User | null {
  if (!user) {
    return null;
  }

  return {
    ...user,
    isAdmin: Boolean(user.isAdmin),
    globalRole: normalizeGlobalRole((user as User).globalRole)
  };
}

function normalizeGlobalRole(globalRole: GlobalRole | string | undefined): GlobalRole {
  if (globalRole === "admin" || globalRole === "writer" || globalRole === "reader") {
    return globalRole;
  }

  return "reader";
}

function createDeviceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `rolay-device-${Date.now()}`;
}

function normalizeStoredPath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}
