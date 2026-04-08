import { MarkdownView, Notice, Plugin, TFile, normalizePath, type TAbstractFile } from "obsidian";
import * as Y from "yjs";
import { RolayApiClient, RolayApiError } from "./api/client";
import { FileBridge } from "./obsidian/file-bridge";
import { createMarkdownTextState, CrdtSessionManager } from "./realtime/crdt-session";
import { createSharedPresenceExtension, getMarkdownViewsForFile } from "./realtime/shared-presence";
import {
  getRoomBindingSettings,
  ROLAY_AUTO_CONNECT,
  ROLAY_DEVICE_NAME,
  ROLAY_SERVER_URL,
  type RolayCrdtCacheEntry,
  getRoomSyncState,
  mergePluginData,
  normalizeServerUrl,
  type RolayLogEntry,
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
  RoomListItem,
  RoomMember,
  SettingsEventEnvelope,
  SettingsStreamEvent,
  User
} from "./types/protocol";
import { openTextInputModal } from "./ui/text-input-modal";
import { decodeBase64, encodeBase64 } from "./utils/base64";

interface RoomRuntimeState {
  treeStore: TreeStore;
  eventStream: WorkspaceEventStream | null;
  streamStatus: WorkspaceEventStreamStatus;
  snapshotRefreshHandle: number | null;
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
  invite: InviteState | null;
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
  private static readonly MAX_LOG_FILE_BYTES = 512 * 1024;
  private static readonly LOG_FILE_NAME = "rolay-sync.log";
  private static readonly PENDING_CREATE_CONFIRMATION_TTL_MS = 60_000;
  private static readonly RECENT_REMOTE_PATH_TTL_MS = 30_000;
  private static readonly REMOTE_MARKDOWN_SETTLE_TTL_MS = 15_000;
  private static readonly ROOM_MARKDOWN_REFRESH_INTERVAL_MS = 5_000;
  private static readonly ROOM_MARKDOWN_REFRESH_AFTER_SNAPSHOT_MS = 1_200;
  private static readonly MARKDOWN_BOOTSTRAP_BATCH_MAX_DOCS = 8;
  private static readonly MARKDOWN_BOOTSTRAP_BATCH_TARGET_ENCODED_BYTES = 512 * 1024;
  private data!: RolayPluginData;
  private apiClient!: RolayApiClient;
  private crdtManager!: CrdtSessionManager;
  private operationsQueue!: OperationsQueue;
  private fileBridge!: FileBridge;
  private readonly roomRuntime = new Map<string, RoomRuntimeState>();
  private readonly roomInvites = new Map<string, InviteState>();
  private readonly pendingLocalCreates = new Map<string, number>();
  private readonly pendingLocalDeletes = new Set<string>();
  private readonly recentRemoteObservedPaths = new Map<string, number>();
  private readonly pendingRemoteMarkdownSettles = new Map<string, number>();
  private persistHandle: number | null = null;
  private explorerDecorationHandle: number | null = null;
  private statusBarEl!: HTMLElement;
  private roomList: RoomListItem[] = [];
  private adminRoomList: AdminRoomListItem[] = [];
  private managedUsers: ManagedUser[] = [];
  private adminSelectedRoomId = "";
  private adminRoomMembers: RoomMember[] = [];
  private logFlushHandle: number | null = null;
  private logFileWrite = Promise.resolve();
  private readonly pendingLogLines: string[] = [];
  private settingsTab!: RolaySettingTab;
  private settingsEventStream: SettingsEventStream | null = null;
  private settingsEventCursor: number | null = null;
  private settingsEventStreamStatus: WorkspaceEventStreamStatus = "stopped";
  private settingsStreamRecoveryInFlight = false;
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
    this.data = mergePluginData(await this.loadData());
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
      hasPendingCreate: (workspaceId, path) => this.hasPendingLocalCreate(workspaceId, path),
      hasPendingDelete: (workspaceId, path) => this.hasPendingLocalDelete(workspaceId, path),
      log: (message) => this.recordLog("bridge", message),
      onCreateFolder: (workspaceId, path) => this.queueCreateFolder(workspaceId, path),
      onCreateMarkdown: (workspaceId, path, localContent) => this.queueCreateMarkdown(workspaceId, path, localContent),
      onRenameOrMove: (workspaceId, entry, newPath, type) => this.queueRenameOrMove(workspaceId, entry, newPath, type),
      onDeleteEntry: (workspaceId, entry) => this.queueDeleteEntry(workspaceId, entry),
      onRemotePathObserved: (workspaceId, localPath, serverPath) => {
        this.noteRemoteObservedPath(workspaceId, localPath, serverPath);
      }
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
      })
    );
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
      this.app.vault.on("delete", (file) => {
        void this.handleVaultDelete(file);
      })
    );

    this.register(() => {
      this.stopSettingsEventStream();
      if (this.persistHandle !== null) {
        window.clearTimeout(this.persistHandle);
      }

      if (this.explorerDecorationHandle !== null) {
        window.clearTimeout(this.explorerDecorationHandle);
      }

      if (this.logFlushHandle !== null) {
        window.clearTimeout(this.logFlushHandle);
      }

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
    });

    this.recordLog("plugin", "Rolay plugin loaded.");

    await this.bootstrapSync("startup");
  }

  override async onunload(): Promise<void> {
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
    return this.roomList.map((room) => {
      const folderName = this.getResolvedRoomFolderName(room.workspace.id, room.workspace.name);
      const binding = this.getStoredRoomBinding(room.workspace.id);
      const localRoot = getRoomRoot(this.data.settings.syncRoot, folderName);
      const roomSync = getRoomSyncState(this.data.sync, room.workspace.id);
      const runtime = this.roomRuntime.get(room.workspace.id);
      const treeStore = runtime?.treeStore ?? null;
      const markdownEntries = treeStore?.getEntries().filter((entry) => !entry.deleted && entry.kind === "markdown") ?? [];
      const cachedMarkdownCount = markdownEntries.filter((entry) => this.hasPersistedCrdtCache(entry.id)).length;

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
        invite: this.roomInvites.get(room.workspace.id) ?? null
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

  getProfileDraftDisplayName(): string {
    return this.profileDraftDisplayName || this.data.session?.user?.displayName || "";
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

  async loginWithSettings(showNotice = true): Promise<void> {
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
      await this.resumeDownloadedRooms("login");
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
    this.roomList = [...response.workspaces].sort(compareRoomsByName);
    await this.reconcileDownloadedRooms();
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
    await this.refreshRoomSnapshot(room.workspace.id, reason);
    await this.startRoomEventStream(room.workspace.id);
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
    this.adminRoomList = [...response.workspaces].sort(compareRoomsByName);

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

    const response = await this.apiClient.listRoomMembersAsAdmin(targetRoomId);
    this.adminSelectedRoomId = targetRoomId;
    this.adminRoomMembers = [...response.members].sort(compareRoomMembers);
    if (logActivity) {
      this.recordLog("admin", `Loaded ${this.adminRoomMembers.length} member(s) for room ${targetRoomId}.`);
    }
    if (showNotice) {
      new Notice(`Loaded ${this.adminRoomMembers.length} room member(s).`);
    }
    return this.getAdminRoomMembers();
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
    const room = this.requireDownloadedRoom(workspaceId);
    const runtime = this.ensureRoomRuntime(room.workspace.id);

    try {
      const previousEntries = runtime.treeStore.getEntries();
      const snapshot = await this.apiClient.getWorkspaceTree(room.workspace.id);
      runtime.treeStore.applySnapshot(snapshot);
      this.confirmSnapshotPendingCreates(room.workspace.id, snapshot.entries);
      await this.fileBridge.applySnapshot(snapshot, previousEntries);
      this.setRoomSyncState(room.workspace.id, {
        lastCursor: snapshot.cursor,
        lastSnapshotAt: new Date().toISOString()
      });
      this.recordLog(
        "tree",
        `Fetched snapshot for ${snapshot.workspace.name} with ${snapshot.entries.length} entries (${reason}).`
      );
      await this.bootstrapRoomMarkdownCache(room.workspace.id, snapshot.entries, reason);
      this.scheduleBackgroundMarkdownRefresh(
        room.workspace.id,
        "post-snapshot-background-refresh",
        RolayPlugin.ROOM_MARKDOWN_REFRESH_AFTER_SNAPSHOT_MS,
        true
      );
      await this.reconcilePendingMarkdownCreates(room.workspace.id, reason);
      await this.reconcilePendingMarkdownMerges(room.workspace.id, reason);
      await this.persistNow();
      this.updateStatusBar();
      await this.bindActiveMarkdownToCrdt();
    } catch (error) {
      this.handleError("Tree snapshot failed", error);
      throw error;
    }
  }

  async startRoomEventStream(workspaceId: string): Promise<void> {
    const room = this.requireDownloadedRoom(workspaceId);
    const runtime = this.ensureRoomRuntime(room.workspace.id);
    this.stopRoomEventStream(room.workspace.id);

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

    stream.start(room.workspace.id, cursor, {
      onOpen: () => {
        this.recordLog("sse", `Subscribed to room ${room.workspace.id} events.`);
      },
      onEvent: async (event) => {
        runtime.treeStore.recordCursor(event.id);
        this.updateRoomSyncCursor(room.workspace.id, event.id);
        this.schedulePersist();
        this.recordLog("sse", `[${room.workspace.id}] Event ${event.id}: ${event.event}`);
        if (event.event.startsWith("tree.") || event.event.startsWith("blob.")) {
          this.scheduleSnapshotRefresh(room.workspace.id, "event-stream");
        }
      },
      onStatusChange: (status) => {
        runtime.streamStatus = status;
        this.updateStatusBar();
      },
      onError: (error) => {
        this.handleError(`Workspace event stream error (${room.workspace.id})`, error, false);
      }
    });
  }

  stopRoomEventStream(workspaceId: string): void {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    this.clearBackgroundMarkdownRefresh(workspaceId);
    this.clearLockedMarkdownBootstrapRetry(workspaceId, false);
    this.cancelRoomMarkdownBootstrap(workspaceId);
    runtime.eventStream?.stop();
    runtime.eventStream = null;
    runtime.streamStatus = "stopped";
    this.updateStatusBar();
  }

  stopAllRoomEventStreams(): void {
    for (const workspaceId of this.roomRuntime.keys()) {
      this.stopRoomEventStream(workspaceId);
    }
  }

  private startSettingsEventStream(cursor: number | null): void {
    this.stopSettingsEventStream();

    if (!this.getCurrentUser()) {
      return;
    }

    this.settingsEventCursor = cursor;
    const stream = new SettingsEventStream(this.apiClient, (message) => {
      this.recordLog("settings-sse", message);
    });
    this.settingsEventStream = stream;

    stream.start(cursor, {
      onOpen: () => {
        this.recordLog("settings-sse", "Subscribed to settings events.");
      },
      onEvent: async (event) => {
        await this.handleSettingsEventStreamEvent(event);
      },
      onStatusChange: (status) => {
        this.settingsEventStreamStatus = status;
        this.updateStatusBar();
      },
      onError: (error) => {
        this.handleError("Settings event stream error", error, false);
        if (this.shouldRecoverSettingsStream(error)) {
          void this.recoverSettingsEventStream();
        }
      }
    });
  }

  private stopSettingsEventStream(): void {
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
      await this.ensureAuthenticated(true);
      await this.resumeDownloadedRooms(reason);
    } catch (error) {
      this.handleError("Startup sync failed", error, false);
    }
  }

  private async ensureAuthenticated(silent = false): Promise<void> {
    if (this.data.session?.refreshToken) {
      await this.refreshSession(!silent);
      return;
    }

    await this.loginWithSettings(!silent);
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
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    try {
      this.forgetRecentRemoteHintsForLocalPath(file.path, true);
      await this.fileBridge.handleVaultCreate(file);
    } catch (error) {
      this.handleError(`Local create sync failed for ${file.path}`, error, false);
    }
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    try {
      if (await this.revertLockedMarkdownRename(file, oldPath)) {
        await this.bindActiveMarkdownToCrdt();
        return;
      }

      await this.refreshMarkdownContentBeforeRoomExit(file, oldPath);
      this.forgetRecentRemoteHintsForLocalPath(oldPath, true);
      this.forgetRecentRemoteHintsForLocalPath(file.path, true);
      this.handlePendingMarkdownCreateRename(oldPath, file.path);
      this.handlePendingMarkdownMergeRename(oldPath, file.path);
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

      this.forgetRecentRemoteHintsForLocalPath(file.path, true);
      this.clearPendingMarkdownCreate(file.path);
      this.clearPendingMarkdownMergesForLocalPath(file.path);
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

      await this.deactivateRoomDownload(roomId);
      this.recordLog("rooms", `Room ${roomId} is no longer available to the current user. Sync was stopped and the download flag was cleared.`);
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
    if (runtime.snapshotRefreshHandle !== null) {
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
      this.recordLog(
        "crdt",
        `[${workspaceId}] Background markdown refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
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

    this.data.logs = [...this.data.logs.slice(-99), entry];
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

  private async ensurePersistentLogFolderExists(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const folderPath = this.getPersistentLogFolderPath();
    const segments = folderPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (await adapter.exists(currentPath)) {
        continue;
      }

      await adapter.mkdir(currentPath);
    }
  }

  private async trimPersistentLogFileIfNeeded(logFilePath: string): Promise<void> {
    const stat = await this.app.vault.adapter.stat(logFilePath);
    if (!stat || stat.size <= RolayPlugin.MAX_LOG_FILE_BYTES) {
      return;
    }

    const fileContents = await this.app.vault.adapter.read(logFilePath);
    const keptTail = fileContents.slice(-Math.floor(RolayPlugin.MAX_LOG_FILE_BYTES / 2));
    const trimmedContents = `... trimmed older Rolay log lines ...\n${keptTail}`;
    await this.app.vault.adapter.write(logFilePath, trimmedContents);
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

  private getStoredRoomBinding(workspaceId: string): RolayRoomBindingSettings | null {
    return getRoomBindingSettings(this.data.settings, workspaceId);
  }

  private getResolvedRoomFolderName(workspaceId: string, fallbackRoomName: string): string {
    const binding = this.getStoredRoomBinding(workspaceId);
    return normalizeRoomFolderName(binding?.folderName || fallbackRoomName);
  }

  private getDownloadedFolderName(workspaceId: string): string | null {
    const room = this.roomList.find((item) => item.workspace.id === workspaceId);
    if (!room) {
      return null;
    }

    const binding = this.getStoredRoomBinding(workspaceId);
    if (!binding?.downloaded) {
      return null;
    }

    return this.getResolvedRoomFolderName(workspaceId, room.workspace.name);
  }

  private getDownloadedRooms(): DownloadedRoomDescriptor[] {
    return this.roomList
      .filter((room) => Boolean(this.getStoredRoomBinding(room.workspace.id)?.downloaded))
      .map((room) => ({
        workspaceId: room.workspace.id,
        folderName: this.getResolvedRoomFolderName(room.workspace.id, room.workspace.name)
      }));
  }

  private ensureRoomRuntime(workspaceId: string): RoomRuntimeState {
    const existing = this.roomRuntime.get(workspaceId);
    if (existing) {
      return existing;
    }

    const runtime: RoomRuntimeState = {
      treeStore: new TreeStore(),
      eventStream: null,
      streamStatus: "stopped",
      snapshotRefreshHandle: null,
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

  private refreshExplorerLoadingDecorations(): void {
    const container = this.app.workspace.containerEl;
    if (!container) {
      return;
    }

    const lockedPaths = new Set<string>();
    for (const runtime of this.roomRuntime.values()) {
      for (const lockedPath of runtime.markdownBootstrap.lockedLocalPaths) {
        lockedPaths.add(lockedPath);
      }
    }

    const pathElements = container.querySelectorAll<HTMLElement>("[data-path]");
    for (const element of pathElements) {
      element.classList.remove("rolay-loading-path", "rolay-loading-ancestor");

      const dataPath = element.getAttribute("data-path");
      if (!dataPath) {
        continue;
      }

      const normalizedPath = normalizePath(dataPath);
      const exactMatch = lockedPaths.has(normalizedPath);
      const descendantMatch = !exactMatch && [...lockedPaths].some((lockedPath) => {
        return lockedPath.startsWith(`${normalizedPath}/`);
      });

      if (exactMatch || descendantMatch) {
        element.classList.add("rolay-loading-path");
      }

      if (descendantMatch) {
        element.classList.add("rolay-loading-ancestor");
      }
    }
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
    this.pendingLocalDeletes.add(this.buildPendingRoomPathKey(workspaceId, path));
  }

  private clearPendingLocalDelete(workspaceId: string, path: string): void {
    this.pendingLocalDeletes.delete(this.buildPendingRoomPathKey(workspaceId, path));
  }

  private hasPendingLocalDelete(workspaceId: string, path: string): boolean {
    return this.pendingLocalDeletes.has(this.buildPendingRoomPathKey(workspaceId, path));
  }

  private clearPendingRoomPathsForWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}::`;
    for (const key of [...this.pendingLocalCreates.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingLocalCreates.delete(key);
      }
    }

    for (const key of [...this.pendingLocalDeletes]) {
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

    const currentUser = this.data.session?.user ?? null;
    const downloadedRoomCount = this.getDownloadedRooms().length;
    const activeStreamCount = [...this.roomRuntime.values()].filter((runtime) => runtime.streamStatus === "open").length;
    const crdt = this.crdtManager?.getState();
    const authLabel = currentUser
      ? `${currentUser.username} (${currentUser.globalRole}${currentUser.isAdmin ? ", admin" : ""})`
      : "signed-out";
    const crdtLabel = crdt ? crdt.status : "idle";
    this.statusBarEl.setText(
      `Rolay: ${authLabel} | rooms ${downloadedRoomCount} downloaded | SSE ${activeStreamCount} open | CRDT ${crdtLabel}`
    );
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
      this.data.session = {
        accessToken: "",
        refreshToken: "",
        user,
        authenticatedAt: new Date().toISOString()
      };
    } else {
      this.data.session = {
        ...this.data.session,
        user
      };
    }

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
    }
  }

  private clearPendingMarkdownCreate(localPath: string): void {
    const normalizedLocalPath = normalizePath(localPath);
    if (!(normalizedLocalPath in this.data.pendingMarkdownCreates)) {
      return;
    }

    delete this.data.pendingMarkdownCreates[normalizedLocalPath];
    this.schedulePersist();
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
  }

  private clearPendingMarkdownMerge(entryId: string): void {
    if (!(entryId in this.data.pendingMarkdownMerges)) {
      return;
    }

    delete this.data.pendingMarkdownMerges[entryId];
    this.schedulePersist();
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
    if (targets.length === 0) {
      return;
    }

    const targetsByEntryId = new Map(
      targets.map((target) => [target.entry.id, target] as const)
    );
    const metadataResponse = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
      entryIds: [...targetsByEntryId.keys()],
      includeState: false
    });

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

      const message = error instanceof Error ? error.message : String(error);
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
      if (this.app.vault.getAbstractFileByPath(roomRoot)) {
        continue;
      }

      await this.deactivateRoomDownload(room.workspaceId, false);
      this.recordLog(
        "rooms",
        `Detached room ${room.workspaceId} because the local folder ${roomRoot} is missing. Remote room content was left untouched.`
      );
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

  private async queueCreateFolder(workspaceId: string, path: string): Promise<void> {
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

  private async queueRenameOrMove(
    workspaceId: string,
    entry: FileEntry,
    newPath: string,
    type: "rename_entry" | "move_entry"
  ): Promise<void> {
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
        return;
      }

      this.optimisticDeleteRoomEntry(workspaceId, entry.id);
    } catch (error) {
      this.scheduleSnapshotRefresh(workspaceId, "delete-recovery");
      throw error;
    } finally {
      this.clearPendingLocalDelete(workspaceId, entry.path);
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
    inviteEnabled
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

function getFileName(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

function getParentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
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
