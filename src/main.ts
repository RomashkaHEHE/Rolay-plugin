import { MarkdownView, Notice, Plugin, TFile, normalizePath, setIcon, type TAbstractFile } from "obsidian";
import * as Y from "yjs";
import { RolayApiClient, RolayApiError } from "./api/client";
import { FileBridge } from "./obsidian/file-bridge";
import {
  buildPresenceColor,
  createMarkdownTextState,
  CrdtSessionManager,
  type LocalNotePresenceViewer
} from "./realtime/crdt-session";
import { createSharedPresenceExtension, getMarkdownViewsForFile } from "./realtime/shared-presence";
import {
  type RolayBinaryCacheEntry,
  type RolayBinaryTransferEntry,
  getRoomBindingSettings,
  ROLAY_AUTO_CONNECT,
  ROLAY_DEVICE_NAME,
  ROLAY_SERVER_URL,
  type RolayCrdtCacheEntry,
  getRoomSyncState,
  mergePluginData,
  normalizePresenceColor,
  normalizeServerUrl,
  type RolayLogEntry,
  type RolayPendingBinaryWriteEntry,
  type RolayPendingMarkdownCreateEntry,
  type RolayPendingMarkdownMergeEntry,
  type RolayPluginData,
  type RolayPluginSettings,
  type RolayRoomBindingSettings
} from "./settings/data";
import { RolaySettingTab } from "./settings/tab";
import { WorkspaceEventStream, type WorkspaceEventStreamStatus } from "./sync/event-stream";
import { OperationsQueue, RolayOperationError } from "./sync/operations";
import { SettingsEventStream } from "./sync/settings-stream";
import { NotePresenceEventStream } from "./sync/note-presence-stream";
import {
  getRoomRoot,
  isValidRoomFolderName,
  normalizeRoomFolderName,
  toServerPathForRoom
} from "./sync/path-mapper";
import { TreeStore } from "./sync/tree-store";
import type {
  AddRoomMemberRequest,
  AdminRoomListItem,
  CreateManagedUserRequest,
  CreateRoomRequest,
  FileEntry,
  InviteState,
  MarkdownBootstrapDocument,
  ManagedUser,
  NotePresenceSnapshotPayload,
  NotePresenceUpdatedPayload,
  NotePresenceViewer,
  RoomListItem,
  RoomPublicationState,
  RoomMember,
  SettingsEventEnvelope,
  SettingsRoomPublicationUpdatedPayload,
  SettingsStreamEvent,
  User
} from "./types/protocol";
import { openTextInputModal } from "./ui/text-input-modal";
import { isBinaryPath, isMarkdownPath, guessMimeTypeFromPath } from "./utils/file-kind";
import { decodeBase64, encodeBase64 } from "./utils/base64";
import { normalizeSha256Hash, sha256Hash } from "./utils/sha256";

// Main orchestration state for one downloaded room. This is keyed strictly by
// workspace.id so repeated room names cannot collide in memory or local sync.
interface RoomRuntimeState {
  treeStore: TreeStore;
  eventStream: WorkspaceEventStream | null;
  eventStreamGeneration: number;
  // Room-level note presence is a separate live stream aggregated by the
  // server from markdown awareness. We keep it per room so explorer badges and
  // viewer chips can update without opening every markdown document locally.
  notePresenceStream: NotePresenceEventStream | null;
  notePresenceStreamGeneration: number;
  notePresenceByEntryId: Map<string, NotePresenceViewer[]>;
  noteAnonymousViewerCountByEntryId: Map<string, number>;
  streamStatus: WorkspaceEventStreamStatus;
  lastHandledEventId: number | null;
  snapshotRefreshHandle: number | null;
  snapshotRefreshInFlight: boolean;
  snapshotRefreshQueuedReason: string | null;
  backgroundMarkdownRefreshHandle: number | null;
  backgroundMarkdownRefreshInFlight: boolean;
  lockedBootstrapRetryHandle: number | null;
  lockedBootstrapRetryAttempt: number;
  markdownBootstrap: RoomMarkdownBootstrapState;
}

interface RoomMarkdownBootstrapState {
  status: "idle" | "loading" | "ready" | "error";
  totalTargets: number;
  completedTargets: number;
  totalBytes: number;
  completedBytes: number;
  documentBytesByEntryId: Map<string, number>;
  completedEntryIds: Set<string>;
  hydratedTargets: number;
  lockedLocalPaths: Set<string>;
  lastRunAt: string | null;
  lastError: string | null;
  rerunRequested: boolean;
  runToken: number;
}

interface DownloadedRoomDescriptor {
  workspaceId: string;
  folderName: string;
}

type BinaryTransferKind = "upload" | "download";
type BinaryTransferStatus =
  | "preparing"
  | "uploading"
  | "canceling"
  | "downloading"
  | "committing"
  | "done"
  | "failed";

interface BinaryTransferState {
  workspaceId: string;
  entryId: string | null;
  localPath: string;
  serverPath: string;
  kind: BinaryTransferKind;
  status: BinaryTransferStatus;
  bytesTotal: number;
  bytesDone: number;
  hash: string | null;
  mimeType: string | null;
  uploadId: string | null;
  cancelUrl: string | null;
  lastError: string | null;
  rangeSupported: boolean;
  createdAt: string;
  updatedAt: string;
  rerunRequested: boolean;
  abortController: AbortController | null;
}

// Runtime transfer state mirrors persisted binaryTransfers entries. The
// persisted copy is the crash-recovery source of truth, while this in-memory
// layer adds live AbortController handles and rerun bookkeeping.

interface ExplorerNotePresenceBadgeState {
  count: number;
  color: string;
}

interface ExplorerAnonymousPresenceBadgeState {
  count: number;
}

interface NotePresenceDisplayState {
  viewers: NotePresenceViewer[];
  anonymousViewerCount: number;
}

interface ExplorerTransferBadgeState {
  label: string;
  kind: BinaryTransferKind;
}

interface ExplorerTransferBadgeAggregate {
  kind: BinaryTransferKind;
  completedBytes: number;
  totalBytes: number;
  itemCount: number;
}

export interface RoomCardState {
  room: RoomListItem;
  folderName: string;
  downloaded: boolean;
  localRoot: string;
  folderExists: boolean;
  streamStatus: WorkspaceEventStreamStatus;
  lastCursorLabel: string;
  lastSnapshotLabel: string;
  entryCount: number;
  markdownEntryCount: number;
  cachedMarkdownCount: number;
  crdtCacheLabel: string;
  binaryTransferLabel: string;
  invite: InviteState | null;
  publication: RoomPublicationState;
}

interface StatusSnapshot {
  userLabel: string;
  globalRoleLabel: string;
  isAdmin: boolean;
  downloadedRoomCount: number;
  activeStreamCount: number;
  crdtLabel: string;
  persistentLogPath: string;
  recentLogs: string[];
}

interface PasswordChangeDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default class RolayPlugin extends Plugin {
  private static readonly MAX_PERSISTED_CRDT_DOCS = 64;
  private static readonly MAX_PERSISTED_BINARY_ENTRIES = 128;
  private static readonly ENABLE_BLOB_TRANSFER_TRACE = true;
  private static readonly BINARY_TRANSFER_PARTS_FOLDER = "transfers";
  private static readonly BINARY_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
  private static readonly MAX_BINARY_UPLOAD_OFFSET_RECOVERY_ATTEMPTS = 8;
  private static readonly LOG_FILE_RETENTION_MS = 48 * 60 * 60 * 1000;
  private static readonly MAX_LOG_FILE_BYTES = 256 * 1024;
  private static readonly LOG_FILE_TRIM_TARGET_BYTES = 192 * 1024;
  private static readonly LOG_FILE_NAME = "rolay-sync.log";
  private static readonly PENDING_CREATE_CONFIRMATION_TTL_MS = 60_000;
  private static readonly RECENT_REMOTE_PATH_TTL_MS = 30_000;
  private static readonly REMOTE_MARKDOWN_SETTLE_TTL_MS = 15_000;
  private static readonly ROOM_MARKDOWN_REFRESH_INTERVAL_MS = 5_000;
  private static readonly ROOM_MARKDOWN_REFRESH_AFTER_SNAPSHOT_MS = 1_200;
  private static readonly MARKDOWN_BOOTSTRAP_BATCH_MAX_DOCS = 8;
  private static readonly MARKDOWN_BOOTSTRAP_BATCH_TARGET_ENCODED_BYTES = 512 * 1024;
  private static readonly BINARY_DOWNLOAD_CONCURRENCY = 2;
  private static readonly PENDING_DELETE_GUARD_MS = 60_000;
  private static readonly STARTUP_BOOTSTRAP_DELAY_MS = 1_500;
  private static readonly STARTUP_ROOM_CONNECT_STAGGER_MS = 900;
  private data!: RolayPluginData;
  private apiClient!: RolayApiClient;
  private crdtManager!: CrdtSessionManager;
  private operationsQueue!: OperationsQueue;
  private fileBridge!: FileBridge;
  private readonly roomRuntime = new Map<string, RoomRuntimeState>();
  private readonly roomInvites = new Map<string, InviteState>();
  private readonly pendingLocalCreates = new Map<string, number>();
  private readonly pendingLocalDeletes = new Map<string, number>();
  private readonly binaryTransferState = new Map<string, BinaryTransferState>();
  private readonly binarySyncTokens = new Map<string, string>();
  private readonly binarySyncPathsByToken = new Map<string, string>();
  private readonly pendingBinarySyncReruns = new Set<string>();
  private readonly recentRemoteObservedPaths = new Map<string, number>();
  private readonly pendingRemoteMarkdownSettles = new Map<string, number>();
  private persistHandle: number | null = null;
  private isUnloading = false;
  private explorerDecorationHandle: number | null = null;
  private explorerDecorationFrame: number | null = null;
  private explorerToggleRefreshHandle: number | null = null;
  private explorerMutationObserver: MutationObserver | null = null;
  private notePresenceUiHandle: number | null = null;
  private statusBarEl!: HTMLElement;
  private roomList: RoomListItem[] = [];
  private adminRoomList: AdminRoomListItem[] = [];
  private managedUsers: ManagedUser[] = [];
  private adminSelectedRoomId = "";
  private adminRoomMembers: RoomMember[] = [];
  private readonly roomMembersCache = new Map<string, RoomMember[]>();
  private logFlushHandle: number | null = null;
  private logFileWrite = Promise.resolve();
  private readonly pendingLogLines: string[] = [];
  private settingsTab!: RolaySettingTab;
  private settingsEventStream: SettingsEventStream | null = null;
  private settingsEventStreamGeneration = 0;
  private settingsEventCursor: number | null = null;
  private settingsEventStreamStatus: WorkspaceEventStreamStatus = "stopped";
  private settingsStreamRecoveryInFlight = false;
  private startupBootstrapHandle: number | null = null;
  private readonly startupRoomResumeHandles = new Set<number>();
  private profileDraftDisplayName = "";
  private passwordChangeDraft: PasswordChangeDraft = {
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  };
  private createRoomDraft: CreateRoomRequest = {
    name: ""
  };
  private joinRoomDraft = {
    code: ""
  };
  private managedUserDraft: CreateManagedUserRequest = {
    username: "",
    password: "",
    displayName: "",
    globalRole: "reader"
  };
  private adminRoomMemberDraft: AddRoomMemberRequest = {
    username: "",
    role: "member"
  };

  override async onload(): Promise<void> {
    this.isUnloading = false;
    this.data = mergePluginData(await this.loadData());
    this.data.logs = trimRecentLogEntries(this.data.logs, Date.now(), RolayPlugin.LOG_FILE_RETENTION_MS, 100);
    this.restorePersistedBinaryTransfers();
    this.resetProfileDraft();
    this.apiClient = new RolayApiClient({
      getServerUrl: () => normalizeServerUrl(this.data.settings.serverUrl),
      getSession: () => this.data.session,
      saveSession: async (session) => {
        this.data.session = session;
        if (!session) {
          this.stopSettingsEventStream();
        }
        await this.persistNow();
        this.updateStatusBar();
      }
    });
    this.crdtManager = new CrdtSessionManager({
      app: this.app,
      apiClient: this.apiClient,
      getCurrentUser: () => this.getCurrentUser(),
      getPresenceColor: () => this.getPresenceColor(),
      resolveWorkspaceIdByLocalPath: (localPath) => this.resolveDownloadedRoomByLocalPath(localPath)?.workspaceId ?? null,
      isLiveSyncEnabledForLocalPath: (localPath) => this.isLiveSyncEnabledForLocalPath(localPath),
      getPersistedCrdtState: (entryId) => this.getPersistedCrdtState(entryId),
      persistCrdtState: (entryId, filePath, state) => this.persistCrdtState(entryId, filePath, state),
      resolveEntryByLocalPath: (localPath) => this.resolveEntryByLocalPath(localPath),
      log: (message) => this.recordLog("crdt", message)
    });
    this.registerEditorExtension(
      createSharedPresenceExtension(({ filePath, editor, focused }) => {
        this.crdtManager.handleEditorSelectionChange(filePath, editor, focused);
      })
    );
    this.operationsQueue = new OperationsQueue({
      apiClient: this.apiClient,
      getDeviceId: () => this.data.deviceId,
      log: (message) => this.recordLog("ops", message),
      onTrace: (workspaceId, operation, reason, meta) => {
        if (operation.type !== "commit_blob_revision") {
          return;
        }

        this.traceBlob(
          `[${workspaceId}] commit_blob_revision entryId=${operation.entryId} hash=${operation.hash} sizeBytes=${operation.sizeBytes} ` +
          `entryVersion=${operation.preconditions?.entryVersion ?? "?"} path=${operation.preconditions?.path ?? "?"} ` +
          `reason=${reason} status=${meta.status} requestId=${meta.requestId ?? "-"}`
        );
      },
      onAfterApply: (workspaceId) => {
        this.scheduleSnapshotRefresh(workspaceId, "local-op");
      }
    });
    this.fileBridge = new FileBridge({
      app: this.app,
      getSyncRoot: () => this.data.settings.syncRoot,
      getFolderName: (workspaceId) => this.getDownloadedFolderName(workspaceId),
      getDownloadedRooms: () => this.getDownloadedRooms(),
      getEntryByPath: (workspaceId, path) => this.getRoomStore(workspaceId)?.getEntryByPath(path) ?? null,
      isWorkspaceSyncActive: (workspaceId) => this.isRoomSyncActive(workspaceId),
      hasPendingCreate: (workspaceId, path) => this.hasPendingLocalCreate(workspaceId, path),
      hasPendingDelete: (workspaceId, path) => this.hasPendingLocalDelete(workspaceId, path),
      hasPendingBinaryWrite: (localPath) => normalizePath(localPath) in this.data.pendingBinaryWrites,
      log: (message) => this.recordLog("bridge", message),
      onCreateFolder: (workspaceId, path) => this.queueCreateFolder(workspaceId, path),
      onCreateMarkdown: (workspaceId, path, localContent) => this.queueCreateMarkdown(workspaceId, path, localContent),
      onCreateBinary: (workspaceId, path, localContent) => this.queueBinaryWrite(workspaceId, path, localContent, null),
      onUpdateBinary: (workspaceId, entry, localContent) => this.queueBinaryWrite(workspaceId, entry.path, localContent, entry),
      onRenameOrMove: (workspaceId, entry, newPath, type) => this.queueRenameOrMove(workspaceId, entry, newPath, type),
      onDeleteEntry: (workspaceId, entry) => this.queueDeleteEntry(workspaceId, entry),
      onRemotePathObserved: (workspaceId, localPath, serverPath) => {
        this.noteRemoteObservedPath(workspaceId, localPath, serverPath);
      },
      wasPathRecentlyObservedAsRemote: (workspaceId, localPath) =>
        this.wasPathRecentlyObservedAsRemote(workspaceId, localPath)
    });

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.settingsTab = new RolaySettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerCommands();

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void this.handleFileOpen(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        if (info instanceof MarkdownView) {
          this.crdtManager.handleEditorChange(editor, info);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleExplorerLoadingDecorations();
        this.scheduleNotePresenceUiRefresh();
        this.ensureExplorerMutationObserver();
      })
    );
    this.ensureExplorerMutationObserver();
    this.registerDomEvent(this.app.workspace.containerEl, "click", (event) => {
      if (this.isExplorerFolderInteractionTarget(event.target)) {
        this.refreshExplorerDecorationsAfterFolderToggle();
      }
    }, true);
    this.registerDomEvent(this.app.workspace.containerEl, "keydown", (event) => {
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") &&
        this.isExplorerFolderInteractionTarget(event.target)
      ) {
        this.refreshExplorerDecorationsAfterFolderToggle();
      }
    }, true);
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        void this.handleVaultCreate(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleVaultRename(file, oldPath);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.handleVaultModify(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.handleVaultDelete(file);
      })
    );

    this.register(() => {
      this.isUnloading = true;
      this.stopSettingsEventStream();
      if (this.persistHandle !== null) {
        window.clearTimeout(this.persistHandle);
      }

      if (this.explorerDecorationHandle !== null) {
        window.clearTimeout(this.explorerDecorationHandle);
      }

      if (this.explorerDecorationFrame !== null) {
        window.cancelAnimationFrame(this.explorerDecorationFrame);
      }

      if (this.explorerToggleRefreshHandle !== null) {
        window.clearTimeout(this.explorerToggleRefreshHandle);
      }

      this.explorerMutationObserver?.disconnect();
      this.explorerMutationObserver = null;

      if (this.notePresenceUiHandle !== null) {
        window.clearTimeout(this.notePresenceUiHandle);
      }

      if (this.logFlushHandle !== null) {
        window.clearTimeout(this.logFlushHandle);
      }

      this.clearDeferredStartupWork();

      for (const runtime of this.roomRuntime.values()) {
        if (runtime.snapshotRefreshHandle !== null) {
          window.clearTimeout(runtime.snapshotRefreshHandle);
        }
        if (runtime.backgroundMarkdownRefreshHandle !== null) {
          window.clearTimeout(runtime.backgroundMarkdownRefreshHandle);
        }
        if (runtime.lockedBootstrapRetryHandle !== null) {
          window.clearTimeout(runtime.lockedBootstrapRetryHandle);
        }
      }

      for (const handle of this.pendingRemoteMarkdownSettles.values()) {
        window.clearTimeout(handle);
      }
      this.pendingRemoteMarkdownSettles.clear();

      for (const transfer of this.binaryTransferState.values()) {
        transfer.abortController?.abort();
      }
      this.binaryTransferState.clear();
      this.binarySyncTokens.clear();
      this.binarySyncPathsByToken.clear();
    });

    this.recordLog("plugin", "Rolay plugin loaded.");

    this.scheduleStartupBootstrap("startup");
  }

  override async onunload(): Promise<void> {
    this.isUnloading = true;
    this.clearDeferredStartupWork();
    this.stopSettingsEventStream();
    this.stopAllRoomEventStreams();
    await this.crdtManager.disconnect();
    await this.persistNow();
    await this.flushLogFile();
  }

  getSettings(): RolayPluginSettings {
    return this.data.settings;
  }

  getCurrentUser(): User | null {
    return this.data.session?.user ?? null;
  }

  getRoomList(): RoomListItem[] {
    return [...this.roomList];
  }

  getRoomCardStates(): RoomCardState[] {
    const roomsById = new Map(this.roomList.map((room) => [room.workspace.id, room]));
    const orderedRoomIds = [
      ...this.roomList.map((room) => room.workspace.id),
      ...Object.entries(this.data.settings.roomBindings)
        .filter(([roomId, binding]) => binding.downloaded && !roomsById.has(roomId))
        .map(([roomId]) => roomId)
    ];

    return orderedRoomIds.map((roomId) => {
      const room = roomsById.get(roomId) ?? {
        workspace: {
          id: roomId,
          name: this.getStoredRoomBinding(roomId)?.folderName || roomId
        },
        membershipRole: "member" as const,
        createdAt: "",
        memberCount: 0,
        inviteEnabled: false,
        publication: createDefaultRoomPublicationState(roomId)
      };
      const folderName = this.getResolvedRoomFolderName(room.workspace.id, room.workspace.name);
      const binding = this.getStoredRoomBinding(room.workspace.id);
      const localRoot = getRoomRoot(this.data.settings.syncRoot, folderName);
      const roomSync = getRoomSyncState(this.data.sync, room.workspace.id);
      const runtime = this.roomRuntime.get(room.workspace.id);
      const treeStore = runtime?.treeStore ?? null;
      const markdownEntries = treeStore?.getEntries().filter((entry) => !entry.deleted && entry.kind === "markdown") ?? [];
      const cachedMarkdownCount = markdownEntries.filter((entry) => this.hasPersistedCrdtCache(entry.id)).length;
      const binaryTransferLabel = this.formatRoomBinaryTransferLabel(room.workspace.id);

      return {
        room,
        folderName,
        downloaded: Boolean(binding?.downloaded),
        localRoot,
        folderExists: Boolean(localRoot && this.app.vault.getAbstractFileByPath(localRoot)),
        streamStatus: runtime?.streamStatus ?? "stopped",
        lastCursorLabel: roomSync.lastCursor === null ? "none" : String(roomSync.lastCursor),
        lastSnapshotLabel: roomSync.lastSnapshotAt ?? "never",
        entryCount: treeStore?.getEntries().length ?? 0,
        markdownEntryCount: markdownEntries.length,
        cachedMarkdownCount,
        crdtCacheLabel: this.formatRoomCrdtCacheLabel(runtime?.markdownBootstrap, markdownEntries.length, cachedMarkdownCount),
        binaryTransferLabel,
        invite: this.roomInvites.get(room.workspace.id) ?? null,
        publication: normalizeRoomPublicationState(room.publication, room.workspace.id)
      };
    });
  }

  getManagedUsers(): ManagedUser[] {
    return [...this.managedUsers];
  }

  getAdminRooms(): AdminRoomListItem[] {
    return [...this.adminRoomList];
  }

  getAdminSelectedRoomId(): string {
    return this.adminSelectedRoomId;
  }

  setAdminSelectedRoomId(roomId: string): void {
    this.adminSelectedRoomId = roomId.trim();
    this.adminRoomMembers = [];
    this.requestSettingsRender();
  }

  getAdminRoomMembers(): RoomMember[] {
    return [...this.adminRoomMembers];
  }

  getRoomMembers(workspaceId: string): RoomMember[] {
    return [...(this.roomMembersCache.get(workspaceId) ?? [])];
  }

  getProfileDraftDisplayName(): string {
    return this.profileDraftDisplayName || this.data.session?.user?.displayName || "";
  }

  getPresenceColor(): string | null {
    const configured = this.data.settings.presenceColor.trim();
    if (configured) {
      return configured;
    }

    const currentUser = this.getCurrentUser();
    return currentUser ? buildPresenceColor(currentUser.id) : null;
  }

  async updatePresenceColor(color: string): Promise<void> {
    const normalizedColor = normalizePresenceColor(color);
    await this.updateSettings({
      presenceColor: normalizedColor
    });
    await this.crdtManager.refreshPresencePreferences();
    this.requestSettingsRender();
  }

  setProfileDraftDisplayName(displayName: string): void {
    this.profileDraftDisplayName = displayName;
  }

  getPasswordChangeDraft(): PasswordChangeDraft {
    return { ...this.passwordChangeDraft };
  }

  updatePasswordChangeDraft(update: Partial<PasswordChangeDraft>): void {
    this.passwordChangeDraft = {
      ...this.passwordChangeDraft,
      ...update
    };
  }

  getCreateRoomDraft(): CreateRoomRequest {
    return { ...this.createRoomDraft };
  }

  updateCreateRoomDraft(update: Partial<CreateRoomRequest>): void {
    this.createRoomDraft = {
      ...this.createRoomDraft,
      ...update
    };
  }

  getJoinRoomDraft(): { code: string } {
    return { ...this.joinRoomDraft };
  }

  updateJoinRoomDraft(update: Partial<{ code: string }>): void {
    this.joinRoomDraft = {
      ...this.joinRoomDraft,
      ...update
    };
  }

  getManagedUserDraft(): CreateManagedUserRequest {
    return { ...this.managedUserDraft };
  }

  updateManagedUserDraft(update: Partial<CreateManagedUserRequest>): void {
    this.managedUserDraft = {
      ...this.managedUserDraft,
      ...update
    };
  }

  getAdminRoomMemberDraft(): AddRoomMemberRequest {
    return { ...this.adminRoomMemberDraft };
  }

  updateAdminRoomMemberDraft(update: Partial<AddRoomMemberRequest>): void {
    this.adminRoomMemberDraft = {
      ...this.adminRoomMemberDraft,
      ...update
    };
  }

  canCurrentUserCreateRooms(): boolean {
    const user = this.getCurrentUser();
    if (!user) {
      return false;
    }

    return user.isAdmin || user.globalRole === "admin" || user.globalRole === "writer";
  }

  getStatusSnapshot(): StatusSnapshot {
    const currentUser = this.data.session?.user ?? null;
    const downloadedRooms = this.getDownloadedRooms();
    const activeStreams = [...this.roomRuntime.values()].filter((runtime) => runtime.streamStatus === "open").length;
    const crdtState = this.crdtManager.getState();

    return {
      userLabel: currentUser
        ? `${currentUser.displayName} (@${currentUser.username})`
        : "not authenticated",
      globalRoleLabel: currentUser?.globalRole ?? "none",
      isAdmin: Boolean(currentUser?.isAdmin),
      downloadedRoomCount: downloadedRooms.length,
      activeStreamCount: activeStreams,
      crdtLabel: crdtState
        ? `${crdtState.status} for ${crdtState.filePath}`
        : "inactive (open a markdown note inside a downloaded room folder)",
      persistentLogPath: this.getPersistentLogFilePath(),
      recentLogs: this.data.logs.slice(-12).map((entry) => {
        return `[${entry.at}] ${entry.scope}/${entry.level}: ${entry.message}`;
      })
    };
  }

  requestSettingsRender(): void {
    this.settingsTab?.requestRender();
  }

  async activateSettingsPanelRealtime(): Promise<void> {
    if (!this.getCurrentUser()) {
      this.stopSettingsEventStream();
      this.requestSettingsRender();
      return;
    }

    await this.loadSettingsPanelSnapshot();
    this.startSettingsEventStream(null);
  }

  deactivateSettingsPanelRealtime(): void {
    this.stopSettingsEventStream();
    this.requestSettingsRender();
  }

  async loadSettingsPanelSnapshot(): Promise<void> {
    if (!this.getCurrentUser()) {
      this.requestSettingsRender();
      return;
    }

    try {
      await this.fetchCurrentUser(false, false);
    } catch (error) {
      this.handleError("Settings initial load failed", error, false);
      return;
    }

    try {
      await this.refreshOwnerRoomInvites(false);
    } catch (error) {
      this.handleError("Invite auto-refresh failed", error, false);
    }

    if (this.getCurrentUser()?.isAdmin && this.adminSelectedRoomId) {
      try {
        await this.refreshAdminRoomMembers(false, this.adminSelectedRoomId, false);
      } catch (error) {
        this.handleError("Admin room members auto-refresh failed", error, false);
      }
    }

    this.requestSettingsRender();
  }

  async updateSettings(update: Partial<RolayPluginSettings>): Promise<void> {
    this.data.settings = {
      ...this.data.settings,
      ...update,
      serverUrl: ROLAY_SERVER_URL,
      deviceName: ROLAY_DEVICE_NAME,
      autoConnect: ROLAY_AUTO_CONNECT,
      roomBindings: {
        ...this.data.settings.roomBindings,
        ...(update.roomBindings ?? {})
      }
    };
    this.data.settings.serverUrl = normalizeServerUrl(ROLAY_SERVER_URL);
    this.data.settings.syncRoot = this.data.settings.syncRoot.trim();
    await this.persistNow();
    this.updateStatusBar();
  }

  async setRoomFolderName(workspaceId: string, folderName: string): Promise<void> {
    const binding = this.getStoredRoomBinding(workspaceId);
    if (binding?.downloaded) {
      throw this.notifyError("Folder name is locked after the room has been downloaded.");
    }

    await this.saveRoomBinding(workspaceId, {
      folderName: folderName.trim(),
      downloaded: Boolean(binding?.downloaded)
    });
  }

  async loginWithSettings(showNotice = true, resumeRooms = true): Promise<void> {
    const { username, password } = this.data.settings;

    if (!username || !password) {
      throw this.notifyError("Username and password are required before login.");
    }

    try {
      const response = await this.apiClient.login({
        username,
        password,
        deviceName: ROLAY_DEVICE_NAME
      });

      await this.applySessionUser(response.user);
      await this.refreshPostAuthState();
      if (resumeRooms) {
        await this.resumeDownloadedRooms("login");
      }
      this.recordLog("auth", `Logged in as ${response.user.username}.`);
      if (showNotice) {
        new Notice(`Rolay login successful for ${response.user.username}.`);
      }
      this.updateStatusBar();
    } catch (error) {
      this.handleError("Login failed", error);
      throw error;
    }
  }

  async refreshSession(showNotice = true): Promise<void> {
    try {
      await this.apiClient.refresh();
      await this.fetchCurrentUser(false);
      this.recordLog("auth", "Session tokens refreshed.");
      if (showNotice) {
        new Notice("Rolay session refreshed.");
      }
      this.updateStatusBar();
    } catch (error) {
      this.handleError("Refresh failed", error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.stopSettingsEventStream();
    this.stopAllRoomEventStreams();
    await this.crdtManager.disconnect();
    for (const localPath of [...this.binaryTransferState.keys()]) {
      this.invalidateBinarySyncToken(localPath);
    }
    for (const localPath of [...this.binaryTransferState.keys()]) {
      await this.cancelBinaryTransferForLocalPath(localPath, "logout");
    }
    this.binaryTransferState.clear();
    this.binarySyncTokens.clear();
    this.binarySyncPathsByToken.clear();
    this.roomRuntime.clear();
    this.roomInvites.clear();
    this.roomList = [];
    this.adminRoomList = [];
    this.managedUsers = [];
    this.adminSelectedRoomId = "";
    this.adminRoomMembers = [];
    this.data.session = null;
    this.resetProfileDraft();
    this.clearPasswordChangeDraft();
    this.clearRoomDrafts();
    this.clearManagedUserDraft();
    this.clearAdminRoomMemberDraft();
    this.recordLog("auth", "Session cleared.");
    await this.persistNow();
    this.updateStatusBar();
  }

  async fetchCurrentUser(showNotice = false, logActivity = true): Promise<User> {
    const response = await this.apiClient.getCurrentUser();
    await this.applySessionUser(response.user);
    await this.refreshPostAuthState(logActivity);
    if (logActivity) {
      this.recordLog("auth", `Loaded current user ${response.user.username}.`);
    }
    if (showNotice) {
      new Notice(`Current Rolay user: ${response.user.displayName}`);
    }
    return response.user;
  }

  async updateOwnDisplayName(): Promise<void> {
    const displayName = this.getProfileDraftDisplayName().trim();
    if (!displayName) {
      throw this.notifyError("Display name is required.");
    }

    try {
    const response = await this.apiClient.updateCurrentUserProfile({ displayName });
    await this.applySessionUser(response.user);
    await this.crdtManager.refreshPresencePreferences();
    this.recordLog("auth", `Updated display name to ${response.user.displayName}.`);
      new Notice(`Rolay display name updated to ${response.user.displayName}.`);
    } catch (error) {
      this.handleError("Display name update failed", error);
      throw error;
    }
  }

  async changeOwnPassword(): Promise<void> {
    if (!this.getCurrentUser()) {
      throw this.notifyError("Log into Rolay before changing your password.");
    }

    const currentPassword = this.passwordChangeDraft.currentPassword;
    const newPassword = this.passwordChangeDraft.newPassword;
    const confirmPassword = this.passwordChangeDraft.confirmPassword;

    if (!currentPassword) {
      throw this.notifyError("Current password is required.");
    }

    if (!newPassword) {
      throw this.notifyError("New password is required.");
    }

    if (!confirmPassword) {
      throw this.notifyError("Confirm the new password.");
    }

    if (newPassword !== confirmPassword) {
      throw this.notifyError("New password confirmation does not match.");
    }

    if (newPassword === currentPassword) {
      throw this.notifyError("New password must be different from the current password.");
    }

    try {
      const response = await this.apiClient.changeCurrentUserPassword({
        currentPassword,
        newPassword
      });

      this.resetProfileDraft();
      this.clearPasswordChangeDraft();
      await this.updateSettings({
        password: newPassword
      });
      this.recordLog("auth", `Changed password for ${response.user.username}. Session tokens were rotated.`);
      new Notice("Rolay password updated. The current session was rotated.");
    } catch (error) {
      const friendlyMessage = this.getPasswordChangeErrorMessage(error);
      if (friendlyMessage) {
        this.recordLog("error", `Password change failed: ${friendlyMessage}`, "error");
        new Notice(friendlyMessage);
        throw new Error(friendlyMessage);
      }

      this.handleError("Password change failed", error);
      throw error;
    }
  }

  async refreshRooms(showNotice = false, logActivity = true): Promise<RoomListItem[]> {
    const response = await this.apiClient.listRooms();
    this.roomList = [...response.workspaces].map(normalizeRoomListItem).sort(compareRoomsByName);
    await this.reconcileLocalRoomFolders();
    this.reconcileInviteCache();
    if (logActivity) {
      this.recordLog("rooms", `Loaded ${this.roomList.length} room(s).`);
    }
    if (showNotice) {
      new Notice(`Loaded ${this.roomList.length} Rolay room(s).`);
    }
    this.updateStatusBar();
    return this.getRoomList();
  }

  async createRoomFromDraft(): Promise<void> {
    if (!this.canCurrentUserCreateRooms()) {
      throw this.notifyError("Only writer/admin users can create rooms.");
    }

    const name = this.createRoomDraft.name.trim();
    if (!name) {
      throw this.notifyError("Room name is required.");
    }

    try {
      await this.ensureAuthenticated(true);
      const response = await this.apiClient.createRoom({ name });
      this.clearCreateRoomDraft();
      await this.refreshRooms(false);
      this.recordLog("rooms", `Created room ${response.workspace.name} (${response.workspace.id}).`);
      new Notice(`Rolay room created: ${response.workspace.name}`);
    } catch (error) {
      this.handleError("Room creation failed", error);
      throw error;
    }
  }

  async joinRoomFromDraft(): Promise<void> {
    const code = this.joinRoomDraft.code.trim();
    if (!code) {
      throw this.notifyError("Invite key is required.");
    }

    try {
      await this.ensureAuthenticated(true);
      const response = await this.apiClient.joinRoom({ code });
      this.clearJoinRoomDraft();
      await this.refreshRooms(false);
      this.recordLog("rooms", `Joined room ${response.workspace.name} (${response.workspace.id}).`);
      new Notice(`Joined Rolay room: ${response.workspace.name}`);
    } catch (error) {
      this.handleError("Join room failed", error);
      throw error;
    }
  }

  async createRoomFromPrompt(): Promise<void> {
    const name = await openTextInputModal(this.app, {
      title: "Create Rolay Room",
      label: "Room name",
      placeholder: "Math Group",
      submitText: "Create",
      description: "Writers and admins can create rooms. The room folder is not downloaded automatically."
    });

    if (!name) {
      return;
    }

    this.updateCreateRoomDraft({ name });
    await this.createRoomFromDraft();
  }

  async joinRoomFromPrompt(): Promise<void> {
    const code = await openTextInputModal(this.app, {
      title: "Join Rolay Room",
      label: "Invite key",
      placeholder: "paste invite key",
      submitText: "Join",
      description: "Joining happens only by invite key or through admin membership management."
    });

    if (!code) {
      return;
    }

    this.updateJoinRoomDraft({ code });
    await this.joinRoomFromDraft();
  }

  async downloadRoom(workspaceId: string): Promise<void> {
    const room = this.requireRoom(workspaceId);
    const folderName = this.requireFolderNameForRoom(room.workspace.id, room.workspace.name);
    const localRoot = getRoomRoot(this.data.settings.syncRoot, folderName);

    if (this.isFolderNameUsedByAnotherRoom(room.workspace.id, folderName)) {
      throw this.notifyError(`Another room is already bound to the folder name "${folderName}".`);
    }

    if (localRoot && this.app.vault.getAbstractFileByPath(localRoot)) {
      throw this.notifyError(`Vault already contains the folder "${localRoot}". Choose another folder name before downloading.`);
    }

    await this.saveRoomBinding(room.workspace.id, {
      folderName,
      downloaded: true
    });

    try {
      await this.connectRoom(room.workspace.id, false, "download");
      this.recordLog("rooms", `Installed room ${room.workspace.name} into ${localRoot}.`);
      new Notice(`Rolay room installed: ${room.workspace.name}`);
    } catch (error) {
      this.handleError("Room download failed", error);
      throw error;
    }
  }

  async connectRoom(
    workspaceId: string,
    showNotice = true,
    reason = "manual-connect"
  ): Promise<void> {
    const room = this.requireDownloadedRoom(workspaceId);
    const runtime = this.ensureRoomRuntime(room.workspace.id);
    runtime.streamStatus = "connecting";
    this.updateStatusBar();
    this.scheduleExplorerLoadingDecorations();
    await this.refreshRoomSnapshot(room.workspace.id, reason);
    if (!this.isRoomSyncActive(room.workspace.id)) {
      return;
    }

    await this.startRoomEventStream(room.workspace.id);
    this.scheduleSnapshotRefresh(room.workspace.id, "post-connect-binary-followup");
    this.scheduleBackgroundMarkdownRefresh(
      room.workspace.id,
      "post-connect-background-refresh",
      RolayPlugin.ROOM_MARKDOWN_REFRESH_AFTER_SNAPSHOT_MS,
      true
    );

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && this.isLocalPathInDownloadedRoom(activeFile.path, room.workspace.id)) {
      await this.bindActiveMarkdownToCrdt();
    }

    if (showNotice) {
      new Notice(`Rolay room connected: ${room.workspace.name}`);
    }
  }

  async disconnectRoom(workspaceId: string, showNotice = true): Promise<void> {
    const room = this.requireDownloadedRoom(workspaceId);
    this.stopRoomEventStream(room.workspace.id);
    await this.cancelRoomBinaryTransfers(room.workspace.id, "disconnect");

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && this.isLocalPathInDownloadedRoom(activeFile.path, room.workspace.id)) {
      await this.crdtManager.goOffline();
      this.updateStatusBar();
    }

    if (showNotice) {
      new Notice(`Rolay room disconnected: ${room.workspace.name}`);
    }
  }

  async installRoom(workspaceId: string, folderName: string): Promise<void> {
    const room = this.requireRoom(workspaceId);
    const nextFolderName = normalizeRoomFolderName(folderName || room.workspace.name);
    if (!isValidRoomFolderName(nextFolderName)) {
      throw this.notifyError("Room folder name must be non-empty and must not contain '/' or '\\'.");
    }

    if (this.isFolderNameUsedByAnotherRoom(room.workspace.id, nextFolderName)) {
      throw this.notifyError(`Another room is already bound to the folder name "${nextFolderName}".`);
    }

    await this.saveRoomBinding(room.workspace.id, {
      folderName: nextFolderName,
      downloaded: false
    });
    await this.downloadRoom(room.workspace.id);
  }

  async renameInstalledRoomFolder(workspaceId: string, folderName: string): Promise<void> {
    const room = this.requireDownloadedRoom(workspaceId);
    const currentFolderName = this.getResolvedRoomFolderName(room.workspace.id, room.workspace.name);
    const nextFolderName = normalizeRoomFolderName(folderName || room.workspace.name);

    if (!isValidRoomFolderName(nextFolderName)) {
      throw this.notifyError("Room folder name must be non-empty and must not contain '/' or '\\'.");
    }

    if (nextFolderName === currentFolderName) {
      return;
    }

    if (this.isFolderNameUsedByAnotherRoom(room.workspace.id, nextFolderName)) {
      throw this.notifyError(`Another room is already bound to the folder name "${nextFolderName}".`);
    }

    const currentRoot = getRoomRoot(this.data.settings.syncRoot, currentFolderName);
    const nextRoot = getRoomRoot(this.data.settings.syncRoot, nextFolderName);
    const currentFolder = this.app.vault.getAbstractFileByPath(currentRoot);
    const nextFolder = this.app.vault.getAbstractFileByPath(nextRoot);

    if (!currentFolder) {
      await this.deactivateRoomDownload(room.workspace.id, false);
      throw this.notifyError("The local room folder is missing. The room was detached from the vault.");
    }

    if (nextFolder && nextFolder.path !== currentRoot) {
      throw this.notifyError(`Vault already contains the folder "${nextRoot}". Choose another folder name.`);
    }

    await this.fileBridge.runWithSuppressedPaths([currentRoot, nextRoot], async () => {
      await this.app.fileManager.renameFile(currentFolder, nextRoot);
    });
    await this.saveRoomBinding(room.workspace.id, {
      folderName: nextFolderName,
      downloaded: true
    });

    await this.bindActiveMarkdownToCrdt();
    this.recordLog("rooms", `Renamed local room folder for ${room.workspace.id} from ${currentFolderName} to ${nextFolderName}.`);
    new Notice(`Rolay room folder renamed to ${nextFolderName}.`);
  }

  async refreshRoomInvite(workspaceId: string, showNotice = true, logActivity = true): Promise<InviteState> {
    const room = this.requireOwnerRoom(workspaceId);
    const response = await this.apiClient.getRoomInvite(room.workspace.id);
    this.roomInvites.set(room.workspace.id, response.invite);
    this.patchInviteEnabled(room.workspace.id, response.invite.enabled);
    if (logActivity) {
      this.recordLog("invite", `Loaded invite state for ${room.workspace.id}.`);
    }
    if (showNotice) {
      new Notice(`Invite key loaded for ${room.workspace.name}.`);
    }
    return response.invite;
  }

  async setRoomInviteEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    const room = this.requireOwnerRoom(workspaceId);

    try {
      const response = await this.apiClient.updateRoomInviteState(room.workspace.id, { enabled });
      this.roomInvites.set(room.workspace.id, response.invite);
      this.patchInviteEnabled(room.workspace.id, response.invite.enabled);
      this.recordLog("invite", `${enabled ? "Enabled" : "Disabled"} invite key for ${room.workspace.id}.`);
      new Notice(`Invite key ${enabled ? "enabled" : "disabled"} for ${room.workspace.name}.`);
    } catch (error) {
      this.handleError("Invite state update failed", error);
      throw error;
    }
  }

  async regenerateRoomInvite(workspaceId: string): Promise<void> {
    const room = this.requireOwnerRoom(workspaceId);

    try {
      const response = await this.apiClient.regenerateRoomInvite(room.workspace.id);
      this.roomInvites.set(room.workspace.id, response.invite);
      this.patchInviteEnabled(room.workspace.id, response.invite.enabled);
      this.recordLog("invite", `Regenerated invite key for ${room.workspace.id}.`);
      new Notice(`Invite key regenerated for ${room.workspace.name}.`);
    } catch (error) {
      this.handleError("Invite regenerate failed", error);
      throw error;
    }
  }

  getPublicSiteUrl(): string {
    const normalizedServerUrl = normalizeServerUrl(this.data.settings.serverUrl) || ROLAY_SERVER_URL;
    return `${normalizedServerUrl.replace(/\/+$/, "")}/`;
  }

  canCurrentUserManageRoomPublication(workspaceId: string): boolean {
    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      return false;
    }

    if (currentUser.isAdmin) {
      return true;
    }

    return this.roomList.some((room) => {
      return room.workspace.id === workspaceId && room.membershipRole === "owner";
    });
  }

  async refreshRoomPublication(workspaceId: string, logActivity = false): Promise<RoomPublicationState> {
    const response = await this.apiClient.getRoomPublication(workspaceId);
    const publication = normalizeRoomPublicationState(response.publication, workspaceId);
    this.patchRoomPublication(workspaceId, publication);
    if (logActivity) {
      this.recordLog(
        "publication",
        `Loaded publication state for ${workspaceId}: ${publication.enabled ? "public" : "private"}.`
      );
    }
    this.updateStatusBar();
    this.requestSettingsRender();
    return publication;
  }

  async setRoomPublicationEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    this.requireRoomPublicationManager(workspaceId);
    const roomName = this.getKnownRoomName(workspaceId);

    try {
      const response = await this.apiClient.updateRoomPublication(workspaceId, { enabled });
      const publication = normalizeRoomPublicationState(response.publication, workspaceId);
      this.patchRoomPublication(workspaceId, publication);
      this.recordLog(
        "publication",
        `${enabled ? "Enabled" : "Disabled"} public publication for ${workspaceId}.`
      );
      this.updateStatusBar();
      new Notice(
        enabled
          ? `Room is now public on the read-only site: ${roomName}`
          : `Room is now private again: ${roomName}`
      );
      this.requestSettingsRender();
    } catch (error) {
      this.handleError("Room publication update failed", error);
      throw error;
    }
  }

  async refreshManagedUsers(showNotice = false, logActivity = true): Promise<ManagedUser[]> {
    this.requireAdmin();
    const response = await this.apiClient.listManagedUsers();
    this.managedUsers = [...response.users].sort((left, right) => left.username.localeCompare(right.username));
    if (logActivity) {
      this.recordLog("admin", `Loaded ${this.managedUsers.length} managed user(s).`);
    }
    if (showNotice) {
      new Notice(`Loaded ${this.managedUsers.length} managed user(s).`);
    }
    return this.getManagedUsers();
  }

  async createManagedUserFromDraft(): Promise<void> {
    this.requireAdmin();

    const username = this.managedUserDraft.username.trim();
    const password = this.managedUserDraft.password;
    const displayName = this.managedUserDraft.displayName?.trim() || undefined;
    const globalRole = this.managedUserDraft.globalRole ?? "reader";

    if (!username || !password) {
      throw this.notifyError("Username and temporary password are required.");
    }

    try {
      const response = await this.apiClient.createManagedUser({
        username,
        password,
        displayName,
        globalRole
      });
      this.recordLog(
        "admin",
        `Created managed user ${response.user.username} (${response.user.globalRole}).`
      );
      new Notice(`Rolay account created: ${response.user.username}`);
      this.clearManagedUserDraft();
      await this.refreshManagedUsers(false);
    } catch (error) {
      this.handleError("Managed user creation failed", error);
      throw error;
    }
  }

  async deleteManagedUser(userId: string): Promise<void> {
    this.requireAdmin();

    try {
      const response = await this.apiClient.deleteManagedUser(userId);
      this.managedUsers = this.managedUsers.filter((user) => user.id !== userId);
      this.recordLog("admin", `Deleted managed user ${response.user.username}.`);
      new Notice(`Rolay account deleted: ${response.user.username}`);
      if (this.adminRoomMembers.some((member) => member.user.id === userId)) {
        await this.refreshAdminRoomMembers(false);
      }
    } catch (error) {
      this.handleError("Managed user deletion failed", error);
      throw error;
    }
  }

  async refreshAdminRooms(showNotice = false, logActivity = true): Promise<AdminRoomListItem[]> {
    this.requireAdmin();
    const response = await this.apiClient.listAllRoomsAsAdmin();
    this.adminRoomList = [...response.workspaces].map(normalizeAdminRoomListItem).sort(compareRoomsByName);

    if (!this.adminSelectedRoomId && this.adminRoomList.length === 1) {
      this.adminSelectedRoomId = this.adminRoomList[0].workspace.id;
    } else if (
      this.adminSelectedRoomId &&
      !this.adminRoomList.some((room) => room.workspace.id === this.adminSelectedRoomId)
    ) {
      this.adminSelectedRoomId = "";
      this.adminRoomMembers = [];
    }

    if (logActivity) {
      this.recordLog("admin", `Loaded ${this.adminRoomList.length} room(s) in admin scope.`);
    }
    if (showNotice) {
      new Notice(`Loaded ${this.adminRoomList.length} admin room(s).`);
    }
    return this.getAdminRooms();
  }

  async refreshAdminRoomMembers(
    showNotice = false,
    roomId = this.adminSelectedRoomId,
    logActivity = true
  ): Promise<RoomMember[]> {
    this.requireAdmin();

    const targetRoomId = roomId.trim();
    if (!targetRoomId) {
      throw this.notifyError("Select an admin room first.");
    }

    const members = await this.loadRoomMembersForUi(targetRoomId, logActivity);
    this.adminSelectedRoomId = targetRoomId;
    this.adminRoomMembers = [...members];
    if (logActivity) {
      this.recordLog("admin", `Loaded ${this.adminRoomMembers.length} member(s) for room ${targetRoomId}.`);
    }
    if (showNotice) {
      new Notice(`Loaded ${this.adminRoomMembers.length} room member(s).`);
    }
    return this.getAdminRoomMembers();
  }

  async loadRoomMembersForUi(workspaceId: string, logActivity = false): Promise<RoomMember[]> {
    try {
      const response = this.data.session?.user?.isAdmin
        ? await this.apiClient.listRoomMembersAsAdmin(workspaceId)
        : await this.apiClient.listRoomMembers(workspaceId);
      const members = [...response.members].sort(compareRoomMembers);
      this.roomMembersCache.set(workspaceId, members);
      if (this.adminSelectedRoomId === workspaceId) {
        this.adminRoomMembers = [...members];
      }
      if (logActivity) {
        this.recordLog("rooms", `Loaded ${members.length} member(s) for room ${workspaceId}.`);
      }
      this.requestSettingsRender();
      return [...members];
    } catch (error) {
      this.recordLog(
        "rooms",
        `Failed to load members for room ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return this.getRoomMembers(workspaceId);
    }
  }

  async addUserToSelectedAdminRoom(): Promise<void> {
    this.requireAdmin();

    const roomId = this.adminSelectedRoomId.trim();
    if (!roomId) {
      throw this.notifyError("Select an admin room first.");
    }

    const username = this.adminRoomMemberDraft.username.trim();
    const role = this.adminRoomMemberDraft.role ?? "member";
    if (!username) {
      throw this.notifyError("Username is required.");
    }

    try {
      const response = await this.apiClient.addRoomMemberAsAdmin(roomId, {
        username,
        role
      });
      this.recordLog(
        "admin",
        `Added ${response.user.username} to room ${response.workspace.id} as ${response.membership.role}.`
      );
      new Notice(`Added ${response.user.username} to ${response.workspace.name}.`);
      this.clearAdminRoomMemberDraft();
      await this.refreshAdminRoomMembers(false, roomId);
      await this.refreshAdminRooms(false);
      await this.refreshRooms(false);
    } catch (error) {
      this.handleError("Add room member failed", error);
      throw error;
    }
  }

  async deleteAdminRoom(roomId = this.adminSelectedRoomId): Promise<void> {
    this.requireAdmin();

    const targetRoomId = roomId.trim();
    if (!targetRoomId) {
      throw this.notifyError("Select an admin room first.");
    }

    try {
      const response = await this.apiClient.deleteRoomAsAdmin(targetRoomId);
      this.recordLog("admin", `Deleted room ${response.workspace.name} (${response.workspace.id}).`);
      new Notice(`Deleted Rolay room: ${response.workspace.name}`);

      await this.deactivateRoomDownload(targetRoomId);

      if (this.adminSelectedRoomId === targetRoomId) {
        this.adminSelectedRoomId = "";
        this.adminRoomMembers = [];
      }

      await this.refreshAdminRooms(false);
      await this.refreshRooms(false);
      this.updateStatusBar();
    } catch (error) {
      this.handleError("Delete room failed", error);
      throw error;
    }
  }

  async refreshRoomSnapshot(workspaceId: string, reason = "manual"): Promise<void> {
    const runtime = this.ensureRoomRuntime(workspaceId);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    if (runtime.snapshotRefreshInFlight) {
      runtime.snapshotRefreshQueuedReason = runtime.snapshotRefreshQueuedReason ?? reason;
      return;
    }

    runtime.snapshotRefreshInFlight = true;
    try {
      await this.performRoomSnapshotRefresh(workspaceId, reason);
    } catch (error) {
      if (this.shouldRetrySnapshotAfterAuthRecovery(error)) {
        try {
          await this.ensureAuthenticated(true);
          await this.performRoomSnapshotRefresh(workspaceId, `${reason}-auth-retry`);
          return;
        } catch (retryError) {
          this.handleError("Tree snapshot failed", retryError);
          throw retryError;
        }
      }

      this.handleError("Tree snapshot failed", error);
      throw error;
    } finally {
      runtime.snapshotRefreshInFlight = false;
      const queuedReason = runtime.snapshotRefreshQueuedReason;
      runtime.snapshotRefreshQueuedReason = null;
      if (queuedReason && this.isRoomSyncActive(workspaceId)) {
        this.scheduleSnapshotRefresh(workspaceId, queuedReason);
      }
    }
  }

  private async performRoomSnapshotRefresh(workspaceId: string, reason: string): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    if (!this.hasUsableSessionTokens() && this.canAttemptAuth()) {
      await this.ensureAuthenticated(true);
    }
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    const room = this.requireDownloadedRoom(workspaceId);
    const runtime = this.ensureRoomRuntime(room.workspace.id);
    const previousEntries = runtime.treeStore.getEntries();
    const snapshot = await this.apiClient.getWorkspaceTree(room.workspace.id);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    runtime.treeStore.applySnapshot(snapshot);
    this.confirmSnapshotPendingCreates(room.workspace.id, snapshot.entries);
    this.confirmSnapshotPendingDeletes(room.workspace.id, snapshot.entries);
    await this.fileBridge.applySnapshot(snapshot, previousEntries);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    this.scheduleExplorerLoadingDecorations();
    this.setRoomSyncState(room.workspace.id, {
      lastCursor: snapshot.cursor,
      lastSnapshotAt: new Date().toISOString()
    });
    this.recordLog(
      "tree",
      `Fetched snapshot for ${snapshot.workspace.name} with ${snapshot.entries.length} entries (${reason}).`
    );
    await this.bootstrapRoomMarkdownCache(room.workspace.id, snapshot.entries, reason);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    await this.syncBinaryEntriesFromSnapshot(room.workspace.id, snapshot.entries, reason);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    this.scheduleBackgroundMarkdownRefresh(
      room.workspace.id,
      "post-snapshot-background-refresh",
      RolayPlugin.ROOM_MARKDOWN_REFRESH_AFTER_SNAPSHOT_MS,
      true
    );
    await this.reconcilePendingMarkdownCreates(room.workspace.id, reason);
    await this.reconcilePendingMarkdownMerges(room.workspace.id, reason);
    await this.reconcilePendingBinaryWrites(room.workspace.id, reason);
    await this.persistNow();
    this.updateStatusBar();
    await this.bindActiveMarkdownToCrdt();
  }

  private shouldRetrySnapshotAfterAuthRecovery(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const normalizedMessage = error.message.toLowerCase();
    return (
      normalizedMessage.includes("you are not authenticated yet") ||
      normalizedMessage.includes("no refresh token is stored yet.")
    ) && this.canAttemptAuth();
  }

  private hasUsableSessionTokens(): boolean {
    return Boolean(
      this.data.session?.accessToken?.trim() ||
      this.data.session?.refreshToken?.trim()
    );
  }

  async startRoomEventStream(workspaceId: string): Promise<void> {
    const room = this.requireDownloadedRoom(workspaceId);
    const runtime = this.ensureRoomRuntime(room.workspace.id);
    this.stopRoomEventStream(room.workspace.id);
    const generation = runtime.eventStreamGeneration + 1;
    runtime.eventStreamGeneration = generation;
    runtime.streamStatus = "connecting";
    this.updateStatusBar();
    this.scheduleExplorerLoadingDecorations();

    const roomSync = getRoomSyncState(this.data.sync, room.workspace.id);
    const treeCursor = runtime.treeStore.getCursor();
    if (treeCursor === null && roomSync.lastCursor === null) {
      await this.refreshRoomSnapshot(room.workspace.id, "pre-sse");
    }

    const cursor = runtime.treeStore.getCursor() ?? getRoomSyncState(this.data.sync, room.workspace.id).lastCursor;
    const stream = new WorkspaceEventStream(this.apiClient, (message) => {
      this.recordLog("sse", `[${room.workspace.id}] ${message}`);
    });
    runtime.eventStream = stream;

    // Every stream start gets a fresh generation token so stale callbacks from
    // a just-stopped SSE connection cannot mutate current room state.
    stream.start(room.workspace.id, cursor, {
      onOpen: () => {
        if (runtime.eventStreamGeneration !== generation) {
          return;
        }
        this.recordLog("sse", `Subscribed to room ${room.workspace.id} events.`);
      },
      onEvent: async (event) => {
        if (runtime.eventStreamGeneration !== generation) {
          return;
        }
        const lastHandledEventId = runtime.lastHandledEventId ?? runtime.treeStore.getCursor();
        if (lastHandledEventId !== null && event.id <= lastHandledEventId) {
          return;
        }

        runtime.lastHandledEventId = event.id;
        runtime.treeStore.recordCursor(event.id);
        this.updateRoomSyncCursor(room.workspace.id, event.id);
        this.schedulePersist();
        this.recordLog("sse", `[${room.workspace.id}] Event ${event.id}: ${event.event}`);
        if (event.event.startsWith("tree.") || event.event.startsWith("blob.")) {
          this.scheduleSnapshotRefresh(room.workspace.id, "event-stream");
        }
      },
      onStatusChange: (status) => {
        if (runtime.eventStreamGeneration !== generation) {
          return;
        }
        runtime.streamStatus = status;
        this.updateStatusBar();
        this.scheduleExplorerLoadingDecorations();
        this.scheduleNotePresenceUiRefresh();
      },
      onError: (error) => {
        if (runtime.eventStreamGeneration !== generation) {
          return;
        }
        this.handleError(`Workspace event stream error (${room.workspace.id})`, error, false);
      }
    });

    this.startRoomNotePresenceStream(room.workspace.id);
  }

  stopRoomEventStream(workspaceId: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    if (runtime.snapshotRefreshHandle !== null) {
      window.clearTimeout(runtime.snapshotRefreshHandle);
      runtime.snapshotRefreshHandle = null;
    }
    runtime.snapshotRefreshQueuedReason = null;
    this.clearBackgroundMarkdownRefresh(workspaceId);
    this.clearLockedMarkdownBootstrapRetry(workspaceId, false);
    this.cancelRoomMarkdownBootstrap(workspaceId);
    runtime.eventStreamGeneration += 1;
    runtime.eventStream?.stop();
    runtime.eventStream = null;
    this.stopRoomNotePresenceStream(workspaceId);
    runtime.streamStatus = "stopped";
    runtime.lastHandledEventId = runtime.treeStore.getCursor();
    this.updateStatusBar();
    this.scheduleImmediateExplorerLoadingDecorations();
    this.refreshNotePresenceUiNow();
  }

  stopAllRoomEventStreams(): void {
    for (const workspaceId of this.roomRuntime.keys()) {
      this.stopRoomEventStream(workspaceId);
    }
  }

  private startRoomNotePresenceStream(workspaceId: string): void {
    const runtime = this.ensureRoomRuntime(workspaceId);
    this.stopRoomNotePresenceStream(workspaceId);
    const generation = runtime.notePresenceStreamGeneration + 1;
    runtime.notePresenceStreamGeneration = generation;

    const stream = new NotePresenceEventStream(this.apiClient, (message) => {
      this.recordLog("presence", `[${workspaceId}] ${message}`);
    });
    runtime.notePresenceStream = stream;
    stream.start(workspaceId, {
      onOpen: () => {
        if (runtime.notePresenceStreamGeneration !== generation) {
          return;
        }
        this.recordLog("presence", `Subscribed to note presence for room ${workspaceId}.`);
      },
      onEvent: async (event) => {
        if (runtime.notePresenceStreamGeneration !== generation) {
          return;
        }

        if (event.event === "ping") {
          return;
        }

        if (event.event === "presence.snapshot") {
          this.applyNotePresenceSnapshot(workspaceId, event.data);
          return;
        }

        if (event.event === "note.presence.updated") {
          this.applyNotePresenceUpdate(workspaceId, event.data);
        }
      },
      onError: (error) => {
        if (runtime.notePresenceStreamGeneration !== generation) {
          return;
        }
        this.handleError(`Note presence stream error (${workspaceId})`, error, false);
      }
    });
  }

  private stopRoomNotePresenceStream(workspaceId: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    runtime.notePresenceStreamGeneration += 1;
    runtime.notePresenceStream?.stop();
    runtime.notePresenceStream = null;
    runtime.notePresenceByEntryId.clear();
    runtime.noteAnonymousViewerCountByEntryId.clear();
    this.scheduleImmediateExplorerLoadingDecorations();
    this.refreshNotePresenceUiNow();
  }

  private startSettingsEventStream(cursor: number | null): void {
    this.stopSettingsEventStream();

    if (!this.getCurrentUser()) {
      return;
    }

    const generation = this.settingsEventStreamGeneration + 1;
    this.settingsEventStreamGeneration = generation;
    this.settingsEventCursor = cursor;
    const stream = new SettingsEventStream(this.apiClient, (message) => {
      this.recordLog("settings-sse", message);
    });
    this.settingsEventStream = stream;

    stream.start(cursor, {
      onOpen: () => {
        if (this.settingsEventStreamGeneration !== generation) {
          return;
        }
        this.recordLog("settings-sse", "Subscribed to settings events.");
      },
      onEvent: async (event) => {
        if (this.settingsEventStreamGeneration !== generation) {
          return;
        }
        await this.handleSettingsEventStreamEvent(event);
      },
      onStatusChange: (status) => {
        if (this.settingsEventStreamGeneration !== generation) {
          return;
        }
        this.settingsEventStreamStatus = status;
        this.updateStatusBar();
      },
      onError: (error) => {
        if (this.settingsEventStreamGeneration !== generation) {
          return;
        }
        this.handleError("Settings event stream error", error, false);
        if (this.shouldRecoverSettingsStream(error)) {
          void this.recoverSettingsEventStream();
        }
      }
    });
  }

  private stopSettingsEventStream(): void {
    this.settingsEventStreamGeneration += 1;
    this.settingsEventStream?.stop();
    this.settingsEventStream = null;
    this.settingsEventStreamStatus = "stopped";
  }

  private async handleSettingsEventStreamEvent(event: SettingsStreamEvent): Promise<void> {
    const envelope = normalizeSettingsEventEnvelope(event);
    const eventId = event.id > 0 ? event.id : envelope.eventId;
    if (Number.isFinite(eventId) && eventId > 0) {
      this.settingsEventCursor = eventId;
    }

    if (envelope.type === "ping") {
      return;
    }

    if (envelope.type === "stream.ready") {
      this.recordLog("settings-sse", `Settings stream ready at event ${this.settingsEventCursor ?? envelope.eventId}.`);
      this.requestSettingsRender();
      return;
    }

    this.recordLog(
      "settings-sse",
      `Event ${this.settingsEventCursor ?? envelope.eventId}: ${envelope.type} (${envelope.scope}).`
    );

    switch (envelope.type) {
      case "auth.me.updated":
        await this.applySettingsUserUpdate(extractUserFromSettingsPayload(envelope.payload));
        break;
      case "room.created":
      case "room.updated":
        await this.applySettingsRoomUpsert(envelope.scope, envelope.payload);
        break;
      case "room.deleted":
        await this.applySettingsRoomDelete(envelope.scope, envelope.payload);
        break;
      case "room.membership.changed":
        await this.applySettingsRoomMembershipChanged(envelope.payload);
        break;
      case "room.invite.updated":
        this.applySettingsInviteUpdate(extractInviteFromSettingsPayload(envelope.payload));
        break;
      case "room.publication.updated":
        this.applySettingsRoomPublicationUpdate(extractRoomPublicationUpdatedPayload(envelope.payload));
        break;
      case "admin.user.created":
      case "admin.user.updated":
        this.applySettingsManagedUserUpsert(extractManagedUserFromSettingsPayload(envelope.payload));
        break;
      case "admin.user.deleted":
        this.applySettingsManagedUserDelete(extractUserIdFromSettingsPayload(envelope.payload));
        break;
      case "admin.room.members.updated":
        this.applySettingsAdminRoomMembersUpdate(extractAdminRoomMembersPayload(envelope.payload));
        break;
      default:
        break;
    }

    this.requestSettingsRender();
  }

  private async recoverSettingsEventStream(): Promise<void> {
    if (this.settingsStreamRecoveryInFlight) {
      return;
    }

    this.settingsStreamRecoveryInFlight = true;
    try {
      this.recordLog("settings-sse", "Settings SSE resume was reset. Refetching settings snapshot.");
      this.stopSettingsEventStream();
      this.settingsEventCursor = null;
      await this.loadSettingsPanelSnapshot();
      if (this.getCurrentUser()) {
        this.startSettingsEventStream(null);
      }
    } finally {
      this.settingsStreamRecoveryInFlight = false;
    }
  }

  private shouldRecoverSettingsStream(error: Error): boolean {
    return /HTTP (400|404|409|410)\b/.test(error.message);
  }

  async bindActiveMarkdownToCrdt(): Promise<void> {
    try {
      const activeFile = this.app.workspace.getActiveFile();
      await this.crdtManager.bindToFile(activeFile);
      await this.syncMarkdownLockForLocalPath(activeFile?.path ?? null);
      this.updateStatusBar();
    } catch (error) {
      this.handleError("CRDT bind failed", error);
      throw error;
    }
  }

  async disconnectCrdt(): Promise<void> {
    await this.crdtManager.disconnect();
    this.updateStatusBar();
  }

  private async bootstrapSync(reason: string): Promise<void> {
    if (!this.canAttemptAuth()) {
      this.recordLog(
        "startup",
        `Skipping ${reason} sync bootstrap because auth settings are incomplete.`
      );
      return;
    }

    try {
      await this.ensureAuthenticated(true, !reason.includes("startup"));
      await this.resumeDownloadedRooms(reason);
    } catch (error) {
      this.handleError("Startup sync failed", error, false);
    }
  }

  private scheduleStartupBootstrap(reason: string): void {
    this.app.workspace.onLayoutReady(() => {
      if (this.isUnloading || this.startupBootstrapHandle !== null) {
        return;
      }

      this.recordLog(
        "startup",
        `Deferring ${reason} sync bootstrap until after the Obsidian workspace finishes opening.`
      );
      this.startupBootstrapHandle = window.setTimeout(() => {
        this.startupBootstrapHandle = null;
        if (this.isUnloading) {
          return;
        }

        void this.bootstrapSync(`${reason}-deferred`);
      }, RolayPlugin.STARTUP_BOOTSTRAP_DELAY_MS);
    });
  }

  private clearDeferredStartupWork(): void {
    if (this.startupBootstrapHandle !== null) {
      window.clearTimeout(this.startupBootstrapHandle);
      this.startupBootstrapHandle = null;
    }

    for (const handle of this.startupRoomResumeHandles) {
      window.clearTimeout(handle);
    }
    this.startupRoomResumeHandles.clear();
  }

  private async ensureAuthenticated(silent = false, resumeRoomsAfterLogin = true): Promise<void> {
    if (this.data.session?.refreshToken) {
      await this.refreshSession(!silent);
      return;
    }

    await this.loginWithSettings(!silent, resumeRoomsAfterLogin);
  }

  private canAttemptAuth(): boolean {
    const { serverUrl, username, password } = this.data.settings;
    return Boolean(serverUrl && ((username && password) || this.data.session?.refreshToken));
  }

  private registerCommands(): void {
    this.addCommand({
      id: "rolay-login",
      name: "Login with configured credentials",
      callback: () => {
        void this.loginWithSettings();
      }
    });

    this.addCommand({
      id: "rolay-refresh-session",
      name: "Refresh current Rolay session",
      callback: () => {
        void this.refreshSession();
      }
    });

    this.addCommand({
      id: "rolay-reload-current-user",
      name: "Reload current Rolay user profile",
      callback: () => {
        void this.fetchCurrentUser(true);
      }
    });

    this.addCommand({
      id: "rolay-refresh-room-list",
      name: "Refresh room list",
      callback: () => {
        void this.refreshRooms(true);
      }
    });

    this.addCommand({
      id: "rolay-connect-active-note",
      name: "Connect active markdown note to Rolay CRDT",
      callback: () => {
        void this.bindActiveMarkdownToCrdt();
      }
    });

    this.addCommand({
      id: "rolay-create-room",
      name: "Create room",
      callback: () => {
        void this.createRoomFromPrompt();
      }
    });

    this.addCommand({
      id: "rolay-join-room",
      name: "Join room by invite key",
      callback: () => {
        void this.joinRoomFromPrompt();
      }
    });
  }

  private async handleFileOpen(file: TFile | null): Promise<void> {
    await this.crdtManager.bindToFile(file);
    if (file && this.findLockedMarkdownPathAtOrBelow(file.path)) {
      const room = this.resolveDownloadedRoomByLocalPath(file.path);
      if (room) {
        this.scheduleSnapshotRefresh(room.workspaceId, "priority-open");
      }
    }
    await this.syncMarkdownLockForLocalPath(file?.path ?? null);
    this.updateStatusBar();
    this.refreshNotePresenceUiNow();
    this.scheduleImmediateExplorerLoadingDecorations();
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    try {
      await this.fileBridge.handleVaultCreate(file);
    } catch (error) {
      this.handleError(`Local create sync failed for ${file.path}`, error, false);
    }
  }

  private async handleVaultModify(file: TAbstractFile): Promise<void> {
    try {
      if (!(file instanceof TFile) || isMarkdownPath(file.path)) {
        return;
      }

      await this.fileBridge.handleVaultModify(file);
    } catch (error) {
      this.handleError(`Local binary modify sync failed for ${file.path}`, error, false);
    }
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    try {
      if (await this.revertLockedMarkdownRename(file, oldPath)) {
        await this.bindActiveMarkdownToCrdt();
        return;
      }

      if (await this.revertDownloadingBinaryRename(file, oldPath)) {
        await this.bindActiveMarkdownToCrdt();
        return;
      }

      await this.refreshMarkdownContentBeforeRoomExit(file, oldPath);
      this.forgetRecentRemoteHintsForLocalPath(oldPath, true);
      this.forgetRecentRemoteHintsForLocalPath(file.path, true);
      this.handlePendingMarkdownCreateRename(oldPath, file.path);
      this.handlePendingMarkdownMergeRename(oldPath, file.path);
      await this.handlePendingBinaryWriteRename(oldPath, file.path);
      await this.fileBridge.handleVaultRename(file, oldPath);
      await this.bindActiveMarkdownToCrdt();
    } catch (error) {
      this.handleError(`Local rename sync failed for ${oldPath}`, error, false);
    }
  }

  private async handleVaultDelete(file: TAbstractFile): Promise<void> {
    try {
      if (await this.restoreLockedMarkdownDelete(file)) {
        await this.bindActiveMarkdownToCrdt();
        return;
      }

      if (await this.restoreDownloadingBinaryDelete(file)) {
        await this.bindActiveMarkdownToCrdt();
        return;
      }

      this.forgetRecentRemoteHintsForLocalPath(file.path, true);
      this.clearPendingMarkdownCreate(file.path);
      this.clearPendingMarkdownMergesForLocalPath(file.path);
      await this.clearPendingBinaryWriteForLocalPath(file.path, true);
      if (await this.handlePotentialRoomRootRemoval(file.path, "delete")) {
        return;
      }

      await this.fileBridge.handleVaultDelete(file);
      await this.bindActiveMarkdownToCrdt();
    } catch (error) {
      this.handleError(`Local delete sync failed for ${file.path}`, error, false);
    }
  }

  private async refreshPostAuthState(logActivity = true): Promise<void> {
    try {
      await this.refreshRooms(false, logActivity);
    } catch (error) {
      this.handleError("Room list refresh failed", error, false);
    }

    if (this.data.session?.user?.isAdmin) {
      try {
        await this.refreshManagedUsers(false, logActivity);
      } catch (error) {
        this.handleError("Admin user list refresh failed", error, false);
      }

      try {
        await this.refreshAdminRooms(false, logActivity);
      } catch (error) {
        this.handleError("Admin room list refresh failed", error, false);
      }
    } else {
      this.clearAdminState();
    }
  }

  private async resumeDownloadedRooms(reason: string): Promise<void> {
    await this.reconcileLocalRoomFolders();
    const downloadedRooms = this.getDownloadedRooms();
    if (downloadedRooms.length === 0) {
      this.recordLog("startup", `No downloaded rooms to resume (${reason}).`);
      return;
    }

    if (reason.includes("startup")) {
      this.recordLog(
        "startup",
        `Scheduling ${downloadedRooms.length} downloaded room(s) for staggered resume (${reason}).`
      );
      downloadedRooms.forEach((room, index) => {
        const handle = window.setTimeout(() => {
          this.startupRoomResumeHandles.delete(handle);
          if (this.isUnloading) {
            return;
          }

          const runtime = this.roomRuntime.get(room.workspaceId);
          if (runtime && runtime.streamStatus !== "stopped") {
            return;
          }

          void this.connectRoom(room.workspaceId, false, reason).catch((error) => {
            this.handleError(`Startup room resume failed (${room.workspaceId})`, error, false);
          });
        }, index * RolayPlugin.STARTUP_ROOM_CONNECT_STAGGER_MS);
        this.startupRoomResumeHandles.add(handle);
      });
      return;
    }

    for (const room of downloadedRooms) {
      await this.connectRoom(room.workspaceId, false, reason);
    }
  }

  private async reconcileDownloadedRooms(): Promise<void> {
    const availableRoomIds = new Set(this.roomList.map((room) => room.workspace.id));

    for (const [roomId, binding] of Object.entries(this.data.settings.roomBindings)) {
      if (!binding.downloaded || availableRoomIds.has(roomId)) {
        continue;
      }

      this.stopRoomEventStream(roomId);
      this.recordLog(
        "rooms",
        `Room ${roomId} is not present in the current room list. Keeping the local folder binding and downloaded flag intact.`
      );
    }
  }

  private reconcileInviteCache(): void {
    const ownerRoomIds = new Set(
      this.roomList
        .filter((room) => room.membershipRole === "owner")
        .map((room) => room.workspace.id)
    );

    for (const roomId of [...this.roomInvites.keys()]) {
      if (!ownerRoomIds.has(roomId)) {
        this.roomInvites.delete(roomId);
      }
    }
  }

  private scheduleSnapshotRefresh(workspaceId: string, reason = "event-stream"): void {
    const runtime = this.ensureRoomRuntime(workspaceId);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    if (runtime.snapshotRefreshInFlight) {
      runtime.snapshotRefreshQueuedReason = runtime.snapshotRefreshQueuedReason ?? reason;
      return;
    }

    if (runtime.snapshotRefreshHandle !== null) {
      runtime.snapshotRefreshQueuedReason = runtime.snapshotRefreshQueuedReason ?? reason;
      return;
    }

    runtime.snapshotRefreshHandle = window.setTimeout(() => {
      runtime.snapshotRefreshHandle = null;
      void this.refreshRoomSnapshot(workspaceId, reason);
    }, 400);
  }

  private clearBackgroundMarkdownRefresh(workspaceId: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    if (runtime.backgroundMarkdownRefreshHandle !== null) {
      window.clearTimeout(runtime.backgroundMarkdownRefreshHandle);
      runtime.backgroundMarkdownRefreshHandle = null;
    }

    runtime.backgroundMarkdownRefreshInFlight = false;
  }

  private scheduleBackgroundMarkdownRefresh(
    workspaceId: string,
    reason: string,
    delayMs = RolayPlugin.ROOM_MARKDOWN_REFRESH_INTERVAL_MS,
    replaceExisting = false
  ): void {
    const runtime = this.ensureRoomRuntime(workspaceId);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    if (runtime.backgroundMarkdownRefreshHandle !== null) {
      if (!replaceExisting) {
        return;
      }

      window.clearTimeout(runtime.backgroundMarkdownRefreshHandle);
      runtime.backgroundMarkdownRefreshHandle = null;
    }

    runtime.backgroundMarkdownRefreshHandle = window.setTimeout(() => {
      runtime.backgroundMarkdownRefreshHandle = null;
      void this.runBackgroundMarkdownRefresh(workspaceId, reason);
    }, Math.max(250, delayMs));
  }

  private async runBackgroundMarkdownRefresh(workspaceId: string, reason: string): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    const binding = this.getStoredRoomBinding(workspaceId);
    if (!runtime || !binding?.downloaded || runtime.streamStatus === "stopped") {
      return;
    }

    if (runtime.backgroundMarkdownRefreshInFlight) {
      this.scheduleBackgroundMarkdownRefresh(workspaceId, reason);
      return;
    }

    if (runtime.markdownBootstrap.status === "loading") {
      this.scheduleBackgroundMarkdownRefresh(workspaceId, reason);
      return;
    }

    runtime.backgroundMarkdownRefreshInFlight = true;
    try {
      await this.refreshClosedRoomMarkdownContent(workspaceId, reason);
    } catch (error) {
      const message = getErrorMessage(error);
      if (isStaleMarkdownBootstrapError(error)) {
        this.recordLog(
          "crdt",
          `[${workspaceId}] Background markdown refresh saw a stale markdown entry; refreshing snapshot before retry.`
        );
        this.scheduleSnapshotRefresh(workspaceId, "markdown-bootstrap-stale-entry");
      } else if (isRetryableBackgroundMarkdownError(error)) {
        this.recordLog(
          "crdt",
          `[${workspaceId}] Background markdown refresh will retry after transient failure: ${message}`
        );
      } else {
        this.recordLog(
          "crdt",
          `[${workspaceId}] Background markdown refresh failed: ${message}`,
          "error"
        );
      }
    } finally {
      runtime.backgroundMarkdownRefreshInFlight = false;

      const currentRuntime = this.roomRuntime.get(workspaceId);
      const currentBinding = this.getStoredRoomBinding(workspaceId);
      if (!currentRuntime || !currentBinding?.downloaded || currentRuntime.streamStatus === "stopped") {
        return;
      }

      this.scheduleBackgroundMarkdownRefresh(workspaceId, "background-markdown");
    }
  }

  private recordLog(scope: string, message: string, level: RolayLogEntry["level"] = "info"): void {
    const entry: RolayLogEntry = {
      at: new Date().toISOString(),
      level,
      scope,
      message
    };

    this.data.logs = [
      ...trimRecentLogEntries(this.data.logs, Date.now(), RolayPlugin.LOG_FILE_RETENTION_MS, 99),
      entry
    ];
    this.pendingLogLines.push(formatPersistentLogLine(entry));
    this.schedulePersist();
    this.scheduleLogFlush();
    console[level === "error" ? "error" : "info"](`[Rolay] ${scope}: ${message}`);
    this.updateStatusBar();
  }

  private handleError(title: string, error: unknown, showNotice = true): void {
    const message = error instanceof Error ? error.message : String(error);
    this.recordLog("error", `${title}: ${message}`, "error");

    if (showNotice) {
      new Notice(`${title}: ${message}`);
    }
  }

  private notifyError(message: string): Error {
    new Notice(message);
    return new Error(message);
  }

  private schedulePersist(): void {
    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
    }

    this.persistHandle = window.setTimeout(() => {
      this.persistHandle = null;
      void this.persistNow();
    }, 300);
  }

  private async persistNow(): Promise<void> {
    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
      this.persistHandle = null;
    }

    await this.saveData(this.data);
    await this.flushLogFile();
  }

  private scheduleLogFlush(): void {
    if (this.logFlushHandle !== null) {
      return;
    }

    this.logFlushHandle = window.setTimeout(() => {
      this.logFlushHandle = null;
      void this.flushLogFile();
    }, 250);
  }

  private async flushLogFile(): Promise<void> {
    if (this.logFlushHandle !== null) {
      window.clearTimeout(this.logFlushHandle);
      this.logFlushHandle = null;
    }

    const nextBatch = this.pendingLogLines.splice(0).join("");
    if (!nextBatch) {
      await this.logFileWrite;
      return;
    }

    this.logFileWrite = this.logFileWrite.then(async () => {
      try {
        await this.ensurePersistentLogFolderExists();
        const adapter = this.app.vault.adapter;
        const logFilePath = this.getPersistentLogFilePath();
        if (await adapter.exists(logFilePath)) {
          await adapter.append(logFilePath, nextBatch);
        } else {
          await adapter.write(logFilePath, nextBatch);
        }

        await this.trimPersistentLogFileIfNeeded(logFilePath);
      } catch (error) {
        console.error("[Rolay] failed to write persistent log file", error);
      }
    });

    await this.logFileWrite;
  }

  private getPersistentLogFilePath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/${RolayPlugin.LOG_FILE_NAME}`);
  }

  private getPersistentLogFolderPath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  private getBinaryTransferFolderPath(): string {
    return normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/${RolayPlugin.BINARY_TRANSFER_PARTS_FOLDER}`
    );
  }

  private getBinaryTransferWorkspaceFolderPath(workspaceId: string): string {
    return normalizePath(`${this.getBinaryTransferFolderPath()}/${sanitizePathSegment(workspaceId)}`);
  }

  private getBinaryDownloadPartPath(workspaceId: string, entryId: string, hash: string): string {
    const normalizedHash = normalizeSha256Hash(hash) ?? hash;
    const safeHash = sanitizePathSegment(normalizedHash.replace(/[:/+=]/g, "-")).slice(0, 48) || "blob";
    return normalizePath(
      `${this.getBinaryTransferWorkspaceFolderPath(workspaceId)}/${sanitizePathSegment(entryId)}-${safeHash}.part`
    );
  }

  private async ensureAdapterFolderExists(folderPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const segments = normalizePath(folderPath).split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (await adapter.exists(currentPath)) {
        continue;
      }

      await adapter.mkdir(currentPath);
    }
  }

  private async ensurePersistentLogFolderExists(): Promise<void> {
    await this.ensureAdapterFolderExists(this.getPersistentLogFolderPath());
  }

  private async trimPersistentLogFileIfNeeded(logFilePath: string): Promise<void> {
    const stat = await this.app.vault.adapter.stat(logFilePath);
    if (!stat || stat.size <= 0) {
      return;
    }

    const fileContents = await this.app.vault.adapter.read(logFilePath);
    const nowMs = Date.now();
    const trimmedByAge = trimPersistentLogByAge(fileContents, RolayPlugin.LOG_FILE_RETENTION_MS, nowMs);
    const trimmedBySize = trimPersistentLogBySize(
      trimmedByAge,
      RolayPlugin.MAX_LOG_FILE_BYTES,
      RolayPlugin.LOG_FILE_TRIM_TARGET_BYTES,
      nowMs
    );

    if (trimmedBySize !== fileContents) {
      await this.app.vault.adapter.write(logFilePath, trimmedBySize);
    }
  }

  private async getAdapterFileSize(path: string): Promise<number> {
    try {
      const stat = await this.app.vault.adapter.stat(normalizePath(path));
      return stat?.size ?? 0;
    } catch {
      return 0;
    }
  }

  private async removeAdapterPathIfExists(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    try {
      if (!(await this.app.vault.adapter.exists(normalizedPath))) {
        return;
      }
      await this.app.vault.adapter.remove(normalizedPath);
    } catch {
      // Best-effort cleanup for transfer temp files.
    }
  }

  private async writeBinaryTransferPart(
    partPath: string,
    data: ArrayBuffer,
    append: boolean
  ): Promise<void> {
    await this.ensureAdapterFolderExists(getParentPath(partPath));
    if (append) {
      await this.app.vault.adapter.appendBinary(normalizePath(partPath), data);
      return;
    }

    await this.app.vault.adapter.writeBinary(normalizePath(partPath), data);
  }

  private async readBinaryTransferPart(partPath: string): Promise<ArrayBuffer | null> {
    try {
      if (!(await this.app.vault.adapter.exists(normalizePath(partPath)))) {
        return null;
      }
      return await this.app.vault.adapter.readBinary(normalizePath(partPath));
    } catch {
      return null;
    }
  }

  private requireAdmin(): void {
    if (!this.data.session?.user?.isAdmin) {
      throw this.notifyError("This action is admin-only.");
    }
  }

  private requireRoom(workspaceId: string): RoomListItem {
    const room = this.roomList.find((item) => item.workspace.id === workspaceId);
    if (!room) {
      throw this.notifyError("Room is not available in the current membership list.");
    }

    return room;
  }

  private requireDownloadedRoom(workspaceId: string): RoomListItem {
    const room = this.requireRoom(workspaceId);
    const binding = this.getStoredRoomBinding(workspaceId);
    if (!binding?.downloaded) {
      throw new Error("Download the room folder first.");
    }

    return room;
  }

  private requireOwnerRoom(workspaceId: string): RoomListItem {
    const room = this.requireRoom(workspaceId);
    if (room.membershipRole !== "owner") {
      throw this.notifyError("Only room owners can manage invite keys.");
    }

    return room;
  }

  private requireRoomPublicationManager(workspaceId: string): void {
    if (this.data.session?.user?.isAdmin) {
      return;
    }

    const room = this.requireRoom(workspaceId);
    if (room.membershipRole !== "owner") {
      throw this.notifyError("Only room owners and admins can change room publication.");
    }
  }

  private getKnownRoomName(workspaceId: string): string {
    return (
      this.roomList.find((room) => room.workspace.id === workspaceId)?.workspace.name ??
      this.adminRoomList.find((room) => room.workspace.id === workspaceId)?.workspace.name ??
      this.getStoredRoomBinding(workspaceId)?.folderName ??
      workspaceId
    );
  }

  private getStoredRoomBinding(workspaceId: string): RolayRoomBindingSettings | null {
    return getRoomBindingSettings(this.data.settings, workspaceId);
  }

  private getResolvedRoomFolderName(workspaceId: string, fallbackRoomName: string): string {
    const binding = this.getStoredRoomBinding(workspaceId);
    return normalizeRoomFolderName(binding?.folderName || fallbackRoomName);
  }

  private getDownloadedFolderName(workspaceId: string): string | null {
    const binding = this.getStoredRoomBinding(workspaceId);
    if (!binding?.downloaded) {
      return null;
    }

    const room = this.roomList.find((item) => item.workspace.id === workspaceId);
    return normalizeRoomFolderName(binding.folderName || room?.workspace.name || workspaceId);
  }

  private getDownloadedRooms(): DownloadedRoomDescriptor[] {
    // Persisted room bindings are the source of truth for "this room was
    // installed into the vault before". The live room list may briefly be
    // unavailable during startup/auth refresh and should not erase that local
    // fact.
    return Object.entries(this.data.settings.roomBindings)
      .filter(([, binding]) => Boolean(binding.downloaded))
      .map(([workspaceId, binding]) => {
        const room = this.roomList.find((item) => item.workspace.id === workspaceId);
        return {
          workspaceId,
          folderName: normalizeRoomFolderName(binding.folderName || room?.workspace.name || workspaceId)
        };
      });
  }

  private ensureRoomRuntime(workspaceId: string): RoomRuntimeState {
    const existing = this.roomRuntime.get(workspaceId);
    if (existing) {
      return existing;
    }

    const runtime: RoomRuntimeState = {
      treeStore: new TreeStore(),
      eventStream: null,
      eventStreamGeneration: 0,
      notePresenceStream: null,
      notePresenceStreamGeneration: 0,
      notePresenceByEntryId: new Map(),
      noteAnonymousViewerCountByEntryId: new Map(),
      streamStatus: "stopped",
      lastHandledEventId: null,
      snapshotRefreshHandle: null,
      snapshotRefreshInFlight: false,
      snapshotRefreshQueuedReason: null,
      backgroundMarkdownRefreshHandle: null,
      backgroundMarkdownRefreshInFlight: false,
      lockedBootstrapRetryHandle: null,
      lockedBootstrapRetryAttempt: 0,
      markdownBootstrap: {
        status: "idle",
        totalTargets: 0,
        completedTargets: 0,
        totalBytes: 0,
        completedBytes: 0,
        documentBytesByEntryId: new Map(),
        completedEntryIds: new Set(),
        hydratedTargets: 0,
        lockedLocalPaths: new Set<string>(),
        lastRunAt: null,
        lastError: null,
        rerunRequested: false,
        runToken: 0
      }
    };
    this.roomRuntime.set(workspaceId, runtime);
    return runtime;
  }

  private getRoomStore(workspaceId: string): TreeStore | null {
    return this.roomRuntime.get(workspaceId)?.treeStore ?? null;
  }

  private resolveDownloadedRoomByLocalPath(localPath: string): DownloadedRoomDescriptor | null {
    const downloadedRooms = this.getDownloadedRooms().sort(
      (left, right) => right.folderName.length - left.folderName.length
    );

    for (const room of downloadedRooms) {
      if (toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName) !== null) {
        return room;
      }
    }

    return null;
  }

  private findLockedMarkdownPathAtOrBelow(
    localPath: string
  ): { workspaceId: string; lockedPath: string } | null {
    const normalizedLocalPath = normalizePath(localPath);

    for (const [workspaceId, runtime] of this.roomRuntime.entries()) {
      for (const lockedPath of runtime.markdownBootstrap.lockedLocalPaths) {
        if (
          lockedPath === normalizedLocalPath ||
          lockedPath.startsWith(`${normalizedLocalPath}/`) ||
          normalizedLocalPath.startsWith(`${lockedPath}/`)
        ) {
          return {
            workspaceId,
            lockedPath
          };
        }
      }
    }

    return null;
  }

  private async shouldKeepMarkdownLocked(
    workspaceId: string,
    entry: FileEntry,
    localPath: string,
    persistedState: Uint8Array | null = null
  ): Promise<boolean> {
    const normalizedLocalPath = normalizePath(localPath);
    const waitingForRemoteSettle = this.isWaitingForRemoteMarkdownSettle(workspaceId, normalizedLocalPath);
    const activeCrdtState = this.crdtManager.getState();
    if (
      activeCrdtState?.entryId === entry.id &&
      (activeCrdtState.status === "synced" || activeCrdtState.status === "offline")
    ) {
      return false;
    }

    if (this.hasPendingLocalCreate(workspaceId, entry.path)) {
      return true;
    }

    if (this.data.pendingMarkdownCreates[normalizedLocalPath]) {
      return true;
    }

    if (this.data.pendingMarkdownMerges[entry.id]) {
      return true;
    }

    const localFile = this.app.vault.getAbstractFileByPath(normalizedLocalPath);
    if (!(localFile instanceof TFile) || localFile.extension !== "md") {
      return true;
    }

    const nextState = persistedState ?? this.getPersistedCrdtState(entry.id);
    if (!nextState) {
      return true;
    }

    const openViews = getMarkdownViewsForFile(this.app, normalizedLocalPath);
    const currentText = openViews.length > 0
      ? openViews[0].editor.getValue()
      : await this.app.vault.cachedRead(localFile);
    const expectedText = decodeMarkdownTextState(nextState);

    if (waitingForRemoteSettle && expectedText.length === 0) {
      return true;
    }

    return currentText !== expectedText;
  }

  private async refreshRoomMarkdownLocks(workspaceId: string, entries: FileEntry[]): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    runtime.markdownBootstrap.lockedLocalPaths.clear();
    for (const entry of entries) {
      if (entry.deleted || entry.kind !== "markdown") {
        continue;
      }

      const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path;
      if (await this.shouldKeepMarkdownLocked(workspaceId, entry, localPath)) {
        runtime.markdownBootstrap.lockedLocalPaths.add(normalizePath(localPath));
      }
    }

    if (runtime.markdownBootstrap.lockedLocalPaths.size === 0) {
      this.clearLockedMarkdownBootstrapRetry(workspaceId, false);
    } else if (runtime.markdownBootstrap.status !== "loading") {
      this.scheduleLockedMarkdownBootstrapRetry(workspaceId, "locked-retry");
    }

    this.scheduleExplorerLoadingDecorations();
  }

  private async syncMarkdownLockForEntry(
    workspaceId: string,
    entry: FileEntry,
    localPath: string,
    persistedState: Uint8Array | null = null
  ): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    const normalizedLocalPath = normalizePath(localPath);
    if (await this.shouldKeepMarkdownLocked(workspaceId, entry, normalizedLocalPath, persistedState)) {
      runtime.markdownBootstrap.lockedLocalPaths.add(normalizedLocalPath);
    } else {
      runtime.markdownBootstrap.lockedLocalPaths.delete(normalizedLocalPath);
      this.clearPendingRemoteMarkdownSettle(workspaceId, normalizedLocalPath);
    }

    if (runtime.markdownBootstrap.lockedLocalPaths.size === 0) {
      this.clearLockedMarkdownBootstrapRetry(workspaceId, false);
    } else if (runtime.markdownBootstrap.status !== "loading") {
      this.scheduleLockedMarkdownBootstrapRetry(workspaceId, "locked-retry");
    }

    this.scheduleExplorerLoadingDecorations();
  }

  private async syncMarkdownLockForLocalPath(localPath: string | null): Promise<void> {
    if (!localPath) {
      this.scheduleExplorerLoadingDecorations();
      return;
    }

    const room = this.resolveDownloadedRoomByLocalPath(localPath);
    if (!room) {
      this.scheduleExplorerLoadingDecorations();
      return;
    }

    const serverPath = toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName);
    if (!serverPath) {
      this.scheduleExplorerLoadingDecorations();
      return;
    }

    const entry = this.getRoomStore(room.workspaceId)?.getEntryByPath(serverPath) ?? null;
    if (!entry || entry.kind !== "markdown" || entry.deleted) {
      this.scheduleExplorerLoadingDecorations();
      return;
    }

    await this.syncMarkdownLockForEntry(room.workspaceId, entry, localPath);
  }

  private scheduleExplorerLoadingDecorations(): void {
    if (this.explorerDecorationHandle !== null) {
      return;
    }

    this.explorerDecorationHandle = window.setTimeout(() => {
      this.explorerDecorationHandle = null;
      this.refreshExplorerLoadingDecorations();
    }, 80);
  }

  private scheduleImmediateExplorerLoadingDecorations(): void {
    if (this.explorerDecorationHandle !== null) {
      window.clearTimeout(this.explorerDecorationHandle);
      this.explorerDecorationHandle = null;
    }

    if (this.explorerDecorationFrame !== null) {
      return;
    }

    this.explorerDecorationFrame = window.requestAnimationFrame(() => {
      this.explorerDecorationFrame = null;
      this.refreshExplorerLoadingDecorations();
    });
  }

  private refreshNotePresenceUiNow(): void {
    if (this.notePresenceUiHandle !== null) {
      window.clearTimeout(this.notePresenceUiHandle);
      this.notePresenceUiHandle = null;
    }

    this.refreshNotePresenceUi();
  }

  private refreshExplorerDecorationsAfterFolderToggle(): void {
    this.scheduleImmediateExplorerLoadingDecorations();

    if (this.explorerToggleRefreshHandle !== null) {
      return;
    }

    // Obsidian usually toggles the explorer DOM synchronously, but one trailing
    // frame catches theme/plugin delayed class changes without returning to the
    // slower general sync debounce.
    this.explorerToggleRefreshHandle = window.setTimeout(() => {
      this.explorerToggleRefreshHandle = null;
      this.scheduleImmediateExplorerLoadingDecorations();
    }, 32);
  }

  private ensureExplorerMutationObserver(): void {
    if (this.explorerMutationObserver || typeof MutationObserver === "undefined") {
      return;
    }

    const container = this.app.workspace.containerEl;
    if (!container) {
      return;
    }

    this.explorerMutationObserver = new MutationObserver((mutations) => {
      if (this.shouldRefreshExplorerDecorationsForMutations(mutations)) {
        this.refreshExplorerDecorationsAfterFolderToggle();
      }
    });
    this.explorerMutationObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-expanded", "style"],
      attributeOldValue: true
    });
  }

  private scheduleNotePresenceUiRefresh(): void {
    if (this.notePresenceUiHandle !== null) {
      return;
    }

    this.notePresenceUiHandle = window.setTimeout(() => {
      this.notePresenceUiHandle = null;
      this.refreshNotePresenceUi();
    }, 80);
  }

  private refreshNotePresenceUi(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }

      this.renderNotePresenceChipsForView(view);
    }
  }

  private refreshExplorerLoadingDecorations(): void {
    const container = this.app.workspace.containerEl;
    if (!container) {
      return;
    }

    const loadingPaths = this.getLoadingExplorerPaths();
    const uploadingPaths = this.getUploadingExplorerPaths();
    const roomFolderStatuses = this.getRoomFolderExplorerStatuses();
    const pathElements = [...container.querySelectorAll<HTMLElement>("[data-path]")];
    const visibleExplorerPaths = this.getVisibleExplorerPathSet(pathElements);
    const transferBadges = this.getExplorerTransferBadges();
    const notePresenceBadges = this.getExplorerNotePresenceBadges(visibleExplorerPaths);
    const anonymousPresenceBadges = this.getExplorerAnonymousPresenceBadges(visibleExplorerPaths);

    for (const element of pathElements) {
      element.classList.remove(
        "rolay-loading-path",
        "rolay-loading-ancestor",
        "rolay-uploading-path",
        "rolay-uploading-ancestor",
        "rolay-room-folder",
        "rolay-room-folder-disconnected",
        "rolay-room-folder-connecting",
        "rolay-room-folder-connected"
      );

      const dataPath = element.getAttribute("data-path");
      if (!dataPath) {
        continue;
      }

      const normalizedPath = normalizePath(dataPath);
      const exactMatch = loadingPaths.has(normalizedPath);
      const descendantMatch = !exactMatch && [...loadingPaths].some((loadingPath) => {
        return loadingPath.startsWith(`${normalizedPath}/`);
      });
      const exactUploadingMatch = uploadingPaths.has(normalizedPath);
      const descendantUploadingMatch = !exactUploadingMatch && [...uploadingPaths].some((uploadingPath) => {
        return uploadingPath.startsWith(`${normalizedPath}/`);
      });
      const roomFolderStatus = roomFolderStatuses.get(normalizedPath) ?? null;

      if (exactMatch || descendantMatch) {
        element.classList.add("rolay-loading-path");
      }

      if (descendantMatch) {
        element.classList.add("rolay-loading-ancestor");
      }

      if (exactUploadingMatch || descendantUploadingMatch) {
        element.classList.add("rolay-uploading-path");
      }

      if (descendantUploadingMatch) {
        element.classList.add("rolay-uploading-ancestor");
      }

      if (roomFolderStatus) {
        element.classList.add("rolay-room-folder");
        if (roomFolderStatus === "open") {
          element.classList.add("rolay-room-folder-connected");
        } else if (roomFolderStatus === "stopped") {
          element.classList.add("rolay-room-folder-disconnected");
        } else {
          element.classList.add("rolay-room-folder-connecting");
        }
      }

      this.updateExplorerTransferBadge(
        element,
        transferBadges.get(normalizedPath) ?? null
      );
      this.updateExplorerNotePresenceBadge(
        element,
        notePresenceBadges.get(normalizedPath) ?? null
      );
      this.updateExplorerAnonymousPresenceBadge(
        element,
        anonymousPresenceBadges.get(normalizedPath) ?? null
      );
    }
  }

  private renderNotePresenceChipsForView(view: MarkdownView): void {
    const file = view.file;
    const host = this.findNotePresenceHost(view);
    if (!host) {
      this.removeNotePresenceBar(view);
      return;
    }

    const presence = file ? this.getNotePresenceForLocalPath(file.path) : {
      viewers: [],
      anonymousViewerCount: 0
    };
    if (presence.viewers.length === 0 && presence.anonymousViewerCount === 0) {
      this.removeNotePresenceBar(view);
      return;
    }

    let bar = view.containerEl.querySelector<HTMLElement>(".rolay-note-presence-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "rolay-note-presence-bar";
      host.parentElement?.insertBefore(bar, host);
    }

    const signature = presence
      .viewers
      .map((viewer) => `${viewer.presenceId}:${viewer.displayName}:${viewer.color}`)
      .join("|") + `|anonymous:${presence.anonymousViewerCount}`;
    if (bar.dataset.signature === signature) {
      return;
    }

    bar.dataset.signature = signature;
    bar.replaceChildren(
      ...presence.viewers.map((viewer) => {
        const chip = document.createElement("span");
        chip.className = "rolay-note-presence-chip";
        chip.textContent = viewer.displayName;
        chip.style.setProperty("--rolay-note-presence-color", viewer.color);
        return chip;
      }),
      ...(presence.anonymousViewerCount > 0
        ? [this.createAnonymousPresenceChip(presence.anonymousViewerCount)]
        : [])
    );
  }

  private createAnonymousPresenceChip(count: number): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "rolay-note-presence-chip rolay-note-presence-chip-anonymous";
    chip.setAttribute(
      "aria-label",
      count === 1 ? "1 anonymous public viewer" : `${count} anonymous public viewers`
    );

    const icon = document.createElement("span");
    icon.className = "rolay-note-presence-chip-icon";
    setIcon(icon, "eye");

    const label = document.createElement("span");
    label.textContent = String(count);

    chip.replaceChildren(icon, label);
    return chip;
  }

  private removeNotePresenceBar(view: MarkdownView): void {
    view.containerEl.querySelector<HTMLElement>(".rolay-note-presence-bar")?.remove();
  }

  private findNotePresenceHost(view: MarkdownView): HTMLElement | null {
    const container = view.containerEl;
    return (
      container.querySelector<HTMLElement>(".inline-title") ??
      container.querySelector<HTMLElement>(".view-content .inline-title")
    );
  }

  private getExplorerNotePresenceBadges(
    visibleExplorerPaths: Set<string>
  ): Map<string, ExplorerNotePresenceBadgeState> {
    const aggregate = new Map<string, { count: number; soleColor: string | null }>();
    const downloadedRooms = new Map(
      this.getDownloadedRooms().map((room) => [room.workspaceId, room] as const)
    );

    for (const [workspaceId, runtime] of this.roomRuntime.entries()) {
      const downloadedRoom = downloadedRooms.get(workspaceId);
      if (!downloadedRoom) {
        continue;
      }

      const roomRoot = normalizePath(getRoomRoot(this.data.settings.syncRoot, downloadedRoom.folderName));
      let localPresenceRolledUp = false;
      for (const [entryId, viewers] of runtime.notePresenceByEntryId.entries()) {
        const effectiveViewers = this.mergeLocalNotePresenceViewer(workspaceId, entryId, viewers);
        if (effectiveViewers.length === 0) {
          continue;
        }
        localPresenceRolledUp ||= this.isLocalNotePresenceForEntry(workspaceId, entryId);

        const entry = runtime.treeStore.getEntryById(entryId);
        if (!entry || entry.deleted || entry.kind !== "markdown") {
          continue;
        }

        const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path);
        if (!localPath) {
          continue;
        }

        const normalizedLocalPath = normalizePath(localPath);
        this.accumulateExplorerNotePresenceBadge(
          aggregate,
          this.getMinimalVisibleExplorerPresencePath(normalizedLocalPath, roomRoot, visibleExplorerPaths),
          effectiveViewers
        );
      }

      const localPresence = this.crdtManager.getLocalNotePresenceViewer();
      if (
        localPresence &&
        localPresence.workspaceId === workspaceId &&
        !localPresenceRolledUp &&
        !runtime.notePresenceByEntryId.has(localPresence.entryId)
      ) {
        const entry = runtime.treeStore.getEntryById(localPresence.entryId);
        const localPath = entry && !entry.deleted && entry.kind === "markdown"
          ? this.fileBridge.toLocalPath(workspaceId, entry.path)
          : null;
        if (localPath) {
          this.accumulateExplorerNotePresenceBadge(
            aggregate,
            this.getMinimalVisibleExplorerPresencePath(normalizePath(localPath), roomRoot, visibleExplorerPaths),
            [localPresence]
          );
        }
      }
    }

    const badges = new Map<string, ExplorerNotePresenceBadgeState>();
    for (const [localPath, state] of aggregate) {
      badges.set(localPath, {
        count: state.count,
        color: state.count === 1
          ? (state.soleColor ?? "var(--interactive-accent, #8b5cf6)")
          : "var(--interactive-accent, #8b5cf6)"
      });
    }

    return badges;
  }

  private getExplorerAnonymousPresenceBadges(
    visibleExplorerPaths: Set<string>
  ): Map<string, ExplorerAnonymousPresenceBadgeState> {
    const aggregate = new Map<string, number>();
    const downloadedRooms = new Map(
      this.getDownloadedRooms().map((room) => [room.workspaceId, room] as const)
    );

    for (const [workspaceId, runtime] of this.roomRuntime.entries()) {
      const downloadedRoom = downloadedRooms.get(workspaceId);
      if (!downloadedRoom) {
        continue;
      }

      const roomRoot = normalizePath(getRoomRoot(this.data.settings.syncRoot, downloadedRoom.folderName));
      for (const [entryId, anonymousViewerCount] of runtime.noteAnonymousViewerCountByEntryId.entries()) {
        if (anonymousViewerCount <= 0) {
          continue;
        }

        const entry = runtime.treeStore.getEntryById(entryId);
        if (!entry || entry.deleted || entry.kind !== "markdown") {
          continue;
        }

        const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path);
        if (!localPath) {
          continue;
        }

        const normalizedLocalPath = normalizePath(localPath);
        this.accumulateExplorerAnonymousPresenceBadge(
          aggregate,
          this.getMinimalVisibleExplorerPresencePath(normalizedLocalPath, roomRoot, visibleExplorerPaths),
          anonymousViewerCount
        );
      }
    }

    return new Map(
      [...aggregate.entries()].map(([localPath, count]) => [localPath, { count }] as const)
    );
  }

  private accumulateExplorerNotePresenceBadge(
    aggregate: Map<string, { count: number; soleColor: string | null }>,
    localPath: string,
    viewers: NotePresenceViewer[]
  ): void {
    const existing = aggregate.get(localPath);
    const nextCount = (existing?.count ?? 0) + viewers.length;
    const nextSoleColor =
      nextCount === 1
        ? viewers[0]?.color ?? existing?.soleColor ?? null
        : null;

    aggregate.set(localPath, {
      count: nextCount,
      soleColor: nextSoleColor
    });
  }

  private accumulateExplorerAnonymousPresenceBadge(
    aggregate: Map<string, number>,
    localPath: string,
    anonymousViewerCount: number
  ): void {
    aggregate.set(localPath, (aggregate.get(localPath) ?? 0) + anonymousViewerCount);
  }

  private mergeLocalNotePresenceViewer(
    workspaceId: string,
    entryId: string,
    viewers: readonly NotePresenceViewer[]
  ): NotePresenceViewer[] {
    const merged = [...viewers];
    const localPresence = this.crdtManager.getLocalNotePresenceViewer();
    if (!localPresence || localPresence.workspaceId !== workspaceId || localPresence.entryId !== entryId) {
      return merged;
    }

    if (merged.some((viewer) => this.isSamePresenceViewer(viewer, localPresence))) {
      return merged;
    }

    merged.push(localPresence);
    merged.sort(compareNotePresenceViewers);
    return merged;
  }

  private isLocalNotePresenceForEntry(workspaceId: string, entryId: string): boolean {
    const localPresence = this.crdtManager.getLocalNotePresenceViewer();
    return Boolean(localPresence && localPresence.workspaceId === workspaceId && localPresence.entryId === entryId);
  }

  private isSamePresenceViewer(viewer: NotePresenceViewer, localPresence: LocalNotePresenceViewer): boolean {
    if (viewer.presenceId === localPresence.presenceId) {
      return true;
    }

    const localClientId = localPresence.presenceId.split(":").pop();
    return Boolean(
      localClientId &&
      viewer.userId === localPresence.userId &&
      viewer.presenceId.endsWith(`:${localClientId}`)
    );
  }

  private getVisibleExplorerPathSet(pathElements: HTMLElement[]): Set<string> {
    const visiblePaths = new Set<string>();
    for (const element of pathElements) {
      const dataPath = element.getAttribute("data-path");
      if (!dataPath || !this.isExplorerDecorationElement(element) || !this.isElementVisiblyRendered(element)) {
        continue;
      }

      visiblePaths.add(normalizePath(dataPath));
    }

    return visiblePaths;
  }

  private getMinimalVisibleExplorerPresencePath(
    localPath: string,
    roomRoot: string,
    visibleExplorerPaths: Set<string>
  ): string {
    const normalizedRoomRoot = normalizePath(roomRoot);
    let candidate = normalizePath(localPath);

    while (candidate) {
      if (
        (candidate === normalizedRoomRoot || candidate.startsWith(`${normalizedRoomRoot}/`)) &&
        visibleExplorerPaths.has(candidate)
      ) {
        return candidate;
      }

      if (candidate === normalizedRoomRoot) {
        break;
      }

      const parentPath = getParentPath(candidate);
      if (!parentPath || parentPath === candidate) {
        break;
      }

      candidate = parentPath;
    }

    return visibleExplorerPaths.has(normalizedRoomRoot) ? normalizedRoomRoot : normalizePath(localPath);
  }

  private isExplorerDecorationElement(element: HTMLElement): boolean {
    return Boolean(
      element.closest(".nav-files-container") ||
      element.closest('.workspace-leaf-content[data-type="file-explorer"]') ||
      element.classList.contains("nav-file") ||
      element.classList.contains("nav-folder") ||
      element.classList.contains("nav-file-title") ||
      element.classList.contains("nav-folder-title") ||
      element.classList.contains("tree-item-self")
    );
  }

  private isElementVisiblyRendered(element: HTMLElement): boolean {
    return element.getClientRects().length > 0;
  }

  private shouldRefreshExplorerDecorationsForMutations(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (!(target instanceof HTMLElement) || !this.isExplorerDecorationElement(target)) {
          continue;
        }

        if (mutation.attributeName === "class") {
          const previousClass = this.stripRolayDecorationClasses(mutation.oldValue ?? "");
          const currentClass = this.stripRolayDecorationClasses(target.className);
          if (previousClass === currentClass) {
            continue;
          }
        }

        return true;
      }

      if (mutation.type !== "childList") {
        continue;
      }

      const target = mutation.target;
      if (!(target instanceof HTMLElement) || !this.isExplorerDecorationElement(target)) {
        continue;
      }

      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
      if (changedNodes.length === 0 || changedNodes.every((node) => this.isRolayDecorationNode(node))) {
        continue;
      }

      if (changedNodes.some((node) => this.isExplorerStructureNode(node))) {
        return true;
      }
    }

    return false;
  }

  private stripRolayDecorationClasses(className: string): string {
    return className
      .split(/\s+/)
      .filter((classToken) => classToken && !classToken.startsWith("rolay-"))
      .sort()
      .join(" ");
  }

  private isRolayDecorationNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    return this.isRolayDecorationElement(node);
  }

  private isRolayDecorationElement(element: HTMLElement): boolean {
    return Boolean(
      element.closest(
        ".rolay-note-presence-badge, .rolay-note-anonymous-presence-badge, .rolay-transfer-progress-badge"
      ) ||
      [...element.classList].some((className) => className.startsWith("rolay-"))
    );
  }

  private isExplorerStructureNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    return Boolean(
      node.matches?.("[data-path], .nav-file, .nav-folder, .nav-file-title, .nav-folder-title, .tree-item-self") ||
      node.querySelector?.("[data-path], .nav-file, .nav-folder, .nav-file-title, .nav-folder-title, .tree-item-self")
    );
  }

  private isExplorerFolderInteractionTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const folderElement = target.closest<HTMLElement>(".nav-folder, .nav-folder-title");
    if (!folderElement) {
      return false;
    }

    return Boolean(
      folderElement.closest(".nav-files-container") ||
      folderElement.closest('.workspace-leaf-content[data-type="file-explorer"]')
    );
  }

  private updateExplorerNotePresenceBadge(
    element: HTMLElement,
    badgeState: ExplorerNotePresenceBadgeState | null
  ): void {
    const titleHost = this.findExplorerTitleHost(element);
    if (!titleHost) {
      return;
    }

    let badge = titleHost.querySelector<HTMLElement>(".rolay-note-presence-badge");
    if (!badgeState) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rolay-note-presence-badge";
      const anonymousBadge = titleHost.querySelector<HTMLElement>(".rolay-note-anonymous-presence-badge");
      if (anonymousBadge) {
        titleHost.insertBefore(badge, anonymousBadge);
      } else {
        titleHost.appendChild(badge);
      }
    }

    badge.style.setProperty("--rolay-note-presence-badge-color", badgeState.color);
    badge.textContent = badgeState.count <= 1 ? "" : String(badgeState.count);
    badge.classList.toggle("rolay-note-presence-badge-multi", badgeState.count > 1);
    badge.setAttribute("aria-label", badgeState.count <= 1 ? "1 viewer" : `${badgeState.count} viewers`);
  }

  private updateExplorerAnonymousPresenceBadge(
    element: HTMLElement,
    badgeState: ExplorerAnonymousPresenceBadgeState | null
  ): void {
    const titleHost = this.findExplorerTitleHost(element);
    if (!titleHost) {
      return;
    }

    let badge = titleHost.querySelector<HTMLElement>(".rolay-note-anonymous-presence-badge");
    if (!badgeState || badgeState.count <= 0) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rolay-note-anonymous-presence-badge";
      titleHost.appendChild(badge);
    }

    const icon = document.createElement("span");
    icon.className = "rolay-note-anonymous-presence-badge-icon";
    setIcon(icon, "eye");

    const label = document.createElement("span");
    label.textContent = String(badgeState.count);

    badge.replaceChildren(icon, label);
    badge.setAttribute(
      "aria-label",
      badgeState.count === 1
        ? "1 anonymous public viewer"
        : `${badgeState.count} anonymous public viewers`
    );
  }

  private getExplorerTransferBadges(): Map<string, ExplorerTransferBadgeState> {
    const aggregate = new Map<string, ExplorerTransferBadgeAggregate>();
    const exactTransferPaths = new Set<string>();

    for (const transfer of this.binaryTransferState.values()) {
      const activeUpload =
        transfer.kind === "upload" &&
        (
          transfer.status === "preparing" ||
          transfer.status === "uploading" ||
          transfer.status === "canceling" ||
          transfer.status === "committing"
        );
      const activeDownload =
        transfer.kind === "download" &&
        (transfer.status === "preparing" || transfer.status === "downloading");

      if (!activeUpload && !activeDownload) {
        continue;
      }

      exactTransferPaths.add(normalizePath(transfer.localPath));
      this.addExplorerTransferProgress(
        aggregate,
        transfer.localPath,
        transfer.kind,
        Math.max(0, transfer.bytesDone),
        Math.max(0, transfer.bytesTotal)
      );
    }

    for (const placeholderPath of this.fileBridge.getProtectedRemoteBinaryPlaceholderPaths()) {
      const normalizedPath = normalizePath(placeholderPath);
      if (exactTransferPaths.has(normalizedPath)) {
        continue;
      }

      // The room tree may materialize an empty remote binary placeholder a
      // moment before the actual blob ticket/download starts. Showing `0%`
      // immediately keeps the explorer honest instead of flashing "normal"
      // and only later turning into a red downloading file.
      exactTransferPaths.add(normalizedPath);
      const entry = this.resolveEntryByLocalPath(normalizedPath);
      this.addExplorerTransferProgress(
        aggregate,
        normalizedPath,
        "download",
        0,
        entry?.blob?.sizeBytes ?? 1
      );
    }

    for (const [workspaceId, runtime] of this.roomRuntime.entries()) {
      for (const lockedPath of runtime.markdownBootstrap.lockedLocalPaths) {
        const normalizedPath = normalizePath(lockedPath);
        if (this.isExplorerPathUploading(normalizedPath) || exactTransferPaths.has(normalizedPath)) {
          continue;
        }

        const progress = this.getMarkdownLockProgress(workspaceId, normalizedPath);
        this.addExplorerTransferProgress(
          aggregate,
          normalizedPath,
          "download",
          progress.completedBytes,
          progress.totalBytes
        );
      }
    }

    for (const pendingCreate of Object.values(this.data.pendingMarkdownCreates)) {
      const normalizedPath = normalizePath(pendingCreate.localPath);
      if (exactTransferPaths.has(normalizedPath)) {
        continue;
      }

      exactTransferPaths.add(normalizedPath);
      this.addExplorerTransferProgress(
        aggregate,
        normalizedPath,
        "upload",
        0,
        this.getLocalFileSizeOrOne(normalizedPath)
      );
    }

    for (const pendingMerge of Object.values(this.data.pendingMarkdownMerges)) {
      const normalizedPath = normalizePath(pendingMerge.localPath);
      if (exactTransferPaths.has(normalizedPath)) {
        continue;
      }

      exactTransferPaths.add(normalizedPath);
      this.addExplorerTransferProgress(
        aggregate,
        normalizedPath,
        "upload",
        0,
        this.getLocalFileSizeOrOne(normalizedPath)
      );
    }

    for (const pendingWrite of Object.values(this.data.pendingBinaryWrites)) {
      const normalizedPath = normalizePath(pendingWrite.localPath);
      if (exactTransferPaths.has(normalizedPath)) {
        continue;
      }

      exactTransferPaths.add(normalizedPath);
      this.addExplorerTransferProgress(
        aggregate,
        normalizedPath,
        "upload",
        0,
        this.getLocalFileSizeOrOne(normalizedPath)
      );
    }

    return new Map(
      [...aggregate.entries()].map(([localPath, state]) => [
        localPath,
        {
          label: this.formatExplorerTransferAggregatePercentLabel(state),
          kind: state.kind
        }
      ] as const)
    );
  }

  private addExplorerTransferProgress(
    aggregate: Map<string, ExplorerTransferBadgeAggregate>,
    localPath: string,
    kind: BinaryTransferKind,
    completedBytes: number,
    totalBytes: number
  ): void {
    const normalizedPath = normalizePath(localPath);
    this.mergeExplorerTransferProgress(aggregate, normalizedPath, kind, completedBytes, totalBytes);

    const room = this.resolveDownloadedRoomByLocalPath(normalizedPath);
    if (!room) {
      return;
    }

    const roomRoot = normalizePath(getRoomRoot(this.data.settings.syncRoot, room.folderName));
    let parentPath = getParentPath(normalizedPath);
    while (parentPath) {
      if (parentPath !== roomRoot && !parentPath.startsWith(`${roomRoot}/`)) {
        break;
      }

      this.mergeExplorerTransferProgress(aggregate, parentPath, kind, completedBytes, totalBytes);
      if (parentPath === roomRoot) {
        break;
      }

      parentPath = getParentPath(parentPath);
    }
  }

  private mergeExplorerTransferProgress(
    aggregate: Map<string, ExplorerTransferBadgeAggregate>,
    localPath: string,
    kind: BinaryTransferKind,
    completedBytes: number,
    totalBytes: number
  ): void {
    const normalizedTotalBytes = Math.max(1, Math.trunc(totalBytes));
    const normalizedCompletedBytes = Math.max(
      0,
      Math.min(Math.trunc(completedBytes), normalizedTotalBytes)
    );
    const existing = aggregate.get(localPath);
    if (!existing) {
      aggregate.set(localPath, {
        kind,
        completedBytes: normalizedCompletedBytes,
        totalBytes: normalizedTotalBytes,
        itemCount: 1
      });
      return;
    }

    aggregate.set(localPath, {
      kind: existing.kind === "download" || kind === "download" ? "download" : "upload",
      completedBytes: existing.completedBytes + normalizedCompletedBytes,
      totalBytes: existing.totalBytes + normalizedTotalBytes,
      itemCount: existing.itemCount + 1
    });
  }

  private formatExplorerTransferAggregatePercentLabel(state: ExplorerTransferBadgeAggregate): string {
    if (state.totalBytes <= 0) {
      return "0%";
    }

    const percent = Math.round((state.completedBytes / state.totalBytes) * 100);
    return `${Math.max(0, Math.min(100, percent))}%`;
  }

  private getMarkdownLockProgress(
    workspaceId: string,
    localPath: string
  ): { completedBytes: number; totalBytes: number } {
    const runtime = this.roomRuntime.get(workspaceId);
    const room = this.getDownloadedRooms().find((entry) => entry.workspaceId === workspaceId);
    if (!runtime || !room) {
      return {
        completedBytes: 0,
        totalBytes: 1
      };
    }

    const serverPath = toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName);
    const entry = serverPath ? runtime.treeStore.getEntryByPath(serverPath) : null;
    if (!entry) {
      return {
        completedBytes: 0,
        totalBytes: 1
      };
    }

    const totalBytes = Math.max(
      1,
      runtime.markdownBootstrap.documentBytesByEntryId.get(entry.id) ?? 1
    );
    const completed = runtime.markdownBootstrap.completedEntryIds.has(entry.id) || this.hasPersistedCrdtCache(entry.id);
    return {
      completedBytes: completed ? totalBytes : 0,
      totalBytes
    };
  }

  private getLocalFileSizeOrOne(localPath: string): number {
    const file = this.app.vault.getAbstractFileByPath(localPath);
    if (file instanceof TFile && Number.isFinite(file.stat.size) && file.stat.size > 0) {
      return file.stat.size;
    }

    return 1;
  }

  private isExplorerPathUploading(localPath: string): boolean {
    const normalizedPath = normalizePath(localPath);
    if (normalizedPath in this.data.pendingMarkdownCreates) {
      return true;
    }

    if (normalizedPath in this.data.pendingBinaryWrites) {
      return true;
    }

    if (
      Object.values(this.data.pendingMarkdownMerges).some((entry) => {
        return normalizePath(entry.localPath) === normalizedPath;
      })
    ) {
      return true;
    }

    const transfer = this.binaryTransferState.get(normalizedPath);
    return Boolean(
      transfer &&
      transfer.kind === "upload" &&
      (
        transfer.status === "preparing" ||
        transfer.status === "uploading" ||
        transfer.status === "canceling" ||
        transfer.status === "committing"
      )
    );
  }

  private updateExplorerTransferBadge(
    element: HTMLElement,
    badgeState: ExplorerTransferBadgeState | null
  ): void {
    const titleHost = this.findExplorerTitleHost(element);
    if (!titleHost) {
      return;
    }

    let badge = titleHost.querySelector<HTMLElement>(".rolay-transfer-progress-badge");
    if (!badgeState) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rolay-transfer-progress-badge";
      const presenceBadge = titleHost.querySelector<HTMLElement>(
        ".rolay-note-presence-badge, .rolay-note-anonymous-presence-badge"
      );
      if (presenceBadge) {
        titleHost.insertBefore(badge, presenceBadge);
      } else {
        titleHost.appendChild(badge);
      }
    }

    badge.textContent = badgeState.label;
    badge.classList.toggle("rolay-transfer-progress-badge-upload", badgeState.kind === "upload");
    badge.classList.toggle("rolay-transfer-progress-badge-download", badgeState.kind === "download");
    badge.setAttribute(
      "aria-label",
      badgeState.kind === "upload"
        ? `Upload progress ${badgeState.label}`
        : `Download progress ${badgeState.label}`
    );
  }

  private findExplorerTitleHost(element: HTMLElement): HTMLElement | null {
    return (
      element.querySelector<HTMLElement>(".nav-file-title-content") ??
      element.querySelector<HTMLElement>(".tree-item-inner")
    );
  }

  private getLoadingExplorerPaths(): Set<string> {
    const loadingPaths = new Set<string>();
    const uploadingPaths = this.getUploadingExplorerPaths();

    for (const runtime of this.roomRuntime.values()) {
      for (const lockedPath of runtime.markdownBootstrap.lockedLocalPaths) {
        if (!uploadingPaths.has(lockedPath)) {
          loadingPaths.add(lockedPath);
        }
      }
    }

    // Snapshot materialization creates empty binary placeholders before the
    // actual blob download starts. Treat those protected placeholders as
    // loading immediately so the file is red from the first rendered frame.
    for (const placeholderPath of this.fileBridge.getProtectedRemoteBinaryPlaceholderPaths()) {
      const normalizedPath = normalizePath(placeholderPath);
      const transfer = this.binaryTransferState.get(normalizedPath);
      if (!transfer) {
        loadingPaths.add(normalizedPath);
        continue;
      }

      if (
        transfer.kind === "download" &&
        (transfer.status === "preparing" || transfer.status === "downloading")
      ) {
        loadingPaths.add(normalizedPath);
      }
    }

    for (const transfer of this.binaryTransferState.values()) {
      if (transfer.kind !== "download") {
        continue;
      }

      if (transfer.status === "preparing" || transfer.status === "downloading") {
        loadingPaths.add(normalizePath(transfer.localPath));
      }
    }

    return loadingPaths;
  }

  private getUploadingExplorerPaths(): Set<string> {
    const uploadingPaths = new Set<string>();

    for (const pendingCreate of Object.values(this.data.pendingMarkdownCreates)) {
      uploadingPaths.add(normalizePath(pendingCreate.localPath));
    }

    for (const pendingMerge of Object.values(this.data.pendingMarkdownMerges)) {
      uploadingPaths.add(normalizePath(pendingMerge.localPath));
    }

    for (const pendingWrite of Object.values(this.data.pendingBinaryWrites)) {
      uploadingPaths.add(normalizePath(pendingWrite.localPath));
    }

    for (const transfer of this.binaryTransferState.values()) {
      if (transfer.kind !== "upload") {
        continue;
      }

      if (
        transfer.status === "preparing" ||
        transfer.status === "uploading" ||
        transfer.status === "canceling" ||
        transfer.status === "committing"
      ) {
        uploadingPaths.add(normalizePath(transfer.localPath));
      }
    }

    return uploadingPaths;
  }

  private getRoomFolderExplorerStatuses(): Map<string, WorkspaceEventStreamStatus> {
    const statuses = new Map<string, WorkspaceEventStreamStatus>();

    for (const room of this.getDownloadedRooms()) {
      const roomRoot = getRoomRoot(this.data.settings.syncRoot, room.folderName);
      if (!roomRoot) {
        continue;
      }

      statuses.set(
        normalizePath(roomRoot),
        this.roomRuntime.get(room.workspaceId)?.streamStatus ?? "stopped"
      );
    }

    return statuses;
  }

  private getNotePresenceForLocalPath(localPath: string): NotePresenceDisplayState {
    const room = this.resolveDownloadedRoomByLocalPath(localPath);
    if (!room) {
      return createEmptyNotePresenceDisplayState();
    }

    const serverPath = toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName);
    if (!serverPath) {
      return createEmptyNotePresenceDisplayState();
    }

    const entry = this.getRoomStore(room.workspaceId)?.getEntryByPath(serverPath);
    if (!entry || entry.deleted || entry.kind !== "markdown") {
      return createEmptyNotePresenceDisplayState();
    }

    return this.getNotePresenceForEntry(room.workspaceId, entry.id);
  }

  private getNotePresenceForEntry(workspaceId: string, entryId: string): NotePresenceDisplayState {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return createEmptyNotePresenceDisplayState();
    }

    const viewers = runtime.notePresenceByEntryId.get(entryId) ?? [];
    return {
      viewers: this.mergeLocalNotePresenceViewer(workspaceId, entryId, viewers),
      anonymousViewerCount: runtime.noteAnonymousViewerCountByEntryId.get(entryId) ?? 0
    };
  }

  private applyNotePresenceSnapshot(workspaceId: string, payload: unknown): void {
    const snapshot = extractNotePresenceSnapshotPayload(payload);
    if (!snapshot || snapshot.workspaceId !== workspaceId) {
      return;
    }

    const runtime = this.ensureRoomRuntime(workspaceId);
    runtime.notePresenceByEntryId.clear();
    runtime.noteAnonymousViewerCountByEntryId.clear();
    for (const note of snapshot.notes) {
      if (note.viewers.length > 0) {
        runtime.notePresenceByEntryId.set(note.entryId, note.viewers);
      }

      if (note.anonymousViewerCount > 0) {
        runtime.noteAnonymousViewerCountByEntryId.set(note.entryId, note.anonymousViewerCount);
      }
    }

    this.scheduleExplorerLoadingDecorations();
    this.scheduleNotePresenceUiRefresh();
  }

  private applyNotePresenceUpdate(workspaceId: string, payload: unknown): void {
    const update = extractNotePresenceUpdatedPayload(payload);
    if (!update || update.workspaceId !== workspaceId) {
      return;
    }

    const runtime = this.ensureRoomRuntime(workspaceId);
    if (update.viewers.length === 0) {
      runtime.notePresenceByEntryId.delete(update.entryId);
    } else {
      runtime.notePresenceByEntryId.set(update.entryId, update.viewers);
    }

    if (update.anonymousViewerCount <= 0) {
      runtime.noteAnonymousViewerCountByEntryId.delete(update.entryId);
    } else {
      runtime.noteAnonymousViewerCountByEntryId.set(update.entryId, update.anonymousViewerCount);
    }

    this.scheduleExplorerLoadingDecorations();
    this.scheduleNotePresenceUiRefresh();
  }

  private getBinaryTransfersForWorkspace(workspaceId: string): BinaryTransferState[] {
    return [...this.binaryTransferState.values()].filter((transfer) => transfer.workspaceId === workspaceId);
  }

  private formatRoomBinaryTransferLabel(workspaceId: string): string {
    const transfers = this.getBinaryTransfersForWorkspace(workspaceId).filter((transfer) => {
      return transfer.status !== "done";
    });
    if (transfers.length === 0) {
      return "idle";
    }

    const activeUploads = transfers.filter((transfer) => transfer.kind === "upload");
    const activeDownloads = transfers.filter((transfer) => transfer.kind === "download");
    const totalBytes = transfers.reduce((sum, transfer) => sum + Math.max(0, transfer.bytesTotal), 0);
    const completedBytes = transfers.reduce((sum, transfer) => {
      return sum + Math.min(Math.max(0, transfer.bytesDone), Math.max(0, transfer.bytesTotal));
    }, 0);

    const percent = totalBytes > 0 ? `${Math.round((completedBytes / totalBytes) * 100)}%` : "working";
    const parts: string[] = [];
    if (activeUploads.length > 0) {
      parts.push(`${activeUploads.length} uploading`);
    }
    if (activeDownloads.length > 0) {
      parts.push(`${activeDownloads.length} downloading`);
    }

    if (totalBytes > 0) {
      return `${percent} (${formatByteCount(completedBytes)}/${formatByteCount(totalBytes)}, ${parts.join(", ")})`;
    }

    return parts.join(", ");
  }

  private createBinarySyncToken(localPath: string): string {
    const normalizedLocalPath = normalizePath(localPath);
    const existingToken = this.binarySyncTokens.get(normalizedLocalPath);
    if (existingToken) {
      this.binarySyncPathsByToken.delete(existingToken);
    }

    const token = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `rolay-binary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.binarySyncTokens.set(normalizedLocalPath, token);
    this.binarySyncPathsByToken.set(token, normalizedLocalPath);
    return token;
  }

  private invalidateBinarySyncToken(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    const existingToken = this.binarySyncTokens.get(normalizedLocalPath);
    if (existingToken) {
      this.binarySyncPathsByToken.delete(existingToken);
    }
    this.binarySyncTokens.delete(normalizedLocalPath);
  }

  private isBinarySyncTokenCurrent(localPath: string, token: string): boolean {
    return this.binarySyncTokens.get(normalizePath(localPath)) === token;
  }

  private moveBinarySyncToken(oldPath: string, newPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const existingToken = this.binarySyncTokens.get(normalizedOldPath);
    if (!existingToken) {
      return;
    }

    this.binarySyncTokens.delete(normalizedOldPath);
    this.binarySyncTokens.set(normalizedNewPath, existingToken);
    this.binarySyncPathsByToken.set(existingToken, normalizedNewPath);
  }

  private getBinarySyncPathForToken(token: string): string | null {
    return this.binarySyncPathsByToken.get(token) ?? null;
  }

  private updateBinaryTransferState(localPath: string, patch: Partial<BinaryTransferState>): BinaryTransferState {
    const normalizedLocalPath = normalizePath(localPath);
    const existing = this.binaryTransferState.get(normalizedLocalPath);
    if (!existing) {
      throw new Error(`Missing binary transfer state for ${normalizedLocalPath}.`);
    }

    const nextState: BinaryTransferState = {
      ...existing,
      ...patch,
      localPath: normalizedLocalPath,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    this.binaryTransferState.set(normalizedLocalPath, nextState);
    this.persistBinaryTransferState(nextState);
    this.scheduleExplorerLoadingDecorations();
    this.updateStatusBar();
    return nextState;
  }

  private maybeUpdateBinaryTransferState(
    localPath: string,
    patch: Partial<BinaryTransferState>
  ): BinaryTransferState | null {
    const normalizedLocalPath = normalizePath(localPath);
    const existing = this.binaryTransferState.get(normalizedLocalPath);
    if (!existing) {
      return null;
    }

    return this.updateBinaryTransferState(normalizedLocalPath, patch);
  }

  private setBinaryTransferState(state: BinaryTransferState): void {
    const normalizedLocalPath = normalizePath(state.localPath);
    const nextState = {
      ...state,
      localPath: normalizedLocalPath
    };
    this.binaryTransferState.set(normalizedLocalPath, nextState);
    this.persistBinaryTransferState(nextState);
    this.scheduleExplorerLoadingDecorations();
    this.updateStatusBar();
  }

  private traceBlob(message: string, level: RolayLogEntry["level"] = "info"): void {
    if (!RolayPlugin.ENABLE_BLOB_TRANSFER_TRACE) {
      return;
    }

    this.recordLog("blob-trace", message, level);
  }

  private clearBinaryTransferRuntimeState(localPath: string): void {
    if (!this.binaryTransferState.delete(normalizePath(localPath))) {
      return;
    }

    this.scheduleExplorerLoadingDecorations();
    this.updateStatusBar();
  }

  private clearBinaryTransferState(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    this.clearPersistedBinaryTransferState(normalizedLocalPath);
    this.clearBinaryTransferRuntimeState(normalizedLocalPath);
  }

  private restorePersistedBinaryTransfers(): void {
    for (const persisted of Object.values(this.data.binaryTransfers)) {
      this.binaryTransferState.set(normalizePath(persisted.localPath), {
        workspaceId: persisted.workspaceId,
        entryId: persisted.entryId,
        localPath: normalizePath(persisted.localPath),
        serverPath: persisted.serverPath,
        kind: persisted.kind,
        status: persisted.status,
        bytesTotal: persisted.bytesTotal,
        bytesDone: persisted.bytesDone,
        hash: persisted.hash,
        mimeType: persisted.mimeType,
        uploadId: persisted.uploadId,
        cancelUrl: null,
        lastError: persisted.lastError,
        rangeSupported: persisted.rangeSupported,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        rerunRequested: false,
        abortController: null
      });
    }
  }

  private persistBinaryTransferState(state: BinaryTransferState): void {
    const normalizedLocalPath = normalizePath(state.localPath);
    this.data.binaryTransfers[normalizedLocalPath] = {
      workspaceId: state.workspaceId,
      entryId: state.entryId,
      localPath: normalizedLocalPath,
      serverPath: state.serverPath,
      kind: state.kind,
      status: state.status,
      bytesTotal: state.bytesTotal,
      bytesDone: state.bytesDone,
      hash: state.hash,
      mimeType: state.mimeType,
      uploadId: state.uploadId,
      rangeSupported: state.rangeSupported,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      lastError: state.lastError
    };
    this.schedulePersist();
  }

  private clearPersistedBinaryTransferState(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    if (!(normalizedLocalPath in this.data.binaryTransfers)) {
      return;
    }

    delete this.data.binaryTransfers[normalizedLocalPath];
    this.schedulePersist();
  }

  private movePersistedBinaryTransferState(oldPath: string, newPath: string, serverPath?: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const existing = this.data.binaryTransfers[normalizedOldPath];
    if (!existing) {
      return;
    }

    delete this.data.binaryTransfers[normalizedOldPath];
    this.data.binaryTransfers[normalizedNewPath] = {
      ...existing,
      localPath: normalizedNewPath,
      serverPath: serverPath ?? existing.serverPath,
      updatedAt: new Date().toISOString()
    };

    const runtime = this.binaryTransferState.get(normalizedOldPath);
    if (runtime) {
      this.binaryTransferState.delete(normalizedOldPath);
      this.binaryTransferState.set(normalizedNewPath, {
        ...runtime,
        localPath: normalizedNewPath,
        serverPath: serverPath ?? runtime.serverPath,
        updatedAt: new Date().toISOString()
      });
    }

    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private getBinaryBlobContentUrl(entryId: string, contentUrl?: string | null): string {
    if (contentUrl?.trim()) {
      return contentUrl.trim();
    }

    return `/v1/files/${encodeURIComponent(entryId)}/blob/content`;
  }

  private async clearBinaryDownloadPart(
    workspaceId: string,
    entryId: string | null,
    hash: string | null
  ): Promise<void> {
    const normalizedHash = normalizeSha256Hash(hash);
    if (!entryId || !normalizedHash) {
      return;
    }

    await this.removeAdapterPathIfExists(
      this.getBinaryDownloadPartPath(workspaceId, entryId, normalizedHash)
    );
  }

  private async cancelBinaryTransferForLocalPath(localPath: string, reason: string): Promise<void> {
    const normalizedLocalPath = normalizePath(localPath);
    const transfer = this.binaryTransferState.get(normalizedLocalPath);
    if (!transfer) {
      return;
    }

    if (transfer.kind === "upload" && transfer.uploadId && transfer.entryId) {
      this.updateBinaryTransferState(normalizedLocalPath, {
        status: "canceling"
      });
    }

    transfer.abortController?.abort();

    if (transfer.kind === "upload" && transfer.uploadId && transfer.entryId) {
      try {
        await this.apiClient.cancelBlobUpload(transfer.entryId, transfer.uploadId);
        this.recordLog(
          "blob",
          `[${transfer.workspaceId}] Canceled blob upload ${transfer.uploadId} for ${transfer.serverPath} (${reason}).`
        );
      } catch (error) {
        this.recordLog(
          "blob",
          `[${transfer.workspaceId}] Failed to cancel blob upload ${transfer.uploadId} for ${transfer.serverPath}: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    }

    if (transfer.kind === "download") {
      await this.clearBinaryDownloadPart(transfer.workspaceId, transfer.entryId, transfer.hash);
    }

    this.clearBinaryTransferState(normalizedLocalPath);
  }

  private async cancelRoomBinaryTransfers(workspaceId: string, reason: string): Promise<void> {
    for (const localPath of [...this.binarySyncTokens.keys()]) {
      const room = this.resolveDownloadedRoomByLocalPath(localPath);
      if (room?.workspaceId !== workspaceId) {
        continue;
      }

      this.invalidateBinarySyncToken(localPath);
      this.pendingBinarySyncReruns.delete(normalizePath(localPath));
    }

    const transfers = this.getBinaryTransfersForWorkspace(workspaceId);
    if (transfers.length === 0) {
      return;
    }

    this.recordLog(
      "blob",
      `[${workspaceId}] Canceling ${transfers.length} active binary transfer(s) because room sync was disconnected.`
    );
    await Promise.all(
      transfers.map((transfer) => this.cancelBinaryTransferForLocalPath(transfer.localPath, reason))
    );
  }

  private findDownloadingBinaryPathAtOrBelow(localPath: string): { workspaceId: string; localPath: string } | null {
    const normalizedLocalPath = normalizePath(localPath);
    for (const transfer of this.binaryTransferState.values()) {
      if (
        transfer.kind !== "download" ||
        (transfer.status !== "preparing" && transfer.status !== "downloading")
      ) {
        continue;
      }

      const transferLocalPath = normalizePath(transfer.localPath);
      if (
        normalizedLocalPath === transferLocalPath ||
        transferLocalPath.startsWith(`${normalizedLocalPath}/`)
      ) {
        return {
          workspaceId: transfer.workspaceId,
          localPath: transferLocalPath
        };
      }
    }

    return null;
  }

  private async revertDownloadingBinaryRename(file: TAbstractFile, oldPath: string): Promise<boolean> {
    const blocked = this.findDownloadingBinaryPathAtOrBelow(oldPath);
    if (!blocked) {
      return false;
    }

    this.recordLog(
      "blob",
      `[${blocked.workspaceId}] Reverted local move/rename for ${oldPath} because ${blocked.localPath} is still downloading and protected.`
    );
    new Notice("Rolay is still downloading this file. Move and rename are blocked until download finishes.");

    if (file.path === oldPath) {
      this.scheduleExplorerLoadingDecorations();
      return true;
    }

    const currentFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!currentFile) {
      this.scheduleSnapshotRefresh(blocked.workspaceId, "restore-downloading-binary-rename");
      return true;
    }

    try {
      await this.fileBridge.runWithSuppressedPaths([oldPath, file.path], async () => {
        await this.app.fileManager.renameFile(currentFile, oldPath);
      });
    } catch (error) {
      this.recordLog(
        "blob",
        `[${blocked.workspaceId}] Failed to revert downloading binary rename for ${oldPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      this.scheduleSnapshotRefresh(blocked.workspaceId, "restore-downloading-binary-rename");
    }

    this.scheduleExplorerLoadingDecorations();
    return true;
  }

  private async restoreDownloadingBinaryDelete(file: TAbstractFile): Promise<boolean> {
    const blocked = this.findDownloadingBinaryPathAtOrBelow(file.path);
    if (!blocked) {
      return false;
    }

    this.recordLog(
      "blob",
      `[${blocked.workspaceId}] Ignored local delete for ${file.path} because ${blocked.localPath} is still downloading and protected.`
    );
    new Notice("Rolay is still downloading this file. Delete is blocked until download finishes.");
    await this.refreshRoomSnapshot(blocked.workspaceId, "restore-downloading-binary-delete");
    this.scheduleExplorerLoadingDecorations();
    return true;
  }

  private async revertLockedMarkdownRename(file: TAbstractFile, oldPath: string): Promise<boolean> {
    const blocked = this.findLockedMarkdownPathAtOrBelow(oldPath);
    if (!blocked) {
      return false;
    }

    this.recordLog(
      "crdt",
      `[${blocked.workspaceId}] Reverted local move/rename for ${oldPath} because ${blocked.lockedPath} is still loading and protected.`
    );
    new Notice("Rolay is still loading this markdown note. Move and rename are blocked until download finishes.");

    if (file.path === oldPath) {
      this.scheduleExplorerLoadingDecorations();
      return true;
    }

    const currentFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!currentFile) {
      this.scheduleSnapshotRefresh(blocked.workspaceId, "restore-locked-rename");
      return true;
    }

    try {
      await this.fileBridge.runWithSuppressedPaths([oldPath, file.path], async () => {
        await this.app.fileManager.renameFile(currentFile, oldPath);
      });
    } catch (error) {
      this.recordLog(
        "crdt",
        `[${blocked.workspaceId}] Failed to revert locked rename for ${oldPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      this.scheduleSnapshotRefresh(blocked.workspaceId, "restore-locked-rename");
    }

    this.scheduleExplorerLoadingDecorations();
    return true;
  }

  private async restoreLockedMarkdownDelete(file: TAbstractFile): Promise<boolean> {
    const blocked = this.findLockedMarkdownPathAtOrBelow(file.path);
    if (!blocked) {
      return false;
    }

    this.recordLog(
      "crdt",
      `[${blocked.workspaceId}] Ignored local delete for ${file.path} because ${blocked.lockedPath} is still loading and protected.`
    );
    new Notice("Rolay is still loading this markdown note. Delete is blocked until download finishes.");
    await this.refreshRoomSnapshot(blocked.workspaceId, "restore-locked-delete");
    this.scheduleExplorerLoadingDecorations();
    return true;
  }

  private clearLockedMarkdownBootstrapRetry(workspaceId: string, resetAttempt = true): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    if (runtime.lockedBootstrapRetryHandle !== null) {
      window.clearTimeout(runtime.lockedBootstrapRetryHandle);
      runtime.lockedBootstrapRetryHandle = null;
    }

    if (resetAttempt) {
      runtime.lockedBootstrapRetryAttempt = 0;
    }
  }

  private scheduleLockedMarkdownBootstrapRetry(workspaceId: string, reason: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    if (runtime.markdownBootstrap.lockedLocalPaths.size === 0) {
      this.clearLockedMarkdownBootstrapRetry(workspaceId);
      return;
    }

    if (runtime.lockedBootstrapRetryHandle !== null) {
      return;
    }

    const retryDelays = [1000, 2000, 4000, 8000];
    const delay = retryDelays[Math.min(runtime.lockedBootstrapRetryAttempt, retryDelays.length - 1)];
    runtime.lockedBootstrapRetryHandle = window.setTimeout(() => {
      runtime.lockedBootstrapRetryHandle = null;
      runtime.lockedBootstrapRetryAttempt = Math.min(
        runtime.lockedBootstrapRetryAttempt + 1,
        retryDelays.length - 1
      );

      const currentRuntime = this.roomRuntime.get(workspaceId);
      const roomBinding = this.getStoredRoomBinding(workspaceId);
      if (!currentRuntime || !roomBinding?.downloaded) {
        return;
      }

      const lockedEntries = currentRuntime.treeStore.getEntries().filter((entry) => {
        if (entry.deleted || entry.kind !== "markdown") {
          return false;
        }

        const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path;
        return currentRuntime.markdownBootstrap.lockedLocalPaths.has(normalizePath(localPath));
      });

      if (lockedEntries.length === 0) {
        this.clearLockedMarkdownBootstrapRetry(workspaceId);
        return;
      }

      void this.bootstrapRoomMarkdownCache(
        workspaceId,
        lockedEntries,
        reason,
        currentRuntime.treeStore.getEntries()
      );
    }, delay);
  }

  private buildPendingRoomPathKey(workspaceId: string, path: string): string {
    return `${workspaceId}::${path.replace(/\\/g, "/")}`;
  }

  private registerPendingLocalCreate(workspaceId: string, path: string): void {
    this.pendingLocalCreates.set(this.buildPendingRoomPathKey(workspaceId, path), Date.now());
  }

  private clearPendingLocalCreate(workspaceId: string, path: string): void {
    this.pendingLocalCreates.delete(this.buildPendingRoomPathKey(workspaceId, path));
  }

  private hasPendingLocalCreate(workspaceId: string, path: string): boolean {
    const key = this.buildPendingRoomPathKey(workspaceId, path);
    const createdAt = this.pendingLocalCreates.get(key);
    if (createdAt === undefined) {
      return false;
    }

    if (Date.now() - createdAt <= RolayPlugin.PENDING_CREATE_CONFIRMATION_TTL_MS) {
      return true;
    }

    this.pendingLocalCreates.delete(key);
    return false;
  }

  private registerPendingLocalDelete(workspaceId: string, path: string): void {
    this.pendingLocalDeletes.set(this.buildPendingRoomPathKey(workspaceId, path), Date.now());
  }

  private clearPendingLocalDelete(workspaceId: string, path: string): void {
    this.pendingLocalDeletes.delete(this.buildPendingRoomPathKey(workspaceId, path));
  }

  private hasPendingLocalDelete(workspaceId: string, path: string): boolean {
    const prefix = `${workspaceId}::`;
    const normalizedPath = normalizePath(path);
    const now = Date.now();

    for (const [key, createdAt] of [...this.pendingLocalDeletes.entries()]) {
      if (now - createdAt > RolayPlugin.PENDING_DELETE_GUARD_MS) {
        this.pendingLocalDeletes.delete(key);
        continue;
      }

      if (!key.startsWith(prefix)) {
        continue;
      }

      const pendingPath = key.slice(prefix.length);
      if (normalizedPath === pendingPath || normalizedPath.startsWith(`${pendingPath}/`)) {
        return true;
      }
    }

    return false;
  }

  private clearPendingRoomPathsForWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}::`;
    for (const key of [...this.pendingLocalCreates.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingLocalCreates.delete(key);
      }
    }

    for (const key of [...this.pendingLocalDeletes.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingLocalDeletes.delete(key);
      }
    }

    for (const [key, handle] of [...this.recentRemoteObservedPaths.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      window.clearTimeout(handle);
      this.recentRemoteObservedPaths.delete(key);
    }

    for (const [key, handle] of [...this.pendingRemoteMarkdownSettles.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      window.clearTimeout(handle);
      this.pendingRemoteMarkdownSettles.delete(key);
    }
  }

  private optimisticUpsertRoomEntry(workspaceId: string, entry: FileEntry): void {
    this.getRoomStore(workspaceId)?.upsertEntry(entry);
  }

  private optimisticDeleteRoomEntry(workspaceId: string, entryId: string): void {
    this.getRoomStore(workspaceId)?.markEntryDeleted(entryId);
  }

  private confirmSnapshotPendingCreates(workspaceId: string, entries: FileEntry[]): void {
    for (const entry of entries) {
      if (entry.deleted) {
        continue;
      }

      this.clearPendingLocalCreate(workspaceId, entry.path);
    }
  }

  private confirmSnapshotPendingDeletes(workspaceId: string, entries: FileEntry[]): void {
    const prefix = `${workspaceId}::`;
    const activePaths = entries
      .filter((entry) => !entry.deleted)
      .map((entry) => normalizePath(entry.path));

    for (const key of [...this.pendingLocalDeletes.keys()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const pendingPath = key.slice(prefix.length);
      const stillActive = activePaths.some((activePath) => {
        return activePath === pendingPath || activePath.startsWith(`${pendingPath}/`);
      });
      if (!stillActive) {
        this.pendingLocalDeletes.delete(key);
      }
    }
  }

  private buildRemoteObservedPathKey(workspaceId: string, localPath: string): string {
    return `${workspaceId}::${normalizePath(localPath)}`;
  }

  private noteRemoteObservedPath(workspaceId: string, localPath: string, serverPath: string): void {
    const key = this.buildRemoteObservedPathKey(workspaceId, localPath);
    const existingHandle = this.recentRemoteObservedPaths.get(key);
    if (existingHandle !== undefined) {
      window.clearTimeout(existingHandle);
    }

    const handle = window.setTimeout(() => {
      this.recentRemoteObservedPaths.delete(key);
    }, RolayPlugin.RECENT_REMOTE_PATH_TTL_MS);
    this.recentRemoteObservedPaths.set(key, handle);
    if (/\.(md|markdown)$/i.test(localPath) || /\.md$/i.test(serverPath)) {
      this.markPendingRemoteMarkdownSettle(workspaceId, localPath);
    }
    this.clearPendingLocalCreate(workspaceId, serverPath);
    this.clearPendingMarkdownCreate(localPath);
    this.clearPendingBinaryWriteRecord(localPath);
  }

  private wasPathRecentlyObservedAsRemote(workspaceId: string, localPath: string): boolean {
    return this.recentRemoteObservedPaths.has(this.buildRemoteObservedPathKey(workspaceId, localPath));
  }

  private forgetRecentRemoteHintsForLocalPath(localPath: string, clearSettle = false): void {
    const room = this.resolveDownloadedRoomByLocalPath(localPath);
    if (!room) {
      return;
    }

    this.forgetRecentRemoteObservedPath(room.workspaceId, localPath, clearSettle);
  }

  private forgetRecentRemoteObservedPath(
    workspaceId: string,
    localPath: string,
    clearSettle = false
  ): void {
    const key = this.buildRemoteObservedPathKey(workspaceId, localPath);
    const handle = this.recentRemoteObservedPaths.get(key);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      this.recentRemoteObservedPaths.delete(key);
    }

    if (clearSettle) {
      this.clearPendingRemoteMarkdownSettle(workspaceId, localPath);
    }
  }

  private markPendingRemoteMarkdownSettle(workspaceId: string, localPath: string): void {
    const key = this.buildRemoteObservedPathKey(workspaceId, localPath);
    const existingHandle = this.pendingRemoteMarkdownSettles.get(key);
    if (existingHandle !== undefined) {
      window.clearTimeout(existingHandle);
    }

    const handle = window.setTimeout(() => {
      this.pendingRemoteMarkdownSettles.delete(key);
      this.scheduleSnapshotRefresh(workspaceId, "remote-markdown-settle");
      this.scheduleExplorerLoadingDecorations();
    }, RolayPlugin.REMOTE_MARKDOWN_SETTLE_TTL_MS);
    this.pendingRemoteMarkdownSettles.set(key, handle);
  }

  private isWaitingForRemoteMarkdownSettle(workspaceId: string, localPath: string): boolean {
    return this.pendingRemoteMarkdownSettles.has(this.buildRemoteObservedPathKey(workspaceId, localPath));
  }

  private clearPendingRemoteMarkdownSettle(workspaceId: string, localPath: string): void {
    const key = this.buildRemoteObservedPathKey(workspaceId, localPath);
    const handle = this.pendingRemoteMarkdownSettles.get(key);
    if (handle === undefined) {
      return;
    }

    window.clearTimeout(handle);
    this.pendingRemoteMarkdownSettles.delete(key);
  }

  private async saveRoomBinding(
    workspaceId: string,
    nextBinding: Partial<RolayRoomBindingSettings>
  ): Promise<void> {
    const current = this.getStoredRoomBinding(workspaceId) ?? {
      folderName: "",
      downloaded: false
    };

    await this.updateSettings({
      roomBindings: {
        [workspaceId]: {
          ...current,
          ...nextBinding
        }
      }
    });
  }

  private requireFolderNameForRoom(workspaceId: string, fallbackRoomName: string): string {
    const folderName = this.getResolvedRoomFolderName(workspaceId, fallbackRoomName);
    if (!isValidRoomFolderName(folderName)) {
      throw this.notifyError("Room folder name must be non-empty and must not contain '/' or '\\'.");
    }

    return folderName;
  }

  private isLocalPathInDownloadedRoom(localPath: string, workspaceId: string): boolean {
    const folderName = this.getDownloadedFolderName(workspaceId);
    if (!folderName) {
      return false;
    }

    return toServerPathForRoom(localPath, this.data.settings.syncRoot, folderName) !== null;
  }

  private isRoomSyncActive(workspaceId: string): boolean {
    const runtime = this.roomRuntime.get(workspaceId);
    return Boolean(
      !this.isUnloading &&
      runtime &&
      runtime.streamStatus !== "stopped" &&
      this.getStoredRoomBinding(workspaceId)?.downloaded
    );
  }

  private isFolderNameUsedByAnotherRoom(workspaceId: string, folderName: string): boolean {
    for (const room of this.roomList) {
      if (room.workspace.id === workspaceId) {
        continue;
      }

      const otherFolderName = this.getResolvedRoomFolderName(room.workspace.id, room.workspace.name);
      if (otherFolderName && otherFolderName === folderName) {
        const binding = this.getStoredRoomBinding(room.workspace.id);
        if (binding?.downloaded || binding?.folderName) {
          return true;
        }
      }
    }

    return false;
  }

  private async deactivateRoomDownload(workspaceId: string, showNotice = false): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && this.isLocalPathInDownloadedRoom(activeFile.path, workspaceId)) {
      await this.crdtManager.disconnect();
    }

    this.stopRoomEventStream(workspaceId);
    this.clearLockedMarkdownBootstrapRetry(workspaceId, false);

    const runtime = this.roomRuntime.get(workspaceId);
    if (runtime && runtime.snapshotRefreshHandle !== null) {
      window.clearTimeout(runtime.snapshotRefreshHandle);
    }

    this.roomRuntime.delete(workspaceId);
    this.scheduleExplorerLoadingDecorations();
    this.roomInvites.delete(workspaceId);
    this.clearPendingRoomPathsForWorkspace(workspaceId);
    this.clearPendingMarkdownCreatesForWorkspace(workspaceId);
    this.clearPendingMarkdownMergesForWorkspace(workspaceId);
    await this.clearPendingBinaryWritesForWorkspace(workspaceId);

    const binding = this.getStoredRoomBinding(workspaceId);
    if (binding?.downloaded) {
      await this.saveRoomBinding(workspaceId, {
        downloaded: false
      });
    }

    if (showNotice) {
      new Notice("Rolay room folder detached from the vault.");
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }

    this.statusBarEl.empty();
    this.statusBarEl.hide();
    this.requestSettingsRender();
  }

  private async refreshOwnerRoomInvites(logActivity = true): Promise<void> {
    const ownerRooms = this.roomList.filter((room) => room.membershipRole === "owner");
    for (const room of ownerRooms) {
      try {
        await this.refreshRoomInvite(room.workspace.id, false, logActivity);
      } catch (error) {
        this.handleError(`Invite auto-refresh failed (${room.workspace.id})`, error, false);
      }
    }
  }

  private async applySettingsUserUpdate(user: User | null): Promise<void> {
    if (!user || !this.data.session) {
      return;
    }

    const wasAdmin = Boolean(this.data.session.user?.isAdmin);
    this.data.session = {
      ...this.data.session,
      user
    };
    this.resetProfileDraft();

    if (wasAdmin && !user.isAdmin) {
      this.clearAdminState();
    } else if (!wasAdmin && user.isAdmin) {
      try {
        await this.refreshManagedUsers(false, false);
        await this.refreshAdminRooms(false, false);
        if (this.adminSelectedRoomId) {
          await this.refreshAdminRoomMembers(false, this.adminSelectedRoomId, false);
        }
      } catch (error) {
        this.handleError("Admin state bootstrap failed", error, false);
      }
    }

    await this.persistNow();
    this.updateStatusBar();
  }

  private async applySettingsRoomUpsert(scope: string, payload: unknown): Promise<void> {
    if (scope === "admin.rooms") {
      const room = extractAdminRoomFromSettingsPayload(payload);
      if (!room) {
        return;
      }

      this.upsertAdminRoom(room);
      this.updateStatusBar();
      return;
    }

    const room = extractRoomFromSettingsPayload(payload);
    if (!room) {
      return;
    }

    this.upsertUserRoom(room);
    this.updateStatusBar();
  }

  private async applySettingsRoomDelete(scope: string, payload: unknown): Promise<void> {
    const workspaceId = extractWorkspaceIdFromSettingsPayload(payload);
    if (!workspaceId) {
      return;
    }

    if (scope === "admin.rooms") {
      this.removeAdminRoom(workspaceId);
      this.updateStatusBar();
      return;
    }

    await this.removeUserRoom(workspaceId, "settings-stream");
    this.updateStatusBar();
  }

  private async applySettingsRoomMembershipChanged(payload: unknown): Promise<void> {
    const membership = extractRoomMembershipChangedPayload(payload);
    if (!membership) {
      return;
    }

    if (membership.room) {
      this.upsertUserRoom(membership.room);
      this.updateStatusBar();
      return;
    }

    if (membership.workspaceId && membership.removed !== false) {
      await this.removeUserRoom(membership.workspaceId, "settings-membership");
      this.updateStatusBar();
      return;
    }

    if (membership.workspaceId) {
      await this.loadSettingsPanelSnapshot();
    }
  }

  private applySettingsInviteUpdate(invite: InviteState | null): void {
    if (!invite) {
      return;
    }

    this.roomInvites.set(invite.workspaceId, invite);
    this.patchInviteEnabled(invite.workspaceId, invite.enabled);
    this.updateStatusBar();
  }

  private applySettingsRoomPublicationUpdate(
    update: SettingsRoomPublicationUpdatedPayload | null
  ): void {
    if (!update) {
      return;
    }

    this.patchRoomPublication(
      update.workspaceId,
      normalizeRoomPublicationState(update.publication, update.workspaceId)
    );
    this.updateStatusBar();
  }

  private applySettingsManagedUserUpsert(user: ManagedUser | null): void {
    if (!user) {
      return;
    }

    const nextUsers = this.managedUsers.filter((entry) => entry.id !== user.id);
    nextUsers.push(user);
    nextUsers.sort((left, right) => left.username.localeCompare(right.username));
    this.managedUsers = nextUsers;
    this.updateStatusBar();
  }

  private applySettingsManagedUserDelete(userId: string | null): void {
    if (!userId) {
      return;
    }

    this.managedUsers = this.managedUsers.filter((user) => user.id !== userId);
    if (this.adminRoomMembers.some((member) => member.user.id === userId)) {
      this.adminRoomMembers = this.adminRoomMembers.filter((member) => member.user.id !== userId);
    }
    this.updateStatusBar();
  }

  private applySettingsAdminRoomMembersUpdate(
    update: { workspaceId: string; members: RoomMember[] } | null
  ): void {
    if (!update) {
      return;
    }

    if (this.adminSelectedRoomId === update.workspaceId) {
      this.adminRoomMembers = [...update.members].sort(compareRoomMembers);
    }

    const ownerCount = update.members.filter((member) => member.role === "owner").length;
    const memberCount = update.members.length;
    this.adminRoomList = this.adminRoomList.map((room) => {
      if (room.workspace.id !== update.workspaceId) {
        return room;
      }

      return {
        ...room,
        ownerCount,
        memberCount
      };
    }).sort(compareRoomsByName);
    this.roomList = this.roomList.map((room) => {
      if (room.workspace.id !== update.workspaceId) {
        return room;
      }

      return {
        ...room,
        memberCount
      };
    }).sort(compareRoomsByName);
    this.updateStatusBar();
  }

  private upsertUserRoom(room: RoomListItem): void {
    const nextRooms = this.roomList.filter((entry) => entry.workspace.id !== room.workspace.id);
    nextRooms.push(room);
    nextRooms.sort(compareRoomsByName);
    this.roomList = nextRooms;
    this.reconcileInviteCache();
    if (room.membershipRole === "owner" && !this.roomInvites.has(room.workspace.id)) {
      void this.refreshRoomInvite(room.workspace.id, false, false)
        .then(() => {
          this.requestSettingsRender();
        })
        .catch((error) => {
          this.handleError(`Invite bootstrap failed (${room.workspace.id})`, error, false);
        });
    }
  }

  private upsertAdminRoom(room: AdminRoomListItem): void {
    const nextRooms = this.adminRoomList.filter((entry) => entry.workspace.id !== room.workspace.id);
    nextRooms.push(room);
    nextRooms.sort(compareRoomsByName);
    this.adminRoomList = nextRooms;
    this.reconcileAdminSelectedRoom();
  }

  private async removeUserRoom(workspaceId: string, reason: string): Promise<void> {
    const hadRoom = this.roomList.some((room) => room.workspace.id === workspaceId);
    this.roomList = this.roomList.filter((room) => room.workspace.id !== workspaceId);
    this.roomInvites.delete(workspaceId);
    if (hadRoom && this.getStoredRoomBinding(workspaceId)?.downloaded) {
      await this.deactivateRoomDownload(workspaceId, false);
      this.recordLog("rooms", `Detached room ${workspaceId} after settings ${reason}.`);
    }
    this.reconcileInviteCache();
  }

  private removeAdminRoom(workspaceId: string): void {
    this.adminRoomList = this.adminRoomList.filter((room) => room.workspace.id !== workspaceId);
    if (this.adminSelectedRoomId === workspaceId) {
      this.adminSelectedRoomId = "";
      this.adminRoomMembers = [];
      this.clearAdminRoomMemberDraft();
    }
    this.reconcileAdminSelectedRoom();
  }

  private reconcileAdminSelectedRoom(): void {
    if (!this.adminSelectedRoomId && this.adminRoomList.length === 1) {
      this.adminSelectedRoomId = this.adminRoomList[0].workspace.id;
      return;
    }

    if (
      this.adminSelectedRoomId &&
      !this.adminRoomList.some((room) => room.workspace.id === this.adminSelectedRoomId)
    ) {
      this.adminSelectedRoomId = "";
      this.adminRoomMembers = [];
      this.clearAdminRoomMemberDraft();
    }
  }

  private async applySessionUser(user: User): Promise<void> {
    if (!this.data.session) {
      this.recordLog(
        "auth",
        `Ignored session user update for ${user.username} because no authenticated session with tokens is available.`,
        "error"
      );
      return;
    }

    this.data.session = {
      ...this.data.session,
      user
    };

    this.resetProfileDraft();
    await this.persistNow();
    this.updateStatusBar();
  }

  private updateRoomSyncCursor(workspaceId: string, cursor: number): void {
    const current = getRoomSyncState(this.data.sync, workspaceId);
    this.setRoomSyncState(workspaceId, {
      ...current,
      lastCursor: cursor
    });
  }

  private setRoomSyncState(
    workspaceId: string,
    nextState: { lastCursor: number | null; lastSnapshotAt: string | null }
  ): void {
    this.data.sync.rooms = {
      ...this.data.sync.rooms,
      [workspaceId]: nextState
    };
  }

  private resetProfileDraft(): void {
    this.profileDraftDisplayName = this.data.session?.user?.displayName ?? "";
  }

  private clearRoomDrafts(): void {
    this.clearCreateRoomDraft();
    this.clearJoinRoomDraft();
  }

  private clearCreateRoomDraft(): void {
    this.createRoomDraft = {
      name: ""
    };
  }

  private clearJoinRoomDraft(): void {
    this.joinRoomDraft = {
      code: ""
    };
  }

  private clearPasswordChangeDraft(): void {
    this.passwordChangeDraft = {
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    };
  }

  private clearManagedUserDraft(): void {
    this.managedUserDraft = {
      username: "",
      password: "",
      displayName: "",
      globalRole: "reader"
    };
  }

  private clearAdminRoomMemberDraft(): void {
    this.adminRoomMemberDraft = {
      username: "",
      role: "member"
    };
  }

  private clearAdminState(): void {
    this.adminRoomList = [];
    this.managedUsers = [];
    this.adminSelectedRoomId = "";
    this.adminRoomMembers = [];
    this.clearAdminRoomMemberDraft();
  }

  private getPasswordChangeErrorMessage(error: unknown): string | null {
    if (!(error instanceof RolayApiError)) {
      return null;
    }

    if (error.code === "password_unchanged") {
      return "New password must be different from the current password.";
    }

    const normalizedCode = error.code.toLowerCase();
    if (normalizedCode.includes("current") && normalizedCode.includes("password")) {
      return "Current password is incorrect.";
    }

    const normalizedMessage = error.message.toLowerCase();
    if (
      normalizedMessage.includes("current password") &&
      (normalizedMessage.includes("invalid") || normalizedMessage.includes("incorrect") || normalizedMessage.includes("wrong"))
    ) {
      return "Current password is incorrect.";
    }

    if (
      normalizedMessage.includes("password unchanged") ||
      normalizedMessage.includes("same as") ||
      normalizedMessage.includes("must be different")
    ) {
      return "New password must be different from the current password.";
    }

    return null;
  }

  private getPendingMarkdownCreatesForWorkspace(workspaceId: string): RolayPendingMarkdownCreateEntry[] {
    return Object.values(this.data.pendingMarkdownCreates)
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private getPendingMarkdownMergesForWorkspace(workspaceId: string): RolayPendingMarkdownMergeEntry[] {
    return Object.values(this.data.pendingMarkdownMerges)
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private getPendingBinaryWritesForWorkspace(workspaceId: string): RolayPendingBinaryWriteEntry[] {
    return Object.values(this.data.pendingBinaryWrites)
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private handlePendingMarkdownCreateRename(oldPath: string, newPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const pendingCreate = this.data.pendingMarkdownCreates[normalizedOldPath];
    if (!pendingCreate) {
      return;
    }

    delete this.data.pendingMarkdownCreates[normalizedOldPath];
    const nextServerPath = this.resolvePendingMarkdownServerPath(
      pendingCreate.workspaceId,
      normalizedNewPath,
      pendingCreate.serverPath
    );

    if (!nextServerPath) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
      this.recordLog(
        "ops",
        `[${pendingCreate.workspaceId}] Cleared pending markdown create for ${normalizedOldPath} because it moved outside the downloaded room.`
      );
      return;
    }

    this.data.pendingMarkdownCreates[normalizedNewPath] = {
      ...pendingCreate,
      localPath: normalizedNewPath,
      serverPath: nextServerPath
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private handlePendingMarkdownMergeRename(oldPath: string, newPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);

    let changed = false;
    for (const [entryId, pendingMerge] of Object.entries(this.data.pendingMarkdownMerges)) {
      if (pendingMerge.localPath !== normalizedOldPath) {
        continue;
      }

      const nextFilePath = this.resolvePendingMarkdownServerPath(
        pendingMerge.workspaceId,
        normalizedNewPath,
        pendingMerge.filePath
      );
      if (!nextFilePath) {
        delete this.data.pendingMarkdownMerges[entryId];
        changed = true;
        this.recordLog(
          "crdt",
          `[${pendingMerge.workspaceId}] Cleared pending markdown merge for ${normalizedOldPath} because it moved outside the downloaded room.`
        );
        continue;
      }

      this.data.pendingMarkdownMerges[entryId] = {
        ...pendingMerge,
        localPath: normalizedNewPath,
        filePath: nextFilePath
      };
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
    }
  }

  private async handlePendingBinaryWriteRename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const pendingWrite = this.data.pendingBinaryWrites[normalizedOldPath];
    if (!pendingWrite) {
      return;
    }

    delete this.data.pendingBinaryWrites[normalizedOldPath];
    this.moveBinarySyncToken(normalizedOldPath, normalizedNewPath);
    this.movePersistedBinaryTransferState(normalizedOldPath, normalizedNewPath);
    await this.cancelBinaryTransferForLocalPath(normalizedOldPath, "rename");

    const nextServerPath = this.resolvePendingMarkdownServerPath(
      pendingWrite.workspaceId,
      normalizedNewPath,
      pendingWrite.serverPath
    );

    if (!nextServerPath) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
      this.recordLog(
        "blob",
        `[${pendingWrite.workspaceId}] Cleared pending binary write for ${normalizedOldPath} because it moved outside the downloaded room.`
      );
      return;
    }

    this.data.pendingBinaryWrites[normalizedNewPath] = {
      ...pendingWrite,
      localPath: normalizedNewPath,
      serverPath: nextServerPath
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();

    const currentFile = this.app.vault.getAbstractFileByPath(normalizedNewPath);
    const entry = pendingWrite.entryId
      ? this.getRoomStore(pendingWrite.workspaceId)?.getEntryById(pendingWrite.entryId) ?? null
      : this.getRoomStore(pendingWrite.workspaceId)?.getEntryByPath(nextServerPath) ?? null;

    if (currentFile instanceof TFile && isBinaryPath(currentFile.path)) {
      await this.queueBinaryWrite(
        pendingWrite.workspaceId,
        nextServerPath,
        await this.app.vault.readBinary(currentFile),
        entry
      );
    }
  }

  private clearPendingMarkdownCreate(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    if (!(normalizedLocalPath in this.data.pendingMarkdownCreates)) {
      return;
    }

    delete this.data.pendingMarkdownCreates[normalizedLocalPath];
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private clearPendingBinaryWriteRecord(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    if (!(normalizedLocalPath in this.data.pendingBinaryWrites)) {
      return;
    }

    delete this.data.pendingBinaryWrites[normalizedLocalPath];
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private async clearPendingBinaryWriteForLocalPath(localPath: string, cancelTransfer: boolean): Promise<void> {
    const normalizedLocalPath = normalizePath(localPath);
    if (!(normalizedLocalPath in this.data.pendingBinaryWrites)) {
      if (cancelTransfer) {
        this.invalidateBinarySyncToken(normalizedLocalPath);
        await this.cancelBinaryTransferForLocalPath(normalizedLocalPath, "clear");
      }
      return;
    }

    if (cancelTransfer) {
      this.invalidateBinarySyncToken(normalizedLocalPath);
      await this.cancelBinaryTransferForLocalPath(normalizedLocalPath, "clear");
    }

    delete this.data.pendingBinaryWrites[normalizedLocalPath];
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private clearPendingMarkdownMergesForLocalPath(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    let changed = false;
    for (const [entryId, pendingMerge] of Object.entries(this.data.pendingMarkdownMerges)) {
      if (pendingMerge.localPath !== normalizedLocalPath) {
        continue;
      }

      delete this.data.pendingMarkdownMerges[entryId];
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
    }
  }

  private clearPendingMarkdownCreatesForWorkspace(workspaceId: string): void {
    let changed = false;
    for (const [localPath, pendingCreate] of Object.entries(this.data.pendingMarkdownCreates)) {
      if (pendingCreate.workspaceId !== workspaceId) {
        continue;
      }

      delete this.data.pendingMarkdownCreates[localPath];
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
    }
  }

  private async clearPendingBinaryWritesForWorkspace(workspaceId: string): Promise<void> {
    let changed = false;
    for (const [localPath, pendingWrite] of Object.entries(this.data.pendingBinaryWrites)) {
      if (pendingWrite.workspaceId !== workspaceId) {
        continue;
      }

      this.invalidateBinarySyncToken(localPath);
      await this.cancelBinaryTransferForLocalPath(localPath, "workspace-clear");
      delete this.data.pendingBinaryWrites[localPath];
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
    }
  }

  private clearPendingMarkdownMergesForWorkspace(workspaceId: string): void {
    let changed = false;
    for (const [entryId, pendingMerge] of Object.entries(this.data.pendingMarkdownMerges)) {
      if (pendingMerge.workspaceId !== workspaceId) {
        continue;
      }

      delete this.data.pendingMarkdownMerges[entryId];
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
      this.scheduleExplorerLoadingDecorations();
    }
  }

  private async rememberPendingMarkdownCreate(
    workspaceId: string,
    localPath: string,
    serverPath: string,
    error: unknown
  ): Promise<void> {
    const normalizedLocalPath = normalizePath(localPath);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = this.data.pendingMarkdownCreates[normalizedLocalPath];
    this.data.pendingMarkdownCreates[normalizedLocalPath] = {
      workspaceId,
      localPath: normalizedLocalPath,
      serverPath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: errorMessage
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();

    this.recordLog(
      "ops",
      `[${workspaceId}] Keeping local markdown create for ${serverPath} pending until the next successful room refresh/connect: ${errorMessage}`,
      "error"
    );
  }

  private rememberPendingMarkdownMerge(
    workspaceId: string,
    entryId: string,
    localPath: string,
    filePath: string,
    error: unknown = null
  ): void {
    const normalizedLocalPath = normalizePath(localPath);
    const existing = this.data.pendingMarkdownMerges[entryId];
    this.data.pendingMarkdownMerges[entryId] = {
      workspaceId,
      entryId,
      localPath: normalizedLocalPath,
      filePath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: error ? (error instanceof Error ? error.message : String(error)) : null
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private rememberPendingBinaryWrite(
    workspaceId: string,
    localPath: string,
    serverPath: string,
    entryId: string | null,
    error: unknown = null
  ): void {
    const normalizedLocalPath = normalizePath(localPath);
    const existing = this.data.pendingBinaryWrites[normalizedLocalPath];
    this.data.pendingBinaryWrites[normalizedLocalPath] = {
      workspaceId,
      localPath: normalizedLocalPath,
      serverPath,
      entryId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: error ? (error instanceof Error ? error.message : String(error)) : null
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private updatePendingBinaryWriteEntryId(localPath: string, entryId: string | null, serverPath?: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    const existing = this.data.pendingBinaryWrites[normalizedLocalPath];
    if (!existing) {
      return;
    }

    this.data.pendingBinaryWrites[normalizedLocalPath] = {
      ...existing,
      entryId,
      serverPath: serverPath ?? existing.serverPath,
      lastAttemptAt: new Date().toISOString()
    };
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private clearPendingMarkdownMerge(entryId: string): void {
    if (!(entryId in this.data.pendingMarkdownMerges)) {
      return;
    }

    delete this.data.pendingMarkdownMerges[entryId];
    this.schedulePersist();
    this.scheduleExplorerLoadingDecorations();
  }

  private shouldDropPendingMarkdownCreateAsRemoteEcho(
    workspaceId: string,
    pendingCreate: RolayPendingMarkdownCreateEntry,
    remoteEntry: FileEntry
  ): boolean {
    if (remoteEntry.deleted || remoteEntry.kind !== "markdown") {
      return false;
    }

    const normalizedLocalPath = normalizePath(pendingCreate.localPath);
    if (this.wasPathRecentlyObservedAsRemote(workspaceId, normalizedLocalPath)) {
      return true;
    }

    const cachedEntry = this.findPersistedCrdtCacheEntry(remoteEntry.id);
    if (cachedEntry && normalizePath(cachedEntry.filePath) === normalizedLocalPath) {
      return true;
    }

    const pendingMerge = this.data.pendingMarkdownMerges[remoteEntry.id];
    if (pendingMerge && normalizePath(pendingMerge.localPath) === normalizedLocalPath) {
      return true;
    }

    return false;
  }

  private shouldDropPendingBinaryWriteAsRemoteEcho(
    workspaceId: string,
    pendingWrite: RolayPendingBinaryWriteEntry,
    remoteEntry: FileEntry
  ): boolean {
    if (remoteEntry.deleted || remoteEntry.kind !== "binary") {
      return false;
    }

    const normalizedLocalPath = normalizePath(pendingWrite.localPath);
    if (this.wasPathRecentlyObservedAsRemote(workspaceId, normalizedLocalPath)) {
      return true;
    }

    const cachedEntry = this.findPersistedBinaryCacheEntry(remoteEntry.id);
    if (cachedEntry && normalizePath(cachedEntry.filePath) === normalizedLocalPath) {
      return true;
    }

    if (
      !pendingWrite.entryId &&
      !remoteEntry.blob &&
      normalizePath(pendingWrite.serverPath) === normalizePath(remoteEntry.path)
    ) {
      return true;
    }

    return false;
  }

  private resolvePendingMarkdownServerPath(
    workspaceId: string,
    localPath: string,
    fallbackServerPath: string
  ): string | null {
    const folderName = this.getDownloadedFolderName(workspaceId);
    if (!folderName) {
      return fallbackServerPath;
    }

    return toServerPathForRoom(localPath, this.data.settings.syncRoot, folderName) ?? null;
  }

  private resolveEntryByLocalPath(localPath: string): FileEntry | null {
    const downloadedRooms = this.getDownloadedRooms().sort((left, right) => right.folderName.length - left.folderName.length);

    for (const room of downloadedRooms) {
      const serverPath = toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName);
      if (serverPath === null) {
        continue;
      }

      const entry = this.getRoomStore(room.workspaceId)?.getEntryByPath(serverPath) ?? null;
      if (entry) {
        return entry;
      }
    }

    return null;
  }

  private hasPersistedCrdtCache(entryId: string): boolean {
    return Boolean(this.findPersistedCrdtCacheEntry(entryId));
  }

  private findPersistedCrdtCacheEntry(entryId: string): RolayCrdtCacheEntry | null {
    const cacheKey = this.getCrdtCacheKey(entryId);
    return this.data.crdtCache.entries[cacheKey] ?? this.data.crdtCache.entries[entryId] ?? null;
  }

  private getPersistedCrdtState(entryId: string): Uint8Array | null {
    const cacheKey = this.getCrdtCacheKey(entryId);
    const cached = this.findPersistedCrdtCacheEntry(entryId);
    if (!cached) {
      return null;
    }

    try {
      return decodeBase64(cached.encodedState);
    } catch (error) {
      delete this.data.crdtCache.entries[cacheKey];
      delete this.data.crdtCache.entries[entryId];
      this.recordLog(
        "crdt",
        `Dropped invalid persisted CRDT cache for ${entryId}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      this.schedulePersist();
      return null;
    }
  }

  private persistCrdtState(entryId: string, filePath: string, state: Uint8Array): void {
    const cacheKey = this.getCrdtCacheKey(entryId);
    this.data.crdtCache.entries[cacheKey] = {
      encodedState: encodeBase64(state),
      filePath,
      updatedAt: new Date().toISOString()
    };
    delete this.data.crdtCache.entries[entryId];
    this.prunePersistedCrdtCache();
    this.schedulePersist();
  }

  private prunePersistedCrdtCache(): void {
    const entries = Object.entries(this.data.crdtCache.entries);
    if (entries.length <= RolayPlugin.MAX_PERSISTED_CRDT_DOCS) {
      return;
    }

    const sortedEntries = entries
      .map(([entryId, entry]) => ({ entryId, entry }))
      .sort((left, right) => compareCrdtCacheEntries(left.entry, right.entry));

    for (const staleEntry of sortedEntries.slice(0, entries.length - RolayPlugin.MAX_PERSISTED_CRDT_DOCS)) {
      delete this.data.crdtCache.entries[staleEntry.entryId];
    }
  }

  private async hydrateMarkdownFileFromState(
    workspaceId: string,
    entry: FileEntry,
    localPath: string,
    nextState: Uint8Array,
    previousState: Uint8Array | null
  ): Promise<boolean> {
    const localFile = this.app.vault.getAbstractFileByPath(localPath);
    if (!(localFile instanceof TFile) || localFile.extension !== "md") {
      return false;
    }

    if (this.hasPendingLocalCreate(workspaceId, entry.path)) {
      this.recordLog("crdt", `[${workspaceId}] Skipped preload overwrite for ${entry.path} because a local create is still pending.`);
      return false;
    }

    if (this.data.pendingMarkdownCreates[normalizePath(localPath)]) {
      this.recordLog("crdt", `[${workspaceId}] Skipped preload overwrite for ${entry.path} because a local markdown create replay is pending.`);
      return false;
    }

    if (this.data.pendingMarkdownMerges[entry.id]) {
      this.recordLog("crdt", `[${workspaceId}] Skipped preload overwrite for ${entry.path} because a local markdown merge is pending.`);
      return false;
    }

    if (getMarkdownViewsForFile(this.app, localPath).length > 0) {
      return false;
    }

    const nextText = decodeMarkdownTextState(nextState);
    const currentText = await this.app.vault.cachedRead(localFile);
    if (currentText === nextText) {
      return true;
    }

    const previousText = previousState ? decodeMarkdownTextState(previousState) : null;
    const safeToOverwrite =
      currentText.length === 0 ||
      (previousText !== null && currentText === previousText);

    if (!safeToOverwrite) {
      this.recordLog(
        "crdt",
        `[${workspaceId}] Left local markdown ${entry.path} untouched during preload because it diverged from the last known cached content.`
      );
      return false;
    }

    await this.app.vault.modify(localFile, nextText);
    return true;
  }

  private async refreshClosedRoomMarkdownContent(workspaceId: string, reason: string): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    const targets = runtime.treeStore
      .getEntries()
      .filter((entry) => !entry.deleted && entry.kind === "markdown")
      .map((entry) => ({
        entry,
        localPath: this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path
      }))
      .filter(({ localPath }) => {
        const localFile = this.app.vault.getAbstractFileByPath(localPath);
        return (
          localFile instanceof TFile &&
          localFile.extension === "md" &&
          getMarkdownViewsForFile(this.app, localPath).length === 0
        );
      });

    await this.fetchMarkdownTargetsFromBootstrap(workspaceId, targets, reason, true);
  }

  private async refreshMarkdownContentBeforeRoomExit(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    const room = this.resolveDownloadedRoomByLocalPath(oldPath);
    if (!room) {
      return;
    }

    if (this.resolveDownloadedRoomByLocalPath(file.path)?.workspaceId === room.workspaceId) {
      return;
    }

    const oldServerPath = toServerPathForRoom(oldPath, this.data.settings.syncRoot, room.folderName);
    if (!oldServerPath) {
      return;
    }

    const roomStore = this.getRoomStore(room.workspaceId);
    if (!roomStore) {
      return;
    }

    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(file.path);
    const targets = roomStore
      .getEntries()
      .filter(
        (entry) =>
          !entry.deleted &&
          entry.kind === "markdown" &&
          (entry.path === oldServerPath || entry.path.startsWith(`${oldServerPath}/`))
      )
      .map((entry) => {
        const oldLocalPath = normalizePath(this.fileBridge.toLocalPath(room.workspaceId, entry.path) ?? entry.path);
        if (oldLocalPath !== normalizedOldPath && !oldLocalPath.startsWith(`${normalizedOldPath}/`)) {
          return null;
        }

        const relativeSuffix = oldLocalPath.slice(normalizedOldPath.length);
        return {
          entry,
          localPath: `${normalizedNewPath}${relativeSuffix}`
        };
      })
      .filter((target): target is { entry: FileEntry; localPath: string } => target !== null);

    if (targets.length === 0) {
      return;
    }

    await this.fetchMarkdownTargetsFromBootstrap(
      room.workspaceId,
      targets,
      "room-exit-content-sync",
      false
    );
  }

  private async fetchMarkdownTargetsFromBootstrap(
    workspaceId: string,
    targets: Array<{ entry: FileEntry; localPath: string }>,
    reason: string,
    updateLocks: boolean
  ): Promise<void> {
    if (targets.length === 0 || !this.isRoomSyncActive(workspaceId)) {
      return;
    }

    const targetsByEntryId = new Map(
      targets.map((target) => [target.entry.id, target] as const)
    );
    const metadataResponse = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
      entryIds: [...targetsByEntryId.keys()],
      includeState: false
    });
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    if (metadataResponse.encoding !== "base64") {
      throw new Error(`Unsupported markdown bootstrap encoding: ${metadataResponse.encoding}`);
    }

    const metadataByEntryId = new Map(
      metadataResponse.documents.map((document) => [document.entryId, document])
    );
    const knownEntries = targets
      .map((target) => target.entry)
      .filter((entry) => metadataByEntryId.has(entry.id));
    if (knownEntries.length === 0) {
      return;
    }

    const batches = this.buildMarkdownBootstrapBatches(knownEntries, metadataByEntryId);
    let hydratedTargets = 0;
    let changedStates = 0;

    for (const batch of batches) {
      const response = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
        entryIds: batch.map((entry) => entry.id),
        includeState: true
      });
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      if (response.encoding !== "base64") {
        throw new Error(`Unsupported markdown bootstrap encoding: ${response.encoding}`);
      }

      if (!response.includesState) {
        throw new Error("Markdown bootstrap batch omitted state payloads.");
      }

      const responseByEntryId = new Map(
        response.documents.map((document) => [document.entryId, document])
      );

      for (const entry of batch) {
        if (!this.isRoomSyncActive(workspaceId)) {
          return;
        }

        const target = targetsByEntryId.get(entry.id);
        const document = responseByEntryId.get(entry.id);
        if (!target || !document?.state) {
          continue;
        }

        const previousState = this.getPersistedCrdtState(entry.id);
        const normalizedState = normalizeBootstrapState(document.state);
        if (this.persistCrdtStateIfChanged(entry.id, target.localPath, normalizedState)) {
          changedStates += 1;
        }

        if (
          await this.hydrateMarkdownFileFromState(
            workspaceId,
            entry,
            target.localPath,
            normalizedState,
            previousState
          )
        ) {
          hydratedTargets += 1;
        }

        if (updateLocks && this.isLocalPathInDownloadedRoom(target.localPath, workspaceId)) {
          await this.syncMarkdownLockForEntry(workspaceId, entry, target.localPath, normalizedState);
        }
      }
    }

    if (changedStates > 0 || hydratedTargets > 0) {
      this.recordLog(
        "crdt",
        `[${workspaceId}] Refreshed ${hydratedTargets}/${targets.length} closed markdown document(s) via HTTP bootstrap (${reason}, ${changedStates} state update(s)).`
      );
    }
  }

  private persistCrdtStateIfChanged(entryId: string, filePath: string, state: Uint8Array): boolean {
    const existing = this.findPersistedCrdtCacheEntry(entryId);
    if (
      existing &&
      normalizePath(existing.filePath) === normalizePath(filePath) &&
      areUint8ArraysEqual(decodeBase64(existing.encodedState), state)
    ) {
      return false;
    }

    this.persistCrdtState(entryId, filePath, state);
    return true;
  }

  private getCrdtCacheKey(entryId: string): string {
    const normalizedServerUrl = normalizeServerUrl(this.data.settings.serverUrl);
    return normalizedServerUrl ? `${normalizedServerUrl}::${entryId}` : entryId;
  }

  private findPersistedBinaryCacheEntry(entryId: string): RolayBinaryCacheEntry | null {
    const cacheKey = this.getBinaryCacheKey(entryId);
    return this.data.binaryCache.entries[cacheKey] ?? this.data.binaryCache.entries[entryId] ?? null;
  }

  private persistBinaryCacheEntry(
    entryId: string,
    filePath: string,
    hash: string,
    sizeBytes: number,
    mimeType: string
  ): void {
    const normalizedHash = normalizeSha256Hash(hash);
    if (!normalizedHash) {
      return;
    }

    const cacheKey = this.getBinaryCacheKey(entryId);
    this.data.binaryCache.entries[cacheKey] = {
      hash: normalizedHash,
      sizeBytes,
      mimeType,
      filePath,
      updatedAt: new Date().toISOString()
    };
    delete this.data.binaryCache.entries[entryId];
    this.prunePersistedBinaryCache();
    this.schedulePersist();
  }

  private clearPersistedBinaryCacheEntry(entryId: string): void {
    const cacheKey = this.getBinaryCacheKey(entryId);
    if (!(cacheKey in this.data.binaryCache.entries) && !(entryId in this.data.binaryCache.entries)) {
      return;
    }

    delete this.data.binaryCache.entries[cacheKey];
    delete this.data.binaryCache.entries[entryId];
    this.schedulePersist();
  }

  private prunePersistedBinaryCache(): void {
    const entries = Object.entries(this.data.binaryCache.entries).map(([entryId, entry]) => ({
      entryId,
      entry
    }));
    if (entries.length <= RolayPlugin.MAX_PERSISTED_BINARY_ENTRIES) {
      return;
    }

    const sortedEntries = [...entries].sort((left, right) => left.entry.updatedAt.localeCompare(right.entry.updatedAt));
    for (const staleEntry of sortedEntries.slice(0, entries.length - RolayPlugin.MAX_PERSISTED_BINARY_ENTRIES)) {
      delete this.data.binaryCache.entries[staleEntry.entryId];
    }
  }

  private getBinaryCacheKey(entryId: string): string {
    const normalizedServerUrl = normalizeServerUrl(this.data.settings.serverUrl);
    return normalizedServerUrl ? `${normalizedServerUrl}::${entryId}` : entryId;
  }

  private formatRoomCrdtCacheLabel(
    bootstrap: RoomMarkdownBootstrapState | undefined,
    markdownEntryCount: number,
    cachedMarkdownCount: number
  ): string {
    if (markdownEntryCount === 0) {
      return "no markdown files yet";
    }

    if (!bootstrap || bootstrap.status === "idle") {
      if (bootstrap?.lockedLocalPaths.size) {
        return `${cachedMarkdownCount}/${markdownEntryCount} loaded (${bootstrap.lockedLocalPaths.size} still protected)`;
      }

      return `${cachedMarkdownCount}/${markdownEntryCount} loaded`;
    }

    if (bootstrap.status === "loading") {
      if (bootstrap.totalBytes <= 0) {
        return `measuring size (${bootstrap.completedTargets}/${Math.max(bootstrap.totalTargets, markdownEntryCount)} files, ${bootstrap.hydratedTargets} written locally)`;
      }

      const completedBytes = Math.min(bootstrap.completedBytes, bootstrap.totalBytes);
      const percent = Math.round((completedBytes / bootstrap.totalBytes) * 100);
      return `${percent}% loaded (${formatByteCount(completedBytes)}/${formatByteCount(bootstrap.totalBytes)}, ${bootstrap.completedTargets}/${bootstrap.totalTargets} files, ${bootstrap.hydratedTargets} written locally)`;
    }

    if (bootstrap.status === "error") {
      if (bootstrap.totalBytes > 0) {
        const completedBytes = Math.min(bootstrap.completedBytes, bootstrap.totalBytes);
        const percent = Math.round((completedBytes / bootstrap.totalBytes) * 100);
        return `partial ${percent}% loaded (${formatByteCount(completedBytes)}/${formatByteCount(bootstrap.totalBytes)}, ${bootstrap.lockedLocalPaths.size} protected, ${bootstrap.lastError ?? "bootstrap error"})`;
      }

      return `partial ${cachedMarkdownCount}/${markdownEntryCount} loaded (${bootstrap.lastError ?? "bootstrap error"})`;
    }

    if (bootstrap.totalBytes > 0) {
      const protectionLabel = bootstrap.lockedLocalPaths.size > 0
        ? `, ${bootstrap.lockedLocalPaths.size} still protected`
        : "";
      return `100% loaded (${formatByteCount(bootstrap.totalBytes)}/${formatByteCount(bootstrap.totalBytes)}, ${cachedMarkdownCount}/${markdownEntryCount} files cached, ${bootstrap.hydratedTargets} written locally${protectionLabel})`;
    }

    return `100% loaded (${cachedMarkdownCount}/${markdownEntryCount} files cached, ${bootstrap.hydratedTargets} written locally)`;
  }

  private cancelRoomMarkdownBootstrap(workspaceId: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    runtime.markdownBootstrap.runToken += 1;
    runtime.markdownBootstrap.rerunRequested = false;
    runtime.markdownBootstrap.status = "idle";
    runtime.markdownBootstrap.totalTargets = 0;
    runtime.markdownBootstrap.completedTargets = 0;
    runtime.markdownBootstrap.totalBytes = 0;
    runtime.markdownBootstrap.completedBytes = 0;
    runtime.markdownBootstrap.documentBytesByEntryId.clear();
    runtime.markdownBootstrap.completedEntryIds.clear();
    runtime.markdownBootstrap.hydratedTargets = 0;
    runtime.markdownBootstrap.lastError = null;
    this.scheduleExplorerLoadingDecorations();
  }

  private async bootstrapRoomMarkdownCache(
    workspaceId: string,
    entries: FileEntry[],
    reason: string,
    lockEntries: FileEntry[] = entries
  ): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    const activeFilePath = this.app.workspace.getActiveFile()?.path ?? null;
    const markdownEntries = entries
      .filter((entry) => !entry.deleted && entry.kind === "markdown")
      .sort((left, right) => {
        const leftLocalPath = this.fileBridge.toLocalPath(workspaceId, left.path) ?? left.path;
        const rightLocalPath = this.fileBridge.toLocalPath(workspaceId, right.path) ?? right.path;
        if (activeFilePath && leftLocalPath === activeFilePath && rightLocalPath !== activeFilePath) {
          return -1;
        }

        if (activeFilePath && rightLocalPath === activeFilePath && leftLocalPath !== activeFilePath) {
          return 1;
        }

        return left.path.localeCompare(right.path);
      });

    if (runtime.markdownBootstrap.status === "loading") {
      runtime.markdownBootstrap.rerunRequested = true;
      return;
    }

    runtime.markdownBootstrap.runToken += 1;
    const runToken = runtime.markdownBootstrap.runToken;
    runtime.markdownBootstrap.rerunRequested = false;
    runtime.markdownBootstrap.totalTargets = markdownEntries.length;
    runtime.markdownBootstrap.completedTargets = 0;
    runtime.markdownBootstrap.totalBytes = 0;
    runtime.markdownBootstrap.completedBytes = 0;
    runtime.markdownBootstrap.documentBytesByEntryId.clear();
    runtime.markdownBootstrap.completedEntryIds.clear();
    runtime.markdownBootstrap.hydratedTargets = 0;
    runtime.markdownBootstrap.lastRunAt = new Date().toISOString();
    runtime.markdownBootstrap.lastError = null;
    runtime.markdownBootstrap.status = markdownEntries.length > 0 ? "loading" : "ready";
    this.updateStatusBar();
    await this.refreshRoomMarkdownLocks(workspaceId, lockEntries);

    if (markdownEntries.length === 0) {
      return;
    }

    this.recordLog(
      "crdt",
      `[${workspaceId}] Preloading ${markdownEntries.length} markdown document(s) via HTTP bootstrap metadata + state batches (${reason}).`
    );

    try {
      const metadataResponse = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
        entryIds: markdownEntries.map((entry) => entry.id),
        includeState: false
      });
      if (runtime.markdownBootstrap.runToken !== runToken) {
        return;
      }

      if (metadataResponse.encoding !== "base64") {
        throw new Error(`Unsupported markdown bootstrap encoding: ${metadataResponse.encoding}`);
      }

      const metadataByEntryId = new Map(
        metadataResponse.documents.map((document) => [document.entryId, document])
      );
      for (const document of metadataResponse.documents) {
        runtime.markdownBootstrap.documentBytesByEntryId.set(
          document.entryId,
          Math.max(0, document.encodedBytes)
        );
      }
      const knownEntries = markdownEntries.filter((entry) => metadataByEntryId.has(entry.id));
      const metadataMissingCount = markdownEntries.length - knownEntries.length;
      runtime.markdownBootstrap.totalTargets = metadataResponse.documentCount > 0
        ? metadataResponse.documentCount
        : metadataResponse.documents.length;
      runtime.markdownBootstrap.totalBytes = metadataResponse.totalEncodedBytes > 0
        ? metadataResponse.totalEncodedBytes
        : metadataResponse.documents.reduce(
            (sum, document) => sum + Math.max(0, document.encodedBytes),
            0
          );
      this.updateStatusBar();

      if (knownEntries.length === 0) {
        runtime.markdownBootstrap.lastError = metadataMissingCount > 0
          ? `server returned metadata for 0/${markdownEntries.length} markdown documents`
          : null;
        runtime.markdownBootstrap.status = metadataMissingCount > 0 ? "error" : "ready";
        await this.refreshRoomMarkdownLocks(workspaceId, lockEntries);
        this.updateStatusBar();
        return;
      }

      const batches = this.buildMarkdownBootstrapBatches(knownEntries, metadataByEntryId);
      let missingEntryCount = metadataMissingCount;
      for (const batch of batches) {
        if (runtime.markdownBootstrap.runToken !== runToken) {
          return;
        }

        const response = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
          entryIds: batch.map((entry) => entry.id),
          includeState: true
        });
        if (runtime.markdownBootstrap.runToken !== runToken) {
          return;
        }

        if (response.encoding !== "base64") {
          throw new Error(`Unsupported markdown bootstrap encoding: ${response.encoding}`);
        }

        if (!response.includesState) {
          throw new Error("Markdown bootstrap batch omitted state payloads.");
        }

        const responseByEntryId = new Map(response.documents.map((document) => [document.entryId, document]));
        for (const entry of batch) {
          if (runtime.markdownBootstrap.runToken !== runToken) {
            return;
          }

          const document = responseByEntryId.get(entry.id);
          const metadataDocument = metadataByEntryId.get(entry.id);
          if (!document?.state || !metadataDocument) {
            missingEntryCount += 1;
            continue;
          }

          const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path;
          const previousState = this.getPersistedCrdtState(entry.id);
          const normalizedState = normalizeBootstrapState(document.state);
          this.persistCrdtState(entry.id, localPath, normalizedState);

          if (await this.hydrateMarkdownFileFromState(workspaceId, entry, localPath, normalizedState, previousState)) {
            runtime.markdownBootstrap.hydratedTargets += 1;
          }

          runtime.markdownBootstrap.completedTargets += 1;
          runtime.markdownBootstrap.completedBytes += Math.max(
            0,
            document.encodedBytes ?? metadataDocument.encodedBytes
          );
          runtime.markdownBootstrap.completedEntryIds.add(entry.id);

          if (activeFilePath && localPath === activeFilePath) {
            await this.bindActiveMarkdownToCrdt();
          }

          await this.syncMarkdownLockForEntry(workspaceId, entry, localPath, normalizedState);
          this.updateStatusBar();
        }
      }

      if (runtime.markdownBootstrap.totalBytes > 0) {
        runtime.markdownBootstrap.completedBytes = Math.min(
          runtime.markdownBootstrap.completedBytes,
          runtime.markdownBootstrap.totalBytes
        );
      }

      runtime.markdownBootstrap.lastError = missingEntryCount > 0
        ? `server returned ${runtime.markdownBootstrap.completedTargets}/${markdownEntries.length} bootstrap document(s)`
        : null;
      runtime.markdownBootstrap.status = missingEntryCount > 0 ? "error" : "ready";
      await this.refreshRoomMarkdownLocks(workspaceId, lockEntries);
      this.updateStatusBar();

      if (missingEntryCount === 0) {
        this.recordLog(
          "crdt",
          `[${workspaceId}] HTTP markdown bootstrap stored ${runtime.markdownBootstrap.completedTargets} markdown document(s) with ${formatByteCount(runtime.markdownBootstrap.completedBytes)} downloaded.`
        );
      } else {
        this.recordLog(
          "crdt",
          `[${workspaceId}] HTTP markdown bootstrap stored ${runtime.markdownBootstrap.completedTargets}/${markdownEntries.length} markdown document(s).`,
          "error"
        );
      }
    } catch (error) {
      if (runtime.markdownBootstrap.runToken !== runToken) {
        return;
      }

      const message = getErrorMessage(error);
      if (isStaleMarkdownBootstrapError(error)) {
        runtime.markdownBootstrap.lastError = null;
        runtime.markdownBootstrap.status = "idle";
        this.recordLog(
          "crdt",
          `[${workspaceId}] HTTP markdown bootstrap saw a stale markdown entry; refreshing snapshot before retry.`
        );
        this.scheduleSnapshotRefresh(workspaceId, "markdown-bootstrap-stale-entry");
        this.updateStatusBar();
        return;
      }

      runtime.markdownBootstrap.lastError = message;
      runtime.markdownBootstrap.status = "error";
      this.recordLog(
        "crdt",
        `[${workspaceId}] HTTP markdown bootstrap failed: ${message}`,
        "error"
      );
      this.updateStatusBar();
    }

    if (runtime.markdownBootstrap.rerunRequested) {
      runtime.markdownBootstrap.rerunRequested = false;
      await this.bootstrapRoomMarkdownCache(
        workspaceId,
        runtime.treeStore.getEntries(),
        "rerun",
        runtime.treeStore.getEntries()
      );
    }
  }

  private buildMarkdownBootstrapBatches(
    entries: FileEntry[],
    metadataByEntryId: Map<string, MarkdownBootstrapDocument>
  ): FileEntry[][] {
    const batches: FileEntry[][] = [];
    let currentBatch: FileEntry[] = [];
    let currentBatchBytes = 0;

    for (const entry of entries) {
      const encodedBytes = Math.max(0, metadataByEntryId.get(entry.id)?.encodedBytes ?? 0);
      const wouldOverflowDocs =
        currentBatch.length >= RolayPlugin.MARKDOWN_BOOTSTRAP_BATCH_MAX_DOCS;
      const wouldOverflowBytes =
        currentBatch.length > 0 &&
        currentBatchBytes + encodedBytes > RolayPlugin.MARKDOWN_BOOTSTRAP_BATCH_TARGET_ENCODED_BYTES;

      if (wouldOverflowDocs || wouldOverflowBytes) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchBytes = 0;
      }

      currentBatch.push(entry);
      currentBatchBytes += encodedBytes;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private isLiveSyncEnabledForLocalPath(localPath: string): boolean {
    for (const room of this.getDownloadedRooms()) {
      const serverPath = toServerPathForRoom(localPath, this.data.settings.syncRoot, room.folderName);
      if (serverPath === null) {
        continue;
      }

      return (this.roomRuntime.get(room.workspaceId)?.streamStatus ?? "stopped") !== "stopped";
    }

    return false;
  }

  private async handlePotentialRoomRootRemoval(
    localPath: string,
    reason: "delete" | "missing"
  ): Promise<boolean> {
    const room = this.getDownloadedRooms().find((item) => {
      const roomRoot = getRoomRoot(this.data.settings.syncRoot, item.folderName);
      return roomRoot === localPath;
    });

    if (!room) {
      return false;
    }

    await this.deactivateRoomDownload(room.workspaceId, false);
    this.recordLog(
      "rooms",
      `Detached local room folder for ${room.workspaceId} after ${reason}. Remote room content was left untouched.`
    );
    return true;
  }

  private async reconcileLocalRoomFolders(): Promise<void> {
    for (const room of this.getDownloadedRooms()) {
      const roomRoot = getRoomRoot(this.data.settings.syncRoot, room.folderName);
      if (await this.localPathExists(roomRoot)) {
        continue;
      }

      await this.deactivateRoomDownload(room.workspaceId, false);
      this.recordLog(
        "rooms",
        `Detached room ${room.workspaceId} because the local folder ${roomRoot} is missing. Remote room content was left untouched.`
      );
    }
  }

  private async localPathExists(path: string): Promise<boolean> {
    // On startup Obsidian metadata can lag behind the actual filesystem for a
    // moment, so rely on the adapter as a fallback before concluding that a
    // previously installed room folder is gone.
    if (this.app.vault.getAbstractFileByPath(path)) {
      return true;
    }

    try {
      return await this.app.vault.adapter.exists(normalizePath(path));
    } catch {
      return false;
    }
  }

  private patchInviteEnabled(workspaceId: string, enabled: boolean): void {
    this.roomList = this.roomList.map((room) => {
      if (room.workspace.id !== workspaceId) {
        return room;
      }

      return {
        ...room,
        inviteEnabled: enabled
      };
    });
    this.adminRoomList = this.adminRoomList.map((room) => {
      if (room.workspace.id !== workspaceId) {
        return room;
      }

      return {
        ...room,
        inviteEnabled: enabled
      };
    });
  }

  private patchRoomPublication(workspaceId: string, publication: RoomPublicationState): void {
    this.roomList = this.roomList.map((room) => {
      if (room.workspace.id !== workspaceId) {
        return room;
      }

      return {
        ...room,
        publication: normalizeRoomPublicationState(publication, workspaceId)
      };
    });
    this.adminRoomList = this.adminRoomList.map((room) => {
      if (room.workspace.id !== workspaceId) {
        return room;
      }

      return {
        ...room,
        publication: normalizeRoomPublicationState(publication, workspaceId)
      };
    });
  }

  private async queueCreateFolder(workspaceId: string, path: string): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      this.recordLog("ops", `[${workspaceId}] Ignored local folder create ${path} because the room is disconnected.`);
      return;
    }

    this.registerPendingLocalCreate(workspaceId, path);
    let confirmedServerCreate = false;
    try {
      const response = await this.operationsQueue.enqueue(
        workspaceId,
        {
          type: "create_folder",
          path
        },
        `local folder create ${path}`
      );

      const createdEntry = response.results.find((result) => result.status === "applied")?.entry ?? null;
      if (createdEntry) {
        this.optimisticUpsertRoomEntry(workspaceId, createdEntry);
      }
      confirmedServerCreate = true;
    } finally {
      if (!confirmedServerCreate) {
        this.clearPendingLocalCreate(workspaceId, path);
      }
    }
  }

  private async queueCreateMarkdown(
    workspaceId: string,
    path: string,
    localContent = ""
  ): Promise<void> {
    const localPath = this.fileBridge.toLocalPath(workspaceId, path) ?? path;
    await this.syncMarkdownCreate(workspaceId, path, localPath, localContent, 0);
  }

  private async syncMarkdownCreate(
    workspaceId: string,
    path: string,
    localPath: string,
    localContent = "",
    conflictDepth = 0
  ): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      await this.rememberPendingMarkdownCreate(
        workspaceId,
        localPath,
        path,
        new Error("Room is disconnected; markdown create will retry after reconnect.")
      );
      return;
    }

    this.registerPendingLocalCreate(workspaceId, path);
    let confirmedServerCreate = false;
    try {
      const response = await this.operationsQueue.enqueue(
        workspaceId,
        {
          type: "create_markdown",
          path
        },
        `local markdown create ${path}`
      );
      const appliedEntry = response.results.find((result) => result.status === "applied")?.entry ?? null;
      if (appliedEntry) {
        this.optimisticUpsertRoomEntry(workspaceId, appliedEntry);
      }
      confirmedServerCreate = true;
      this.clearPendingMarkdownCreate(localPath);
      this.recordLog(
        "ops",
        `[${workspaceId}] Markdown entry created for ${path}. Existing local text will be pushed into the remote CRDT doc when possible.`
      );

      let createdEntry = appliedEntry;
      if (!createdEntry) {
        await this.refreshRoomSnapshot(workspaceId, "markdown-create-seed");
        createdEntry = this.getRoomStore(workspaceId)?.getEntryByPath(path) ?? null;
      }

      if (!createdEntry || createdEntry.kind !== "markdown") {
        return;
      }

      const currentLocalContent = await this.readLocalMarkdownContent(localPath, localContent);
      if (!currentLocalContent) {
        return;
      }

      const localMarkdownState = createMarkdownTextState(currentLocalContent);
      this.persistCrdtState(createdEntry.id, localPath, localMarkdownState);
      this.rememberPendingMarkdownMerge(workspaceId, createdEntry.id, localPath, path);

      const activeFile = this.app.workspace.getActiveFile();
      try {
        if (
          activeFile?.path === localPath &&
          this.isLiveSyncEnabledForLocalPath(localPath)
        ) {
          await this.bindActiveMarkdownToCrdt();
          const activeCrdtState = this.crdtManager.getState();
          if (activeCrdtState?.entryId === createdEntry.id) {
            this.scheduleSnapshotRefresh(workspaceId, "markdown-live-import");
            return;
          }
        }

        await this.crdtManager.mergeRemoteMarkdownState(createdEntry, localMarkdownState, path);
        this.clearPendingMarkdownMerge(createdEntry.id);
        this.scheduleSnapshotRefresh(workspaceId, "markdown-seed");
      } catch (error) {
        this.rememberPendingMarkdownMerge(workspaceId, createdEntry.id, localPath, path, error);
        this.handleError(`Remote markdown merge failed for ${path}`, error, false);
      }
    } catch (error) {
      if (
        error instanceof RolayOperationError &&
        error.result.status === "conflict" &&
        error.result.reason === "path_already_exists"
      ) {
        this.clearPendingLocalCreate(workspaceId, path);
        await this.resolveMarkdownCreatePathConflict(
          workspaceId,
          path,
          localPath,
          localContent,
          error.result.suggestedPath,
          conflictDepth
        );
        return;
      }

      await this.rememberPendingMarkdownCreate(workspaceId, localPath, path, error);
      throw error;
    } finally {
      if (!confirmedServerCreate) {
        this.clearPendingLocalCreate(workspaceId, path);
      }
    }
  }

  private async resolveMarkdownCreatePathConflict(
    workspaceId: string,
    originalServerPath: string,
    originalLocalPath: string,
    fallbackLocalContent: string,
    suggestedPath: string | undefined,
    conflictDepth: number
  ): Promise<void> {
    if (conflictDepth >= 8) {
      throw new Error(`Too many markdown rename retries for ${originalServerPath}.`);
    }

    const localFile = this.app.vault.getAbstractFileByPath(originalLocalPath);
    if (!(localFile instanceof TFile) || localFile.extension !== "md") {
      this.clearPendingMarkdownCreate(originalLocalPath);
      this.recordLog(
        "ops",
        `[${workspaceId}] Dropped conflicting local markdown create for ${originalServerPath} because the local file is gone.`,
        "error"
      );
      return;
    }

    const replacementServerPath = this.findAvailableMarkdownConflictPath(
      workspaceId,
      suggestedPath?.trim() || originalServerPath
    );
    const replacementLocalPath = this.fileBridge.toLocalPath(workspaceId, replacementServerPath) ?? replacementServerPath;
    if (replacementLocalPath === originalLocalPath) {
      throw new Error(`No available fallback markdown path for ${originalServerPath}.`);
    }

    await this.fileBridge.runWithSuppressedPaths([originalLocalPath, replacementLocalPath], async () => {
      await this.app.fileManager.renameFile(localFile, replacementLocalPath);
    });

    const conflictMessage =
      `[${workspaceId}] Local markdown ${originalServerPath} conflicted with an existing server path. ` +
      `Renamed local file to ${replacementServerPath} so both copies survive.`;
    this.recordLog("ops", conflictMessage, "error");
    new Notice(`Rolay kept your offline note as ${replacementServerPath}.`);

    const latestLocalContent = await this.readLocalMarkdownContent(replacementLocalPath, fallbackLocalContent);
    await this.rememberPendingMarkdownCreate(
      workspaceId,
      replacementLocalPath,
      replacementServerPath,
      new Error(conflictMessage)
    );
    await this.syncMarkdownCreate(
      workspaceId,
      replacementServerPath,
      replacementLocalPath,
      latestLocalContent,
      conflictDepth + 1
    );
  }

  private async reconcilePendingMarkdownCreates(
    workspaceId: string,
    reason: string
  ): Promise<void> {
    const pendingCreates = this.getPendingMarkdownCreatesForWorkspace(workspaceId);
    if (pendingCreates.length === 0) {
      return;
    }

    this.recordLog(
      "ops",
      `[${workspaceId}] Replaying ${pendingCreates.length} pending local markdown create(s) after ${reason}.`
    );

    for (const pendingCreate of pendingCreates) {
      const currentFile = this.app.vault.getAbstractFileByPath(pendingCreate.localPath);
      if (!(currentFile instanceof TFile) || currentFile.extension !== "md") {
        this.clearPendingMarkdownCreate(pendingCreate.localPath);
        this.recordLog(
          "ops",
          `[${workspaceId}] Cleared pending markdown create for ${pendingCreate.localPath} because the local file no longer exists.`
        );
        continue;
      }

      const currentServerPath = toServerPathForRoom(
        pendingCreate.localPath,
        this.data.settings.syncRoot,
        this.getDownloadedFolderName(workspaceId)
      );
      if (currentServerPath === null) {
        this.clearPendingMarkdownCreate(pendingCreate.localPath);
        this.recordLog(
          "ops",
          `[${workspaceId}] Cleared pending markdown create for ${pendingCreate.localPath} because it is no longer inside the room root.`
        );
        continue;
      }

      const remoteEntry = this.getRoomStore(workspaceId)?.getEntryByPath(currentServerPath) ?? null;
      if (remoteEntry) {
        if (this.shouldDropPendingMarkdownCreateAsRemoteEcho(workspaceId, pendingCreate, remoteEntry)) {
          this.clearPendingMarkdownCreate(pendingCreate.localPath);
          this.clearPendingLocalCreate(workspaceId, currentServerPath);
          this.recordLog(
            "ops",
            `[${workspaceId}] Cleared stale pending markdown create for ${currentServerPath} because that path is already owned by remote entry ${remoteEntry.id}.`
          );
          continue;
        }

        const currentLocalContent = await this.readLocalMarkdownContent(pendingCreate.localPath, "");
        await this.resolveMarkdownCreatePathConflict(
          workspaceId,
          currentServerPath,
          pendingCreate.localPath,
          currentLocalContent,
          undefined,
          0
        );
        continue;
      }

      try {
        const currentLocalContent = await this.readLocalMarkdownContent(pendingCreate.localPath, "");
        await this.syncMarkdownCreate(
          workspaceId,
          currentServerPath,
          pendingCreate.localPath,
          currentLocalContent,
          0
        );
      } catch {
        // Keep the pending create registered for the next room refresh/connect.
      }
    }
  }

  private async reconcilePendingMarkdownMerges(
    workspaceId: string,
    reason: string
  ): Promise<void> {
    const pendingMerges = this.getPendingMarkdownMergesForWorkspace(workspaceId);
    if (pendingMerges.length === 0) {
      return;
    }

    this.recordLog(
      "crdt",
      `[${workspaceId}] Replaying ${pendingMerges.length} pending markdown CRDT merge(s) after ${reason}.`
    );

    for (const pendingMerge of pendingMerges) {
      const currentFile = this.app.vault.getAbstractFileByPath(pendingMerge.localPath);
      if (!(currentFile instanceof TFile) || currentFile.extension !== "md") {
        this.clearPendingMarkdownMerge(pendingMerge.entryId);
        this.recordLog(
          "crdt",
          `[${workspaceId}] Cleared pending markdown merge for ${pendingMerge.localPath} because the local file no longer exists.`
        );
        continue;
      }

      const currentServerPath = this.resolvePendingMarkdownServerPath(
        workspaceId,
        pendingMerge.localPath,
        pendingMerge.filePath
      );
      if (currentServerPath === null) {
        this.clearPendingMarkdownMerge(pendingMerge.entryId);
        this.recordLog(
          "crdt",
          `[${workspaceId}] Cleared pending markdown merge for ${pendingMerge.localPath} because it is no longer inside the room root.`
        );
        continue;
      }

      const entry = this.getRoomStore(workspaceId)?.getEntryById(pendingMerge.entryId) ?? null;
      if (!entry || entry.deleted || entry.kind !== "markdown") {
        this.clearPendingMarkdownMerge(pendingMerge.entryId);
        this.recordLog(
          "crdt",
          `[${workspaceId}] Cleared pending markdown merge for ${pendingMerge.localPath} because the remote markdown entry is no longer available.`,
          "error"
        );
        continue;
      }

      const persistedState = this.getPersistedCrdtState(entry.id);
      if (!persistedState) {
        this.clearPendingMarkdownMerge(entry.id);
        this.recordLog(
          "crdt",
          `[${workspaceId}] Cleared pending markdown merge for ${pendingMerge.localPath} because the local CRDT cache is missing.`,
          "error"
        );
        continue;
      }

      this.rememberPendingMarkdownMerge(workspaceId, entry.id, pendingMerge.localPath, currentServerPath);
      try {
        await this.crdtManager.mergeRemoteMarkdownState(entry, persistedState, currentServerPath);
        this.clearPendingMarkdownMerge(entry.id);
      } catch (error) {
        this.rememberPendingMarkdownMerge(workspaceId, entry.id, pendingMerge.localPath, currentServerPath, error);
      }
    }
  }

  private async queueBinaryWrite(
    workspaceId: string,
    serverPath: string,
    localContent: ArrayBuffer | null,
    existingEntry: FileEntry | null
  ): Promise<void> {
    const localPath = normalizePath(this.fileBridge.toLocalPath(workspaceId, serverPath) ?? serverPath);
    if (!this.isRoomSyncActive(workspaceId)) {
      this.rememberPendingBinaryWrite(
        workspaceId,
        localPath,
        serverPath,
        existingEntry?.id ?? null,
        new Error("Room is disconnected; binary write will retry after reconnect.")
      );
      return;
    }

    if (this.binarySyncTokens.has(localPath)) {
      this.pendingBinarySyncReruns.add(localPath);
      this.rememberPendingBinaryWrite(workspaceId, localPath, serverPath, existingEntry?.id ?? null);
      const existingTransfer = this.binaryTransferState.get(localPath);
      if (existingTransfer?.kind === "upload") {
        this.updateBinaryTransferState(localPath, {
          rerunRequested: true
        });
      }
      return;
    }

    const activeTransfer = this.binaryTransferState.get(localPath);
    if (
      activeTransfer &&
      activeTransfer.kind === "upload" &&
      activeTransfer.status !== "done" &&
      activeTransfer.status !== "failed" &&
      this.binarySyncTokens.has(localPath)
    ) {
      this.updateBinaryTransferState(localPath, {
        rerunRequested: true
      });
      this.rememberPendingBinaryWrite(workspaceId, localPath, serverPath, existingEntry?.id ?? activeTransfer.entryId);
      return;
    }

    this.rememberPendingBinaryWrite(workspaceId, localPath, serverPath, existingEntry?.id ?? null);
    const token = this.createBinarySyncToken(localPath);
    void this.syncBinaryWrite(
      workspaceId,
      localPath,
      serverPath,
      existingEntry?.id ?? null,
      token,
      localContent
    );
  }

  private async syncBinaryWrite(
    workspaceId: string,
    initialLocalPath: string,
    fallbackServerPath: string,
    initialEntryId: string | null,
    token: string,
    initialContent: ArrayBuffer | null
  ): Promise<void> {
    let finalLocalPath = normalizePath(initialLocalPath);
    let finalServerPath = fallbackServerPath;
    let finalEntryId = initialEntryId;
    let createdPlaceholderEntry: FileEntry | null = null;

    try {
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      const currentLocalPath = this.getBinarySyncPathForToken(token);
      if (!currentLocalPath) {
        return;
      }

      finalLocalPath = currentLocalPath;
      const currentFile = this.app.vault.getAbstractFileByPath(currentLocalPath);
      if (!(currentFile instanceof TFile) || !isBinaryPath(currentFile.path)) {
        await this.clearPendingBinaryWriteForLocalPath(currentLocalPath, false);
        return;
      }

      const currentServerPath = this.resolvePendingMarkdownServerPath(
        workspaceId,
        currentLocalPath,
        fallbackServerPath
      );
      if (!currentServerPath) {
        await this.clearPendingBinaryWriteForLocalPath(currentLocalPath, false);
        return;
      }
      finalServerPath = currentServerPath;

      const binaryContent =
        initialContent && normalizePath(initialLocalPath) === currentLocalPath
          ? initialContent
          : await this.readLocalBinaryContent(currentLocalPath);
      const sizeBytes = binaryContent.byteLength;
      const hash = await sha256Hash(binaryContent);
      const mimeType = guessMimeTypeFromPath(currentLocalPath);

      let entry =
        (initialEntryId ? this.getRoomStore(workspaceId)?.getEntryById(initialEntryId) : null) ??
        this.getRoomStore(workspaceId)?.getEntryByPath(currentServerPath) ??
        null;

      // Binary writes are a two-phase flow: ensure the tree entry exists first,
      // then publish the actual bytes through the blob lifecycle.
      if (!entry || entry.deleted || entry.kind !== "binary") {
        this.registerPendingLocalCreate(workspaceId, currentServerPath);
        let confirmedServerCreate = false;

        try {
          const response = await this.operationsQueue.enqueue(
            workspaceId,
            {
              type: "create_binary_placeholder",
              path: currentServerPath,
              sizeBytes,
              mimeType
            },
            `local binary placeholder ${currentServerPath}`
          );
          if (!this.isRoomSyncActive(workspaceId)) {
            return;
          }

          const appliedEntry = response.results.find((result) => result.status === "applied")?.entry ?? null;
          if (appliedEntry) {
            this.optimisticUpsertRoomEntry(workspaceId, appliedEntry);
          }
          confirmedServerCreate = true;
          createdPlaceholderEntry = appliedEntry;
          entry = appliedEntry;
          finalEntryId = appliedEntry?.id ?? finalEntryId;
          this.updatePendingBinaryWriteEntryId(currentLocalPath, appliedEntry?.id ?? null, currentServerPath);
        } catch (error) {
          if (
            error instanceof RolayOperationError &&
            error.result.status === "conflict" &&
            error.result.reason === "path_already_exists"
          ) {
            this.clearPendingLocalCreate(workspaceId, currentServerPath);
            await this.resolveBinaryWritePathConflict(
              workspaceId,
              currentServerPath,
              currentLocalPath,
              error.result.suggestedPath,
              token
            );
            return;
          }

          throw error;
        } finally {
          if (!confirmedServerCreate) {
            this.clearPendingLocalCreate(workspaceId, currentServerPath);
          }
        }

        if (!entry) {
          await this.refreshRoomSnapshot(workspaceId, "binary-placeholder-create");
          if (!this.isRoomSyncActive(workspaceId)) {
            return;
          }

          entry = this.getRoomStore(workspaceId)?.getEntryByPath(currentServerPath) ?? null;
          if (entry && entry.kind === "binary") {
            createdPlaceholderEntry = entry;
            finalEntryId = entry.id;
            this.updatePendingBinaryWriteEntryId(currentLocalPath, entry.id, currentServerPath);
          }
        }
      }

      if (!entry || entry.deleted || entry.kind !== "binary") {
        throw new Error(`Binary entry for ${currentServerPath} is unavailable after placeholder creation.`);
      }

      const desiredLocalPath = this.getBinarySyncPathForToken(token);
      const desiredServerPath = desiredLocalPath
        ? this.resolvePendingMarkdownServerPath(workspaceId, desiredLocalPath, currentServerPath)
        : null;

      if (!desiredLocalPath || !desiredServerPath) {
        if (createdPlaceholderEntry) {
          await this.deleteBinaryPlaceholderIfSafe(workspaceId, createdPlaceholderEntry);
        }
        return;
      }

      finalLocalPath = desiredLocalPath;
      finalServerPath = desiredServerPath;

      if (entry.path !== desiredServerPath) {
        const renameType = getParentPath(entry.path) === getParentPath(desiredServerPath)
          ? "rename_entry"
          : "move_entry";
        await this.queueRenameOrMove(workspaceId, entry, desiredServerPath, renameType);
        entry = this.getRoomStore(workspaceId)?.getEntryById(entry.id) ?? {
          ...entry,
          path: desiredServerPath
        };
      }

      finalEntryId = entry.id;
      this.updatePendingBinaryWriteEntryId(desiredLocalPath, entry.id, desiredServerPath);
      if (!this.isBinarySyncTokenCurrent(desiredLocalPath, token)) {
        return;
      }

      const existingTransfer = this.binaryTransferState.get(desiredLocalPath);
      this.setBinaryTransferState({
        workspaceId,
        entryId: entry.id,
        localPath: desiredLocalPath,
        serverPath: desiredServerPath,
        kind: "upload",
        status: "preparing",
        bytesTotal: sizeBytes,
        bytesDone: 0,
        hash,
        mimeType,
        uploadId: null,
        cancelUrl: null,
        lastError: null,
        rangeSupported: false,
        createdAt: existingTransfer?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rerunRequested: false,
        abortController: null
      });

      this.traceBlob(
        `[${workspaceId}] upload-ticket request entryId=${entry.id} localPath=${desiredLocalPath} serverPath=${desiredServerPath} ` +
        `hash=${hash} sizeBytes=${sizeBytes} mimeType=${mimeType}`
      );
      const ticket = await this.apiClient.createBlobUploadTicket(entry.id, {
        hash,
        sizeBytes,
        mimeType
      });
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      this.traceBlob(
        `[${workspaceId}] upload-ticket response entryId=${entry.id} localPath=${desiredLocalPath} serverPath=${desiredServerPath} ` +
        `status=${ticket._meta.status} requestId=${ticket._meta.requestId ?? "-"} alreadyExists=${ticket.alreadyExists} ` +
        `uploadId=${ticket.uploadId} uploadedBytes=${ticket.uploadedBytes} sizeBytes=${ticket.sizeBytes} hash=${ticket.hash}`
      );
      const normalizedTicketHash = normalizeSha256Hash(ticket.hash);
      if (!normalizedTicketHash) {
        throw new Error(`Blob upload ticket for ${desiredServerPath} is missing a valid hash.`);
      }

      const totalUploadBytes = ticket.sizeBytes > 0 ? ticket.sizeBytes : sizeBytes;
      let commitHash = normalizedTicketHash;
      let uploadedBytes = clampTransferBytes(ticket.uploadedBytes, totalUploadBytes);

      if (!this.maybeUpdateBinaryTransferState(desiredLocalPath, {
        entryId: entry.id,
        bytesTotal: totalUploadBytes,
        bytesDone: uploadedBytes,
        hash: normalizedTicketHash,
        mimeType: ticket.mimeType,
        uploadId: ticket.uploadId,
        cancelUrl: ticket.cancel?.url ?? null
      })) {
        return;
      }

      if (!ticket.alreadyExists) {
        const abortController = new AbortController();
        if (!this.maybeUpdateBinaryTransferState(desiredLocalPath, {
          status: "uploading",
          bytesDone: uploadedBytes,
          abortController
        })) {
          return;
        }

        if (uploadedBytes > 0) {
          this.recordLog(
            "blob",
            `[${workspaceId}] Resuming binary upload for ${desiredServerPath} at ${formatByteCount(uploadedBytes)} of ${formatByteCount(totalUploadBytes)}.`
          );
        }

        let offsetRecoveryAttempts = 0;
        while (uploadedBytes < totalUploadBytes) {
          // Resumable blob upload always sends the remaining tail from the
          // server-confirmed offset. If the server reports an offset mismatch,
          // we realign to expectedOffset instead of restarting from zero.
          const currentOffset = uploadedBytes;
          const nextChunkEnd = Math.min(
            totalUploadBytes,
            currentOffset + RolayPlugin.BINARY_UPLOAD_CHUNK_SIZE
          );
          const uploadChunk = binaryContent.slice(currentOffset, nextChunkEnd);
          const contentRange = `bytes ${currentOffset}-${nextChunkEnd - 1}/${totalUploadBytes}`;
          this.traceBlob(
            `[${workspaceId}] upload content request entryId=${entry.id} uploadId=${ticket.uploadId} localPath=${desiredLocalPath} ` +
            `hash=${commitHash} sizeBytes=${totalUploadBytes} chunkStart=${currentOffset} chunkEnd=${nextChunkEnd - 1} ` +
            `contentRange="${contentRange}"`
          );

          let uploadResponse;
          try {
            uploadResponse = await this.apiClient.uploadBlobContent(
              entry.id,
              ticket.uploadId,
              uploadChunk,
              commitHash,
              currentOffset,
              totalUploadBytes,
              (progress) => {
                this.maybeUpdateBinaryTransferState(desiredLocalPath, {
                  status: "uploading",
                  bytesDone: progress.loadedBytes,
                  bytesTotal: progress.totalBytes > 0 ? progress.totalBytes : totalUploadBytes
                });
              },
              abortController.signal,
              currentOffset === 0 && nextChunkEnd === totalUploadBytes ? ticket.upload : undefined
            );
            if (!this.isRoomSyncActive(workspaceId)) {
              return;
            }
          } catch (error) {
            const expectedOffset = extractBlobOffsetMismatchExpectedOffset(error, totalUploadBytes);
            if (expectedOffset !== null) {
              offsetRecoveryAttempts += 1;
              if (offsetRecoveryAttempts > RolayPlugin.MAX_BINARY_UPLOAD_OFFSET_RECOVERY_ATTEMPTS) {
                throw new Error(
                  `Blob upload offset recovery exceeded ${RolayPlugin.MAX_BINARY_UPLOAD_OFFSET_RECOVERY_ATTEMPTS} attempts.`
                );
              }

              uploadedBytes = expectedOffset;
              this.recordLog(
                "blob",
                `[${workspaceId}] Upload offset mismatch for ${desiredServerPath}; resuming from ${formatByteCount(expectedOffset)}.`,
                "error"
              );
              this.traceBlob(
                `[${workspaceId}] upload content mismatch entryId=${entry.id} uploadId=${ticket.uploadId} localPath=${desiredLocalPath} ` +
                `expectedOffset=${expectedOffset} chunkStart=${currentOffset} chunkEnd=${nextChunkEnd - 1}`,
                "error"
              );
              this.maybeUpdateBinaryTransferState(desiredLocalPath, {
                status: "uploading",
                bytesDone: expectedOffset,
                bytesTotal: totalUploadBytes
              });
              continue;
            }

            throw error;
          }

          offsetRecoveryAttempts = 0;
          const serverHash = normalizeSha256Hash(uploadResponse.hash) ?? commitHash;
          const fallbackUploadedBytes = currentOffset + uploadChunk.byteLength;
          const nextUploadedBytes = clampTransferBytes(
            uploadResponse.uploadedBytes ?? fallbackUploadedBytes,
            totalUploadBytes
          );
          if (nextUploadedBytes < currentOffset) {
            throw new Error(`Upload progress moved backwards for ${desiredServerPath}.`);
          }

          commitHash = serverHash;
          uploadedBytes = nextUploadedBytes;
          this.traceBlob(
            `[${workspaceId}] upload content response entryId=${entry.id} uploadId=${uploadResponse.uploadId ?? ticket.uploadId} ` +
            `localPath=${desiredLocalPath} transport=${uploadResponse.transport} status=${uploadResponse.status} ` +
            `requestId=${uploadResponse.requestId ?? "-"} uploadedBytes=${uploadResponse.uploadedBytes ?? nextUploadedBytes} ` +
            `receivedBytes=${uploadResponse.receivedBytes ?? uploadChunk.byteLength} complete=${uploadResponse.complete === true} ` +
            `hash=${uploadResponse.hash ?? commitHash}`
          );
          if (!this.maybeUpdateBinaryTransferState(desiredLocalPath, {
            hash: commitHash,
            uploadId: uploadResponse.uploadId ?? ticket.uploadId,
            bytesDone: uploadedBytes,
            bytesTotal: totalUploadBytes
          })) {
            return;
          }

          if (uploadResponse.complete === true && uploadedBytes >= totalUploadBytes) {
            break;
          }
        }

        if (commitHash !== normalizedTicketHash) {
          this.recordLog(
            "blob",
            `[${workspaceId}] Upload endpoint returned ${commitHash} for ${desiredServerPath} instead of ticket hash ${normalizedTicketHash}. Using server-confirmed hash.`,
            "error"
          );
        }

        ticket.hash = commitHash;
        ticket.sizeBytes = totalUploadBytes;
      } else {
        if (!this.maybeUpdateBinaryTransferState(desiredLocalPath, {
          status: "committing",
          bytesDone: totalUploadBytes
        })) {
          return;
        }
      }

      if (!this.isBinarySyncTokenCurrent(desiredLocalPath, token)) {
        return;
      }

      if (!this.maybeUpdateBinaryTransferState(desiredLocalPath, {
        status: "committing",
        hash: commitHash,
        bytesDone: totalUploadBytes,
        bytesTotal: totalUploadBytes
      })) {
        return;
      }

      this.traceBlob(
        `[${workspaceId}] commit_blob_revision request entryId=${entry.id} localPath=${desiredLocalPath} hash=${commitHash} ` +
        `sizeBytes=${totalUploadBytes} entryVersion=${entry.entryVersion} path=${entry.path}`
      );
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      const commitResponse = await this.operationsQueue.enqueue(
        workspaceId,
        {
          type: "commit_blob_revision",
          entryId: entry.id,
          hash: commitHash,
          sizeBytes: totalUploadBytes,
          mimeType: ticket.mimeType,
          preconditions: {
            entryVersion: entry.entryVersion,
            path: entry.path
          }
        },
        `commit blob revision ${desiredServerPath}`
      );
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      const committedEntry = commitResponse.results.find((result) => result.status === "applied")?.entry ?? null;
      if (committedEntry) {
        this.optimisticUpsertRoomEntry(workspaceId, committedEntry);
        entry = committedEntry;
        finalEntryId = committedEntry.id;
        finalServerPath = committedEntry.path;
      }

      this.persistBinaryCacheEntry(entry.id, desiredLocalPath, commitHash, totalUploadBytes, ticket.mimeType);
      await this.clearPendingBinaryWriteForLocalPath(desiredLocalPath, false);
      this.clearBinaryTransferState(desiredLocalPath);
      this.invalidateBinarySyncToken(desiredLocalPath);
      this.recordLog(
        "blob",
        `[${workspaceId}] Uploaded ${desiredServerPath} (${formatByteCount(totalUploadBytes)}, ${commitHash.slice(0, 19)}...).`
      );
      this.traceBlob(
        `[${workspaceId}] upload complete entryId=${entry.id} localPath=${desiredLocalPath} hash=${commitHash} sizeBytes=${totalUploadBytes} ` +
        `results=${commitResponse.results.length}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === "AbortError") {
        if (!this.isUnloading) {
          this.recordLog("blob", `[${workspaceId}] Binary transfer aborted for ${finalLocalPath}.`);
        }
      } else {
        const mismatchDetails = formatBlobHashMismatchDetails(error);
        if (mismatchDetails) {
          this.recordLog(
            "blob",
            `[${workspaceId}] Blob hash mismatch for ${finalServerPath}: ${mismatchDetails}`,
            "error"
          );
        }
        this.recordLog("blob", `[${workspaceId}] Binary sync failed for ${finalLocalPath}: ${message}`, "error");
        this.handleError(`Binary sync failed for ${finalLocalPath}`, error, false);
      }

      const transfer = this.binaryTransferState.get(normalizePath(finalLocalPath));
      if (transfer) {
        this.updateBinaryTransferState(finalLocalPath, {
          status: "failed",
          lastError: message,
          abortController: null
        });
      }

      if (this.isBinarySyncTokenCurrent(finalLocalPath, token)) {
        this.rememberPendingBinaryWrite(workspaceId, finalLocalPath, finalServerPath, finalEntryId, error);
      }
    } finally {
      if (this.isUnloading) {
        return;
      }

      const transfer = this.binaryTransferState.get(normalizePath(finalLocalPath));
      const normalizedFinalLocalPath = normalizePath(finalLocalPath);
      const shouldRerun = Boolean(transfer?.rerunRequested) || this.pendingBinarySyncReruns.has(normalizedFinalLocalPath);
      this.pendingBinarySyncReruns.delete(normalizedFinalLocalPath);
      if (!shouldRerun && transfer?.status !== "failed") {
        this.clearBinaryTransferState(finalLocalPath);
      }

      if (shouldRerun) {
        this.clearBinaryTransferState(finalLocalPath);
        const currentFile = this.app.vault.getAbstractFileByPath(finalLocalPath);
        const currentServerPath = this.resolvePendingMarkdownServerPath(workspaceId, finalLocalPath, fallbackServerPath);
        const entry =
          this.data.pendingBinaryWrites[normalizePath(finalLocalPath)]?.entryId
            ? this.getRoomStore(workspaceId)?.getEntryById(
                this.data.pendingBinaryWrites[normalizePath(finalLocalPath)]?.entryId ?? ""
              ) ?? null
            : currentServerPath
              ? this.getRoomStore(workspaceId)?.getEntryByPath(currentServerPath) ?? null
              : null;
        if (currentFile instanceof TFile && isBinaryPath(currentFile.path) && currentServerPath) {
          await this.queueBinaryWrite(
            workspaceId,
            currentServerPath,
            await this.app.vault.readBinary(currentFile),
            entry
          );
        }
      }
    }
  }

  private async resolveBinaryWritePathConflict(
    workspaceId: string,
    originalServerPath: string,
    originalLocalPath: string,
    suggestedPath: string | undefined,
    token: string
  ): Promise<void> {
    const localFile = this.app.vault.getAbstractFileByPath(originalLocalPath);
    if (!(localFile instanceof TFile) || !isBinaryPath(localFile.path)) {
      await this.clearPendingBinaryWriteForLocalPath(originalLocalPath, false);
      this.recordLog(
        "blob",
        `[${workspaceId}] Dropped conflicting local binary write for ${originalServerPath} because the local file is gone.`,
        "error"
      );
      return;
    }

    const replacementServerPath = this.findAvailableBinaryConflictPath(
      workspaceId,
      suggestedPath?.trim() || originalServerPath
    );
    const replacementLocalPath = this.fileBridge.toLocalPath(workspaceId, replacementServerPath) ?? replacementServerPath;
    if (replacementLocalPath === originalLocalPath) {
      throw new Error(`No available fallback binary path for ${originalServerPath}.`);
    }

    await this.fileBridge.runWithSuppressedPaths([originalLocalPath, replacementLocalPath], async () => {
      await this.app.fileManager.renameFile(localFile, replacementLocalPath);
    });

    this.moveBinarySyncToken(originalLocalPath, replacementLocalPath);
    const conflictMessage =
      `[${workspaceId}] Local binary ${originalServerPath} conflicted with an existing server path. ` +
      `Renamed local file to ${replacementServerPath} so both copies survive.`;
    this.recordLog("blob", conflictMessage, "error");
    new Notice(`Rolay kept your local file as ${replacementServerPath}.`);

    const currentFile = this.app.vault.getAbstractFileByPath(replacementLocalPath);
    if (!(currentFile instanceof TFile)) {
      return;
    }

    await this.queueBinaryWrite(
      workspaceId,
      replacementServerPath,
      await this.app.vault.readBinary(currentFile),
      null
    );
  }

  private async reconcilePendingBinaryWrites(
    workspaceId: string,
    reason: string
  ): Promise<void> {
    const pendingWrites = this.getPendingBinaryWritesForWorkspace(workspaceId);
    if (pendingWrites.length === 0) {
      return;
    }

    this.recordLog(
      "blob",
      `[${workspaceId}] Replaying ${pendingWrites.length} pending binary write(s) after ${reason}.`
    );

    for (const pendingWrite of pendingWrites) {
      const currentFile = this.app.vault.getAbstractFileByPath(pendingWrite.localPath);
      if (!(currentFile instanceof TFile) || !isBinaryPath(currentFile.path)) {
        await this.clearPendingBinaryWriteForLocalPath(pendingWrite.localPath, false);
        this.recordLog(
          "blob",
          `[${workspaceId}] Cleared pending binary write for ${pendingWrite.localPath} because the local file no longer exists.`
        );
        continue;
      }

      const currentServerPath = this.resolvePendingMarkdownServerPath(
        workspaceId,
        pendingWrite.localPath,
        pendingWrite.serverPath
      );
      if (!currentServerPath) {
        await this.clearPendingBinaryWriteForLocalPath(pendingWrite.localPath, false);
        this.recordLog(
          "blob",
          `[${workspaceId}] Cleared pending binary write for ${pendingWrite.localPath} because it is no longer inside the room root.`
        );
        continue;
      }

      const entryById = pendingWrite.entryId
        ? this.getRoomStore(workspaceId)?.getEntryById(pendingWrite.entryId) ?? null
        : null;
      const entry = entryById ?? this.getRoomStore(workspaceId)?.getEntryByPath(currentServerPath) ?? null;
      if (entry && this.shouldDropPendingBinaryWriteAsRemoteEcho(workspaceId, pendingWrite, entry)) {
        this.clearPendingBinaryWriteRecord(pendingWrite.localPath);
        this.clearPendingLocalCreate(workspaceId, currentServerPath);
        this.recordLog(
          "blob",
          `[${workspaceId}] Cleared stale pending binary write for ${currentServerPath} because that path is already owned by remote entry ${entry.id}.`
        );
        continue;
      }

      try {
        await this.queueBinaryWrite(
          workspaceId,
          currentServerPath,
          await this.app.vault.readBinary(currentFile),
          entry
        );
      } catch {
        // Keep the pending binary write registered for the next room refresh/connect.
      }
    }
  }

  private async syncBinaryEntriesFromSnapshot(
    workspaceId: string,
    entries: FileEntry[],
    reason: string
  ): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    for (const entry of entries) {
      if (entry.kind === "binary" && entry.deleted) {
        this.clearPersistedBinaryCacheEntry(entry.id);
      }
    }

    const binaryEntries = entries.filter((entry) => !entry.deleted && entry.kind === "binary");
    await this.cancelStaleBinaryDownloads(workspaceId, binaryEntries);
    if (binaryEntries.length === 0) {
      return;
    }

    const queue = [...binaryEntries];
    const workers = Array.from(
      { length: Math.min(RolayPlugin.BINARY_DOWNLOAD_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          if (!this.isRoomSyncActive(workspaceId)) {
            return;
          }

          const entry = queue.shift();
          if (!entry) {
            return;
          }

          await this.ensureBinaryEntryDownloaded(workspaceId, entry, reason);
        }
      }
    );

    await Promise.all(workers);
  }

  private async cancelStaleBinaryDownloads(workspaceId: string, entries: FileEntry[]): Promise<void> {
    const activeEntries = new Map(entries.map((entry) => [entry.id, entry]));
    const transfers = this.getBinaryTransfersForWorkspace(workspaceId).filter((transfer) => transfer.kind === "download");
    for (const transfer of transfers) {
      const entry = transfer.entryId ? activeEntries.get(transfer.entryId) ?? null : null;
      const remoteHash = entry?.blob?.hash ?? null;
      if (!entry || entry.deleted || entry.path !== transfer.serverPath || (transfer.hash && remoteHash && transfer.hash !== remoteHash)) {
        await this.cancelBinaryTransferForLocalPath(transfer.localPath, "stale-download");
      }
    }
  }

  private async ensureBinaryEntryDownloaded(
    workspaceId: string,
    entry: FileEntry,
    reason: string
  ): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    // Only entries with a committed blob revision are downloadable. A
    // placeholder without entry.blob exists in the tree but should not yet
    // overwrite local bytes or flip the UI to "finished".
    if (entry.deleted || entry.kind !== "binary" || !entry.blob) {
      return;
    }

    const localPath = normalizePath(this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path);
    const pendingWrite = this.data.pendingBinaryWrites[localPath];
    if (pendingWrite) {
      if (this.shouldDropPendingBinaryWriteAsRemoteEcho(workspaceId, pendingWrite, entry)) {
        this.clearPendingBinaryWriteRecord(localPath);
      } else {
        return;
      }
    }

    const activeUpload = this.binaryTransferState.get(localPath);
    if (activeUpload && activeUpload.kind === "upload") {
      return;
    }

    const existingTransfer = this.binaryTransferState.get(localPath);
    const remoteHash = normalizeSha256Hash(entry.blob.hash);
    if (!remoteHash) {
      throw new Error(`Binary entry ${entry.path} is missing a valid blob hash.`);
    }

    if (
      existingTransfer &&
      existingTransfer.kind === "download" &&
      existingTransfer.hash === remoteHash &&
      (existingTransfer.status === "preparing" || existingTransfer.status === "downloading") &&
      existingTransfer.abortController
    ) {
      return;
    }

    const localFile = this.app.vault.getAbstractFileByPath(localPath);
    const cached = this.findPersistedBinaryCacheEntry(entry.id);
    const remoteSize = entry.blob.sizeBytes;
    const remoteMimeType = entry.blob.mimeType || entry.mimeType || "application/octet-stream";

    if (localFile instanceof TFile && cached?.hash === remoteHash) {
      if (normalizePath(cached.filePath) !== localPath) {
        this.persistBinaryCacheEntry(entry.id, localPath, remoteHash, remoteSize, remoteMimeType);
      }
      await this.clearBinaryDownloadPart(workspaceId, entry.id, remoteHash);
      return;
    }

    if (localFile instanceof TFile) {
      const localBytes = await this.app.vault.readBinary(localFile);
      const localHash = await sha256Hash(localBytes);
      if (localHash === remoteHash) {
        this.persistBinaryCacheEntry(entry.id, localPath, remoteHash, remoteSize, remoteMimeType);
        await this.clearBinaryDownloadPart(workspaceId, entry.id, remoteHash);
        return;
      }

      const safeToOverwrite =
        localBytes.byteLength === 0 ||
        (cached ? cached.hash === localHash : false);

      if (!safeToOverwrite) {
        await this.resolveBinaryDownloadConflict(workspaceId, entry, localPath);
      }
    }

    try {
      this.traceBlob(
        `[${workspaceId}] download-ticket request entryId=${entry.id} localPath=${localPath} serverPath=${entry.path} ` +
        `expectedHash=${remoteHash} expectedSizeBytes=${remoteSize}`
      );
      const ticket = await this.apiClient.createBlobDownloadTicket(entry.id);
      if (!this.isRoomSyncActive(workspaceId)) {
        return;
      }

      this.traceBlob(
        `[${workspaceId}] download-ticket response entryId=${entry.id} localPath=${localPath} serverPath=${entry.path} ` +
        `status=${ticket._meta.status} requestId=${ticket._meta.requestId ?? "-"} hash=${ticket.hash} sizeBytes=${ticket.sizeBytes} ` +
        `contentUrl=${ticket.contentUrl ?? "-"} rangeSupported=${ticket.rangeSupported === true}`
      );
      const ticketHash = normalizeSha256Hash(ticket.hash) ?? remoteHash;
      if (!ticketHash) {
        throw new Error(`Binary download ticket for ${entry.path} is missing a valid blob hash.`);
      }

      const totalDownloadBytes = ticket.sizeBytes > 0 ? ticket.sizeBytes : remoteSize;
      const partPath = this.getBinaryDownloadPartPath(workspaceId, entry.id, ticketHash);
      let resumeOffset = await this.getAdapterFileSize(partPath);
      if (resumeOffset > totalDownloadBytes) {
        await this.removeAdapterPathIfExists(partPath);
        resumeOffset = 0;
      }
      if (!ticket.rangeSupported && resumeOffset > 0 && resumeOffset < totalDownloadBytes) {
        this.recordLog(
          "blob",
          `[${workspaceId}] Restarting binary download for ${entry.path} from zero because ranged resume is unavailable.`
        );
        await this.removeAdapterPathIfExists(partPath);
        resumeOffset = 0;
      }

      if (totalDownloadBytes === 0 && resumeOffset === 0) {
        await this.writeBinaryTransferPart(partPath, new ArrayBuffer(0), false);
      }

      this.setBinaryTransferState({
        workspaceId,
        entryId: entry.id,
        localPath,
        serverPath: entry.path,
        kind: "download",
        status: "preparing",
        bytesTotal: totalDownloadBytes,
        bytesDone: resumeOffset,
        hash: ticketHash,
        mimeType: ticket.mimeType || remoteMimeType,
        uploadId: null,
        cancelUrl: null,
        lastError: null,
        rangeSupported: Boolean(ticket.rangeSupported),
        createdAt: existingTransfer?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rerunRequested: false,
        abortController: new AbortController()
      });

      const transfer = this.maybeUpdateBinaryTransferState(localPath, {
        status: "downloading",
        bytesTotal: totalDownloadBytes,
        bytesDone: resumeOffset,
        hash: ticketHash,
        mimeType: ticket.mimeType || remoteMimeType,
        rangeSupported: Boolean(ticket.rangeSupported)
      });
      if (!transfer) {
        return;
      }

      if (resumeOffset > 0 && resumeOffset < totalDownloadBytes) {
        this.recordLog(
          "blob",
          `[${workspaceId}] Resuming binary download for ${entry.path} at ${formatByteCount(resumeOffset)} of ${formatByteCount(totalDownloadBytes)}.`
        );
      }

      if (resumeOffset < totalDownloadBytes) {
        let append = resumeOffset > 0;
        if (!append) {
          await this.removeAdapterPathIfExists(partPath);
        }

        // Downloads never touch the live vault file until the full `.part`
        // payload is present and matches the expected blob hash.
        const downloadUrl = this.getBinaryBlobContentUrl(entry.id, ticket.contentUrl ?? null);
        this.traceBlob(
          `[${workspaceId}] blob content request entryId=${entry.id} localPath=${localPath} expectedHash=${ticketHash} ` +
          `expectedSizeBytes=${totalDownloadBytes} partialOffset=${resumeOffset} range=${resumeOffset > 0 ? `bytes=${resumeOffset}-` : "-"}`
        );
        const download = await this.apiClient.downloadBlobContent(
          downloadUrl,
          resumeOffset,
          async (chunk) => {
            await this.writeBinaryTransferPart(partPath, chunk, append);
            append = true;
          },
          (progress) => {
            this.maybeUpdateBinaryTransferState(localPath, {
              status: "downloading",
              bytesDone: progress.loadedBytes,
              bytesTotal: progress.totalBytes > 0 ? progress.totalBytes : totalDownloadBytes
            });
          },
          transfer.abortController?.signal
        );
        if (!this.isRoomSyncActive(workspaceId)) {
          return;
        }

        this.traceBlob(
          `[${workspaceId}] blob content response entryId=${entry.id} localPath=${localPath} transport=${download.transport} ` +
          `status=${download.status} requestId=${download.requestId ?? "-"} contentLength=${download.contentLength ?? -1} ` +
          `contentRange=${download.contentRange ?? "-"} acceptRanges=${download.acceptRanges ?? "-"} ` +
          `blobHash=${download.hash ?? "-"}`
        );

        await this.applyDownloadedBinary(
          workspaceId,
          entry,
          localPath,
          partPath,
          {
            hash: normalizeSha256Hash(download.hash ?? ticketHash) ?? ticketHash,
            sizeBytes: totalDownloadBytes,
            mimeType: download.contentType ?? ticket.mimeType ?? remoteMimeType
          },
          reason
        );
      } else {
        this.traceBlob(
          `[${workspaceId}] blob content skipped entryId=${entry.id} localPath=${localPath} reason=already-complete partialOffset=${resumeOffset}`
        );
        await this.applyDownloadedBinary(
          workspaceId,
          entry,
          localPath,
          partPath,
          {
            hash: ticketHash,
            sizeBytes: totalDownloadBytes,
            mimeType: ticket.mimeType ?? remoteMimeType
          },
          reason
        );
      }

      this.clearBinaryTransferState(localPath);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        this.recordLog(
          "blob",
          `[${workspaceId}] Binary download failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      } else if (!this.isUnloading) {
        this.recordLog("blob", `[${workspaceId}] Binary download aborted for ${entry.path}.`);
      }

      if (this.isUnloading) {
        return;
      }

      this.maybeUpdateBinaryTransferState(localPath, {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        abortController: null
      });
    }
  }

  private async applyDownloadedBinary(
    workspaceId: string,
    entry: FileEntry,
    localPath: string,
    partPath: string,
    downloadMeta: { hash: string; sizeBytes: number; mimeType: string | null },
    reason: string
  ): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    const downloadData = await this.readBinaryTransferPart(partPath);
    if (!downloadData) {
      throw new Error(`Downloaded binary part for ${entry.path} is missing.`);
    }

    const effectiveHash = normalizeSha256Hash(downloadMeta.hash);
    const effectiveSize = downloadMeta.sizeBytes > 0 ? downloadMeta.sizeBytes : downloadData.byteLength;
    const effectiveMimeType =
      downloadMeta.mimeType ?? entry.blob?.mimeType ?? entry.mimeType ?? "application/octet-stream";
    if (effectiveSize !== downloadData.byteLength) {
      await this.removeAdapterPathIfExists(partPath);
      throw new Error(
        `Downloaded blob size mismatch for ${entry.path}: expected ${effectiveSize} bytes, got ${downloadData.byteLength}.`
      );
    }

    const computedHash = await sha256Hash(downloadData);
    if (!this.isRoomSyncActive(workspaceId)) {
      return;
    }

    this.traceBlob(
      `[${workspaceId}] download finalize entryId=${entry.id} localPath=${localPath} partPath=${partPath} ` +
      `computedHash=${computedHash} expectedHash=${effectiveHash ?? "-"} sizeBytes=${downloadData.byteLength}`
    );
    if (effectiveHash && computedHash !== effectiveHash) {
      await this.removeAdapterPathIfExists(partPath);
      throw new Error(`Downloaded blob hash mismatch for ${entry.path}.`);
    }

    const existingLocalFile = this.app.vault.getAbstractFileByPath(localPath);
    const cached = this.findPersistedBinaryCacheEntry(entry.id);
    if (existingLocalFile instanceof TFile) {
      const currentLocalBytes = await this.app.vault.readBinary(existingLocalFile);
      const currentLocalHash = await sha256Hash(currentLocalBytes);

      if (currentLocalHash === computedHash) {
        this.persistBinaryCacheEntry(entry.id, localPath, computedHash, effectiveSize, effectiveMimeType);
        await this.removeAdapterPathIfExists(partPath);
        return;
      }

      const safeToOverwrite =
        currentLocalBytes.byteLength === 0 ||
        (cached ? cached.hash === currentLocalHash : false);

      if (!safeToOverwrite) {
        await this.resolveBinaryDownloadConflict(workspaceId, entry, localPath);
      }
    }

    await this.fileBridge.writeBinaryContent(workspaceId, entry.path, downloadData);
    await this.removeAdapterPathIfExists(partPath);
    this.persistBinaryCacheEntry(entry.id, localPath, computedHash, effectiveSize, effectiveMimeType);
    this.recordLog(
      "blob",
      `[${workspaceId}] Downloaded ${entry.path} (${formatByteCount(downloadData.byteLength)}) from ${reason}.`
    );
  }

  private async resolveBinaryDownloadConflict(
    workspaceId: string,
    entry: FileEntry,
    originalLocalPath: string
  ): Promise<void> {
    const localFile = this.app.vault.getAbstractFileByPath(originalLocalPath);
    if (!(localFile instanceof TFile) || !isBinaryPath(localFile.path)) {
      return;
    }

    const replacementServerPath = this.findAvailableBinaryConflictPath(workspaceId, entry.path);
    const replacementLocalPath = this.fileBridge.toLocalPath(workspaceId, replacementServerPath) ?? replacementServerPath;
    if (replacementLocalPath === originalLocalPath) {
      return;
    }

    await this.fileBridge.runWithSuppressedPaths([originalLocalPath, replacementLocalPath], async () => {
      await this.app.fileManager.renameFile(localFile, replacementLocalPath);
    });

    const conflictMessage =
      `[${workspaceId}] Local binary ${entry.path} diverged from the incoming remote blob. ` +
      `Renamed local file to ${replacementServerPath} so both copies survive.`;
    this.recordLog("blob", conflictMessage, "error");
    new Notice(`Rolay kept your local file as ${replacementServerPath}.`);

    const replacementFile = this.app.vault.getAbstractFileByPath(replacementLocalPath);
    if (replacementFile instanceof TFile) {
      await this.queueBinaryWrite(
        workspaceId,
        replacementServerPath,
        await this.app.vault.readBinary(replacementFile),
        null
      );
    }
  }

  private async deleteBinaryPlaceholderIfSafe(workspaceId: string, entry: FileEntry): Promise<void> {
    try {
      await this.operationsQueue.enqueue(
        workspaceId,
        {
          type: "delete_entry",
          entryId: entry.id,
          preconditions: {
            entryVersion: entry.entryVersion,
            path: entry.path
          }
        },
        `abandon binary placeholder ${entry.path}`
      );
      this.optimisticDeleteRoomEntry(workspaceId, entry.id);
    } catch (error) {
      this.recordLog(
        "blob",
        `[${workspaceId}] Failed to delete abandoned binary placeholder ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  private findAvailableBinaryConflictPath(workspaceId: string, desiredServerPath: string): string {
    const normalizedDesiredPath = desiredServerPath.replace(/\\/g, "/");
    const directoryPath = getParentPath(normalizedDesiredPath);
    const fileName = getFileName(normalizedDesiredPath);
    const extension = getFileExtension(fileName);
    const rawStem = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
    const { baseStem, nextIndex } = parseCopySuffix(rawStem);

    const candidates = [normalizedDesiredPath];
    for (let index = nextIndex; index <= nextIndex + 999; index += 1) {
      const candidateFileName = extension
        ? `${baseStem}(${index}).${extension}`
        : `${baseStem}(${index})`;
      candidates.push(directoryPath ? `${directoryPath}/${candidateFileName}` : candidateFileName);
    }

    for (const candidatePath of candidates) {
      const remoteExists = Boolean(this.getRoomStore(workspaceId)?.getEntryByPath(candidatePath));
      const localPath = this.fileBridge.toLocalPath(workspaceId, candidatePath) ?? candidatePath;
      const localExists = Boolean(this.app.vault.getAbstractFileByPath(localPath));
      if (!remoteExists && !localExists) {
        return candidatePath;
      }
    }

    throw new Error(`No free conflict-safe binary path is available for ${desiredServerPath}.`);
  }

  private async queueRenameOrMove(
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: "rename_entry" | "move_entry"
  ): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      this.recordLog(
        "ops",
        `[${workspaceId}] Ignored local ${type} ${entry.path} -> ${newPath} because the room is disconnected.`
      );
      return;
    }

    this.optimisticUpsertRoomEntry(workspaceId, {
      ...entry,
      path: newPath
    });

    try {
      const response = await this.operationsQueue.enqueue(
        workspaceId,
        {
          type,
          entryId: entry.id,
          newPath,
          preconditions: {
            entryVersion: entry.entryVersion,
            path: entry.path
          }
        },
        `${type} ${entry.path} -> ${newPath}`
      );

      const updatedEntry =
        response.results.find((result) => result.status === "applied")?.entry ??
        {
          ...entry,
          path: newPath
        };
      this.optimisticUpsertRoomEntry(workspaceId, updatedEntry);
    } catch (error) {
      this.scheduleSnapshotRefresh(workspaceId, "rename-recovery");
      throw error;
    }
  }

  private async queueDeleteEntry(workspaceId: string, entry: FileEntry): Promise<void> {
    if (!this.isRoomSyncActive(workspaceId)) {
      this.recordLog("ops", `[${workspaceId}] Ignored local delete ${entry.path} because the room is disconnected.`);
      return;
    }

    this.registerPendingLocalDelete(workspaceId, entry.path);
    this.optimisticDeleteRoomEntry(workspaceId, entry.id);

    try {
      const response = await this.operationsQueue.enqueue(
        workspaceId,
        {
          type: "delete_entry",
          entryId: entry.id,
          preconditions: {
            entryVersion: entry.entryVersion,
            path: entry.path
          }
        },
        `delete ${entry.path}`
      );

      const deletedEntry = response.results.find((result) => result.status === "applied")?.entry ?? null;
      if (deletedEntry) {
        this.optimisticUpsertRoomEntry(workspaceId, deletedEntry);
        if (entry.kind === "binary") {
          this.clearPersistedBinaryCacheEntry(entry.id);
        }
        return;
      }

      this.optimisticDeleteRoomEntry(workspaceId, entry.id);
      if (entry.kind === "binary") {
        this.clearPersistedBinaryCacheEntry(entry.id);
      }
    } catch (error) {
      this.clearPendingLocalDelete(workspaceId, entry.path);
      this.scheduleSnapshotRefresh(workspaceId, "delete-recovery");
      throw error;
    }
  }

  private findAvailableMarkdownConflictPath(workspaceId: string, desiredServerPath: string): string {
    const normalizedDesiredPath = desiredServerPath.replace(/\\/g, "/");
    const directoryPath = getParentPath(normalizedDesiredPath);
    const fileName = getFileName(normalizedDesiredPath);
    const extension = getFileExtension(fileName);
    const rawStem = extension ? fileName.slice(0, -(extension.length + 1)) : fileName;
    const { baseStem, nextIndex } = parseCopySuffix(rawStem);

    const candidates = [normalizedDesiredPath];
    for (let index = nextIndex; index <= nextIndex + 999; index += 1) {
      const candidateFileName = extension
        ? `${baseStem}(${index}).${extension}`
        : `${baseStem}(${index})`;
      candidates.push(directoryPath ? `${directoryPath}/${candidateFileName}` : candidateFileName);
    }

    for (const candidatePath of candidates) {
      const remoteExists = Boolean(this.getRoomStore(workspaceId)?.getEntryByPath(candidatePath));
      if (remoteExists) {
        continue;
      }

      const candidateLocalPath = this.fileBridge.toLocalPath(workspaceId, candidatePath) ?? candidatePath;
      if (this.app.vault.getAbstractFileByPath(candidateLocalPath)) {
        continue;
      }

      return candidatePath;
    }

    throw new Error(`No free conflict-safe path is available for ${desiredServerPath}.`);
  }

  private async readLocalMarkdownContent(localPath: string, fallback = ""): Promise<string> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path === localPath) {
      return activeView.editor.getValue();
    }

    const localFile = this.app.vault.getAbstractFileByPath(localPath);
    if (!(localFile instanceof TFile) || localFile.extension !== "md") {
      return fallback;
    }

    try {
      return await this.app.vault.cachedRead(localFile);
    } catch (error) {
      this.recordLog(
        "bridge",
        `Failed to read local markdown content for ${localPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return fallback;
    }
  }

  private async readLocalBinaryContent(localPath: string, fallback = new ArrayBuffer(0)): Promise<ArrayBuffer> {
    const localFile = this.app.vault.getAbstractFileByPath(localPath);
    if (!(localFile instanceof TFile) || !isBinaryPath(localFile.path)) {
      return fallback;
    }

    try {
      return await this.app.vault.readBinary(localFile);
    } catch (error) {
      this.recordLog(
        "blob",
        `Failed to read local binary content for ${localPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return fallback;
    }
  }
}

function normalizeSettingsEventEnvelope(event: SettingsStreamEvent): SettingsEventEnvelope<unknown> {
  const rawData: Record<string, unknown> = isRecord(event.data) ? event.data : {};
  const eventId = typeof rawData["eventId"] === "number" ? rawData["eventId"] : event.id;
  const type = typeof rawData["type"] === "string" ? rawData["type"] : event.event;
  const occurredAt =
    typeof rawData["occurredAt"] === "string" ? rawData["occurredAt"] : new Date().toISOString();
  const scope =
    typeof rawData["scope"] === "string" ? rawData["scope"] : inferSettingsScopeFromType(type);
  const payload = "payload" in rawData ? rawData["payload"] : event.data;

  return {
    eventId,
    type,
    occurredAt,
    scope,
    payload
  };
}

function inferSettingsScopeFromType(type: string): string {
  switch (type) {
    case "stream.ready":
    case "ping":
      return "settings.stream";
    case "auth.me.updated":
      return "auth.me";
    case "room.invite.updated":
      return "room.invite";
    case "room.publication.updated":
      return "room.publication";
    case "admin.user.created":
    case "admin.user.updated":
    case "admin.user.deleted":
      return "admin.users";
    case "admin.room.members.updated":
      return "admin.room.members";
    default:
      return "rooms";
  }
}

function extractUserFromSettingsPayload(payload: unknown): User | null {
  const candidate = unwrapSettingsPayloadObject(payload, "user");
  if (!candidate) {
    return null;
  }

  const { id, username, displayName, isAdmin, globalRole } = candidate;
  if (
    typeof id !== "string" ||
    typeof username !== "string" ||
    typeof displayName !== "string" ||
    typeof isAdmin !== "boolean" ||
    (globalRole !== "admin" && globalRole !== "writer" && globalRole !== "reader")
  ) {
    return null;
  }

  return {
    id,
    username,
    displayName,
    isAdmin,
    globalRole
  };
}

function extractManagedUserFromSettingsPayload(payload: unknown): ManagedUser | null {
  const candidate = unwrapSettingsPayloadObject(payload, "user");
  const user = extractUserFromSettingsPayload(candidate ?? payload);
  if (!user || !candidate) {
    return null;
  }

  return {
    ...user,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
    disabledAt:
      typeof candidate.disabledAt === "string" || candidate.disabledAt === null
        ? candidate.disabledAt
        : undefined
  };
}

function extractRoomFromSettingsPayload(payload: unknown): RoomListItem | null {
  const candidate = unwrapSettingsPayloadObject(payload, "room");
  if (!candidate) {
    return null;
  }

  const workspace = extractWorkspace(candidate.workspace);
  const membershipRole = candidate.membershipRole;
  const createdAt = candidate.createdAt;
  const memberCount = candidate.memberCount;
  const inviteEnabled = candidate.inviteEnabled;

  if (
    !workspace ||
    (membershipRole !== "owner" && membershipRole !== "member") ||
    typeof createdAt !== "string" ||
    typeof memberCount !== "number" ||
    typeof inviteEnabled !== "boolean"
  ) {
    return null;
  }

  return {
    workspace,
    membershipRole,
    createdAt,
    memberCount,
    inviteEnabled,
    publication: extractRoomPublicationState(candidate.publication, workspace.id) ?? undefined
  };
}

function extractAdminRoomFromSettingsPayload(payload: unknown): AdminRoomListItem | null {
  const candidate = unwrapSettingsPayloadObject(payload, "room");
  const room = extractRoomFromSettingsPayload(candidate ?? payload);
  if (!room || !candidate || typeof candidate.ownerCount !== "number") {
    return null;
  }

  return {
    ...room,
    ownerCount: candidate.ownerCount
  };
}

function extractInviteFromSettingsPayload(payload: unknown): InviteState | null {
  const candidate = unwrapSettingsPayloadObject(payload, "invite");
  if (!candidate) {
    return null;
  }

  const { workspaceId, code, enabled, updatedAt } = candidate;
  if (
    typeof workspaceId !== "string" ||
    typeof code !== "string" ||
    typeof enabled !== "boolean" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId,
    code,
    enabled,
    updatedAt
  };
}

function extractRoomMembershipChangedPayload(
  payload: unknown
): { workspaceId?: string; room?: RoomListItem; removed?: boolean } | null {
  if (!isRecord(payload)) {
    return null;
  }

  const room = extractRoomFromSettingsPayload(payload);
  const workspaceId =
    typeof payload.workspaceId === "string"
      ? payload.workspaceId
      : room?.workspace.id;
  const removed = typeof payload.removed === "boolean" ? payload.removed : undefined;
  if (!workspaceId && !room) {
    return null;
  }

  return {
    workspaceId,
    room: room ?? undefined,
    removed
  };
}

function extractWorkspaceIdFromSettingsPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.workspaceId === "string") {
    return payload.workspaceId;
  }

  const room = extractRoomFromSettingsPayload(payload) ?? extractAdminRoomFromSettingsPayload(payload);
  return room?.workspace.id ?? null;
}

function extractUserIdFromSettingsPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.userId === "string") {
    return payload.userId;
  }

  const user = extractUserFromSettingsPayload(payload);
  return user?.id ?? null;
}

function extractAdminRoomMembersPayload(
  payload: unknown
): { workspaceId: string; members: RoomMember[] } | null {
  if (!isRecord(payload) || typeof payload.workspaceId !== "string" || !Array.isArray(payload.members)) {
    return null;
  }

  const members = payload.members
    .map((member) => extractRoomMember(member))
    .filter((member): member is RoomMember => member !== null)
    .sort(compareRoomMembers);

  return {
    workspaceId: payload.workspaceId,
    members
  };
}

function extractRoomPublicationUpdatedPayload(
  payload: unknown
): SettingsRoomPublicationUpdatedPayload | null {
  if (!isRecord(payload) || typeof payload.workspaceId !== "string") {
    return null;
  }

  const publication = extractRoomPublicationState(payload.publication, payload.workspaceId);
  if (!publication) {
    return null;
  }

  return {
    workspaceId: payload.workspaceId,
    publication
  };
}

function extractRoomPublicationState(
  payload: unknown,
  fallbackWorkspaceId: string
): RoomPublicationState | null {
  if (!isRecord(payload)) {
    return createDefaultRoomPublicationState(fallbackWorkspaceId);
  }

  const workspaceId =
    typeof payload.workspaceId === "string" && payload.workspaceId.trim()
      ? payload.workspaceId
      : fallbackWorkspaceId;
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : false;
  const updatedAt =
    typeof payload.updatedAt === "string" && payload.updatedAt.trim()
      ? payload.updatedAt
      : null;

  return {
    workspaceId,
    enabled,
    updatedAt
  };
}

function extractNotePresenceSnapshotPayload(payload: unknown): NotePresenceSnapshotPayload | null {
  if (!isRecord(payload) || typeof payload.workspaceId !== "string" || !Array.isArray(payload.notes)) {
    return null;
  }

  const notes = payload.notes
    .map((note) => extractNotePresenceSnapshotNote(note))
    .filter((note): note is NotePresenceSnapshotPayload["notes"][number] => note !== null);

  return {
    workspaceId: payload.workspaceId,
    notes
  };
}

function extractNotePresenceUpdatedPayload(payload: unknown): NotePresenceUpdatedPayload | null {
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.entryId !== "string" ||
    !Array.isArray(payload.viewers)
  ) {
    return null;
  }

  const viewers = payload.viewers
    .map((viewer) => extractNotePresenceViewer(viewer))
    .filter((viewer): viewer is NotePresenceViewer => viewer !== null)
    .sort(compareNotePresenceViewers);

  return {
    workspaceId: payload.workspaceId,
    entryId: payload.entryId,
    viewers,
    anonymousViewerCount: extractAnonymousViewerCount(payload.anonymousViewerCount)
  };
}

function extractNotePresenceSnapshotNote(
  payload: unknown
): NotePresenceSnapshotPayload["notes"][number] | null {
  if (!isRecord(payload) || typeof payload.entryId !== "string" || !Array.isArray(payload.viewers)) {
    return null;
  }

  const viewers = payload.viewers
    .map((viewer) => extractNotePresenceViewer(viewer))
    .filter((viewer): viewer is NotePresenceViewer => viewer !== null)
    .sort(compareNotePresenceViewers);

  return {
    entryId: payload.entryId,
    viewers,
    anonymousViewerCount: extractAnonymousViewerCount(payload.anonymousViewerCount)
  };
}

function extractNotePresenceViewer(payload: unknown): NotePresenceViewer | null {
  if (
    !isRecord(payload) ||
    typeof payload.presenceId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.color !== "string" ||
    typeof payload.hasSelection !== "boolean"
  ) {
    return null;
  }

  return {
    presenceId: payload.presenceId,
    userId: payload.userId,
    displayName: payload.displayName,
    color: payload.color,
    hasSelection: payload.hasSelection
  };
}

function extractAnonymousViewerCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function createEmptyNotePresenceDisplayState(): NotePresenceDisplayState {
  return {
    viewers: [],
    anonymousViewerCount: 0
  };
}

function extractRoomMember(payload: unknown): RoomMember | null {
  if (!isRecord(payload)) {
    return null;
  }

  const user = extractUserFromSettingsPayload(payload.user);
  if (
    !user ||
    (payload.role !== "owner" && payload.role !== "member") ||
    typeof payload.joinedAt !== "string"
  ) {
    return null;
  }

  return {
    user,
    role: payload.role,
    joinedAt: payload.joinedAt
  };
}

function extractWorkspace(payload: unknown): { id: string; slug?: string; name: string } | null {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.name !== "string") {
    return null;
  }

  return {
    id: payload.id,
    slug: typeof payload.slug === "string" ? payload.slug : undefined,
    name: payload.name
  };
}

function unwrapSettingsPayloadObject(
  payload: unknown,
  nestedKey: string
): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (isRecord(payload[nestedKey])) {
    return payload[nestedKey];
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareRoomsByName(left: RoomListItem, right: RoomListItem): number {
  const nameComparison = left.workspace.name.localeCompare(right.workspace.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.workspace.id.localeCompare(right.workspace.id);
}

function compareRoomMembers(left: RoomMember, right: RoomMember): number {
  if (left.role !== right.role) {
    return left.role === "owner" ? -1 : 1;
  }

  return left.user.username.localeCompare(right.user.username);
}

function createDefaultRoomPublicationState(workspaceId: string): RoomPublicationState {
  return {
    workspaceId,
    enabled: false,
    updatedAt: null
  };
}

function normalizeRoomPublicationState(
  publication: RoomPublicationState | null | undefined,
  workspaceId: string
): RoomPublicationState {
  return extractRoomPublicationState(publication, workspaceId) ?? createDefaultRoomPublicationState(workspaceId);
}

function normalizeRoomListItem(room: RoomListItem): RoomListItem {
  return {
    ...room,
    publication: normalizeRoomPublicationState(room.publication, room.workspace.id)
  };
}

function normalizeAdminRoomListItem(room: AdminRoomListItem): AdminRoomListItem {
  return {
    ...room,
    publication: normalizeRoomPublicationState(room.publication, room.workspace.id)
  };
}

function compareNotePresenceViewers(left: NotePresenceViewer, right: NotePresenceViewer): number {
  const displayNameComparison = left.displayName.localeCompare(right.displayName);
  if (displayNameComparison !== 0) {
    return displayNameComparison;
  }

  return left.presenceId.localeCompare(right.presenceId);
}

function normalizeBootstrapState(encodedState: string): Uint8Array {
  const decodedState = decodeBase64(encodedState);
  const yDocument = new Y.Doc();

  try {
    Y.applyUpdate(yDocument, decodedState, "rolay-http-bootstrap");
    return Y.encodeStateAsUpdate(yDocument);
  } finally {
    yDocument.destroy();
  }
}

function decodeMarkdownTextState(state: Uint8Array): string {
  const yDocument = new Y.Doc();

  try {
    Y.applyUpdate(yDocument, state, "rolay-decode-markdown-state");
    return yDocument.getText("content").toString();
  } finally {
    yDocument.destroy();
  }
}

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBlobHashMismatchDetails(error: unknown): string | null {
  if (!(error instanceof RolayApiError) || error.code !== "blob_hash_mismatch") {
    return null;
  }

  const details = error.details ?? {};
  const expectedHash = typeof details.expectedHash === "string" ? details.expectedHash : null;
  const actualHash = typeof details.actualHash === "string" ? details.actualHash : null;
  const receivedSizeBytes =
    typeof details.receivedSizeBytes === "number" && Number.isFinite(details.receivedSizeBytes)
      ? details.receivedSizeBytes
      : null;

  const parts: string[] = [];
  if (expectedHash) {
    parts.push(`expected ${expectedHash}`);
  }
  if (actualHash) {
    parts.push(`actual ${actualHash}`);
  }
  if (receivedSizeBytes !== null) {
    parts.push(`received ${formatByteCount(receivedSizeBytes)}`);
  }
  if (expectedHash && actualHash) {
    const normalizedExpected = normalizeSha256Hash(expectedHash);
    const normalizedActual = normalizeSha256Hash(actualHash);
    if (normalizedExpected && normalizedActual && normalizedExpected === normalizedActual) {
      parts.push("same digest, different hash encoding");
    }
  }

  if (parts.length === 0) {
    return error.message;
  }

  return parts.join(", ");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleMarkdownBootstrapError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("markdown entry not found");
}

function isRetryableBackgroundMarkdownError(error: unknown): boolean {
  if (error instanceof RolayApiError && [408, 429, 500, 502, 503, 504].includes(error.status)) {
    return true;
  }

  const message = getErrorMessage(error);
  return (
    message.includes("ERR_CONTENT_LENGTH_MISMATCH") ||
    message.includes("ERR_NETWORK_IO_SUSPENDED") ||
    message.includes("Failed to fetch") ||
    message.includes("NetworkError")
  );
}

function clampTransferBytes(value: number, totalBytes: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return Math.max(0, Math.trunc(value));
  }

  return Math.max(0, Math.min(Math.trunc(value), Math.trunc(totalBytes)));
}

function extractBlobOffsetMismatchExpectedOffset(error: unknown, totalBytes: number): number | null {
  if (!(error instanceof RolayApiError) || error.code !== "blob_offset_mismatch") {
    return null;
  }

  const rawOffset = error.details?.expectedOffset;
  if (typeof rawOffset !== "number" || !Number.isFinite(rawOffset)) {
    return null;
  }

  return clampTransferBytes(rawOffset, totalBytes);
}

function areUint8ArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function compareCrdtCacheEntries(left: RolayCrdtCacheEntry, right: RolayCrdtCacheEntry): number {
  return left.updatedAt.localeCompare(right.updatedAt);
}

function formatPersistentLogLine(entry: RolayLogEntry): string {
  const sanitizedMessage = entry.message.replace(/\r?\n/g, " ");
  return `[${entry.at}] ${entry.scope}/${entry.level}: ${sanitizedMessage}\n`;
}

function trimRecentLogEntries(
  entries: RolayLogEntry[],
  nowMs: number,
  retentionMs: number,
  maxEntries: number
): RolayLogEntry[] {
  const cutoffMs = nowMs - retentionMs;
  return entries
    .filter((entry) => {
      const timestampMs = Date.parse(entry.at);
      return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
    })
    .slice(-maxEntries);
}

function trimPersistentLogByAge(contents: string, retentionMs: number, nowMs: number): string {
  if (!contents) {
    return contents;
  }

  const cutoffMs = nowMs - retentionMs;
  const lines = splitPersistentLogLines(contents);
  const keptLines: string[] = [];
  let droppedLineCount = 0;

  for (const line of lines) {
    const timestampMs = parsePersistentLogTimestampMs(line);
    if (timestampMs === null) {
      if (line.includes("trimmed older Rolay log lines")) {
        droppedLineCount += 1;
        continue;
      }

      keptLines.push(line);
      continue;
    }

    if (timestampMs >= cutoffMs) {
      keptLines.push(line);
    } else {
      droppedLineCount += 1;
    }
  }

  if (droppedLineCount === 0) {
    return contents;
  }

  const retentionHours = Math.round(retentionMs / (60 * 60 * 1000));
  return (
    formatPersistentLogTrimLine(
      nowMs,
      `Trimmed ${droppedLineCount} Rolay log line(s) older than ${retentionHours} hours.`
    ) + keptLines.join("")
  );
}

function trimPersistentLogBySize(contents: string, maxBytes: number, targetBytes: number, nowMs: number): string {
  if (!contents || getTextByteLength(contents) <= maxBytes) {
    return contents;
  }

  const marker = formatPersistentLogTrimLine(
    nowMs,
    `Trimmed persistent Rolay log to the newest ${formatByteCount(targetBytes)} because it exceeded ${formatByteCount(
      maxBytes
    )}.`
  );
  const lines = splitPersistentLogLines(contents);
  const keptLines: string[] = [];
  let keptBytes = getTextByteLength(marker);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineBytes = getTextByteLength(line);
    if (keptBytes + lineBytes > targetBytes && keptLines.length > 0) {
      break;
    }

    if (keptBytes + lineBytes <= targetBytes) {
      keptLines.push(line);
      keptBytes += lineBytes;
    }
  }

  if (keptLines.length === 0) {
    return marker;
  }

  return marker + keptLines.reverse().join("");
}

function splitPersistentLogLines(contents: string): string[] {
  return contents.match(/[^\r\n]*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function parsePersistentLogTimestampMs(line: string): number | null {
  const match = /^\[([^\]]+)\]/.exec(line);
  if (!match) {
    return null;
  }

  const timestampMs = Date.parse(match[1]);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function formatPersistentLogTrimLine(nowMs: number, message: string): string {
  return `[${new Date(nowMs).toISOString()}] plugin/info: ${message}\n`;
}

function getTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function getFileName(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

function getParentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-");
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "";
  }

  return fileName.slice(dotIndex + 1);
}

function parseCopySuffix(stem: string): { baseStem: string; nextIndex: number } {
  const match = stem.match(/^(.*)\((\d+)\)$/);
  if (!match) {
    return {
      baseStem: stem,
      nextIndex: 1
    };
  }

  return {
    baseStem: match[1],
    nextIndex: Number(match[2]) + 1
  };
}
