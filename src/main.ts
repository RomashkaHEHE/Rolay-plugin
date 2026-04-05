import { MarkdownView, Notice, Plugin, TFile, normalizePath, type TAbstractFile } from "obsidian";
import * as Y from "yjs";
import { RolayApiClient, RolayApiError } from "./api/client";
import { FileBridge } from "./obsidian/file-bridge";
import { createMarkdownTextState, CrdtSessionManager } from "./realtime/crdt-session";
import { createSharedPresenceExtension } from "./realtime/shared-presence";
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
  ManagedUser,
  RoomListItem,
  RoomMember,
  User
} from "./types/protocol";
import { openTextInputModal } from "./ui/text-input-modal";
import { decodeBase64, encodeBase64 } from "./utils/base64";

interface RoomRuntimeState {
  treeStore: TreeStore;
  eventStream: WorkspaceEventStream | null;
  streamStatus: WorkspaceEventStreamStatus;
  snapshotRefreshHandle: number | null;
  markdownBootstrap: RoomMarkdownBootstrapState;
}

interface RoomMarkdownBootstrapState {
  status: "idle" | "loading" | "ready" | "error";
  totalTargets: number;
  completedTargets: number;
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
  private persistHandle: number | null = null;
  private statusBarEl!: HTMLElement;
  private roomList: RoomListItem[] = [];
  private adminRoomList: AdminRoomListItem[] = [];
  private managedUsers: ManagedUser[] = [];
  private adminSelectedRoomId = "";
  private adminRoomMembers: RoomMember[] = [];
  private logFlushHandle: number | null = null;
  private logFileWrite = Promise.resolve();
  private readonly pendingLogLines: string[] = [];
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

    this.addSettingTab(new RolaySettingTab(this.app, this));
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
      if (this.persistHandle !== null) {
        window.clearTimeout(this.persistHandle);
      }

      if (this.logFlushHandle !== null) {
        window.clearTimeout(this.logFlushHandle);
      }

      for (const runtime of this.roomRuntime.values()) {
        if (runtime.snapshotRefreshHandle !== null) {
          window.clearTimeout(runtime.snapshotRefreshHandle);
        }
      }
    });

    this.recordLog("plugin", "Rolay plugin loaded.");

    await this.bootstrapSync("startup");
  }

  override async onunload(): Promise<void> {
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

  async fetchCurrentUser(showNotice = false): Promise<User> {
    const response = await this.apiClient.getCurrentUser();
    await this.applySessionUser(response.user);
    await this.refreshPostAuthState();
    this.recordLog("auth", `Loaded current user ${response.user.username}.`);
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

  async refreshRooms(showNotice = false): Promise<RoomListItem[]> {
    const response = await this.apiClient.listRooms();
    this.roomList = [...response.workspaces].sort(compareRoomsByName);
    await this.reconcileDownloadedRooms();
    await this.reconcileLocalRoomFolders();
    this.reconcileInviteCache();
    this.recordLog("rooms", `Loaded ${this.roomList.length} room(s).`);
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

  async refreshRoomInvite(workspaceId: string, showNotice = true): Promise<InviteState> {
    const room = this.requireOwnerRoom(workspaceId);
    const response = await this.apiClient.getRoomInvite(room.workspace.id);
    this.roomInvites.set(room.workspace.id, response.invite);
    this.patchInviteEnabled(room.workspace.id, response.invite.enabled);
    this.recordLog("invite", `Loaded invite state for ${room.workspace.id}.`);
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

  async refreshManagedUsers(showNotice = false): Promise<ManagedUser[]> {
    this.requireAdmin();
    const response = await this.apiClient.listManagedUsers();
    this.managedUsers = [...response.users].sort((left, right) => left.username.localeCompare(right.username));
    this.recordLog("admin", `Loaded ${this.managedUsers.length} managed user(s).`);
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

  async refreshAdminRooms(showNotice = false): Promise<AdminRoomListItem[]> {
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

    this.recordLog("admin", `Loaded ${this.adminRoomList.length} room(s) in admin scope.`);
    if (showNotice) {
      new Notice(`Loaded ${this.adminRoomList.length} admin room(s).`);
    }
    return this.getAdminRooms();
  }

  async refreshAdminRoomMembers(
    showNotice = false,
    roomId = this.adminSelectedRoomId
  ): Promise<RoomMember[]> {
    this.requireAdmin();

    const targetRoomId = roomId.trim();
    if (!targetRoomId) {
      throw this.notifyError("Select an admin room first.");
    }

    const response = await this.apiClient.listRoomMembersAsAdmin(targetRoomId);
    this.adminSelectedRoomId = targetRoomId;
    this.adminRoomMembers = [...response.members].sort(compareRoomMembers);
    this.recordLog("admin", `Loaded ${this.adminRoomMembers.length} member(s) for room ${targetRoomId}.`);
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

  async bindActiveMarkdownToCrdt(): Promise<void> {
    try {
      const activeFile = this.app.workspace.getActiveFile();
      await this.crdtManager.bindToFile(activeFile);
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
    this.updateStatusBar();
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    try {
      await this.fileBridge.handleVaultCreate(file);
    } catch (error) {
      this.handleError(`Local create sync failed for ${file.path}`, error, false);
    }
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    try {
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

  private async refreshPostAuthState(): Promise<void> {
    try {
      await this.refreshRooms(false);
    } catch (error) {
      this.handleError("Room list refresh failed", error, false);
    }

    if (this.data.session?.user?.isAdmin) {
      try {
        await this.refreshManagedUsers(false);
      } catch (error) {
        this.handleError("Admin user list refresh failed", error, false);
      }

      try {
        await this.refreshAdminRooms(false);
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
      throw this.notifyError("Download the room folder first.");
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
      markdownBootstrap: {
        status: "idle",
        totalTargets: 0,
        completedTargets: 0,
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
    this.clearPendingLocalCreate(workspaceId, serverPath);
    this.clearPendingMarkdownCreate(localPath);
  }

  private wasPathRecentlyObservedAsRemote(workspaceId: string, localPath: string): boolean {
    return this.recentRemoteObservedPaths.has(this.buildRemoteObservedPathKey(workspaceId, localPath));
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

    const runtime = this.roomRuntime.get(workspaceId);
    if (runtime && runtime.snapshotRefreshHandle !== null) {
      window.clearTimeout(runtime.snapshotRefreshHandle);
    }

    this.roomRuntime.delete(workspaceId);
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
      return `${cachedMarkdownCount}/${markdownEntryCount} cached`;
    }

    if (bootstrap.status === "loading") {
      return `bootstrapping ${cachedMarkdownCount}/${markdownEntryCount} cached (${bootstrap.completedTargets}/${bootstrap.totalTargets} stored)`;
    }

    if (bootstrap.status === "error") {
      return `partial ${cachedMarkdownCount}/${markdownEntryCount} cached (${bootstrap.lastError ?? "bootstrap error"})`;
    }

    return `${cachedMarkdownCount}/${markdownEntryCount} cached`;
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
    runtime.markdownBootstrap.lastError = null;
  }

  private async bootstrapRoomMarkdownCache(
    workspaceId: string,
    entries: FileEntry[],
    reason: string
  ): Promise<void> {
    const runtime = this.roomRuntime.get(workspaceId);
    if (!runtime) {
      return;
    }

    const markdownEntries = entries.filter((entry) => !entry.deleted && entry.kind === "markdown");
    const uncachedEntries = markdownEntries.filter((entry) => !this.hasPersistedCrdtCache(entry.id));

    if (runtime.markdownBootstrap.status === "loading") {
      runtime.markdownBootstrap.rerunRequested = true;
      return;
    }

    runtime.markdownBootstrap.runToken += 1;
    const runToken = runtime.markdownBootstrap.runToken;
    runtime.markdownBootstrap.rerunRequested = false;
    runtime.markdownBootstrap.totalTargets = uncachedEntries.length;
    runtime.markdownBootstrap.completedTargets = 0;
    runtime.markdownBootstrap.lastRunAt = new Date().toISOString();
    runtime.markdownBootstrap.lastError = null;
    runtime.markdownBootstrap.status = uncachedEntries.length > 0 ? "loading" : "ready";
    this.updateStatusBar();

    if (uncachedEntries.length === 0) {
      return;
    }

    this.recordLog(
      "crdt",
      `[${workspaceId}] Bootstrapping CRDT cache for ${uncachedEntries.length} markdown document(s) via HTTP (${reason}).`
    );

    try {
      const response = await this.apiClient.getWorkspaceMarkdownBootstrap(workspaceId, {
        entryIds: uncachedEntries.map((entry) => entry.id)
      });
      if (runtime.markdownBootstrap.runToken !== runToken) {
        return;
      }

      if (response.encoding !== "base64") {
        throw new Error(`Unsupported markdown bootstrap encoding: ${response.encoding}`);
      }

      const responseByEntryId = new Map(response.documents.map((document) => [document.entryId, document]));
      for (const entry of uncachedEntries) {
        const document = responseByEntryId.get(entry.id);
        if (!document) {
          continue;
        }

        const normalizedState = normalizeBootstrapState(document.state);
        const localPath = this.fileBridge.toLocalPath(workspaceId, entry.path) ?? entry.path;
        this.persistCrdtState(entry.id, localPath, normalizedState);
        runtime.markdownBootstrap.completedTargets += 1;
      }

      const missingEntryCount = uncachedEntries.length - runtime.markdownBootstrap.completedTargets;
      runtime.markdownBootstrap.lastError = missingEntryCount > 0
        ? `server returned ${response.documents.length}/${uncachedEntries.length} bootstrap document(s)`
        : null;
      runtime.markdownBootstrap.status = missingEntryCount > 0 ? "error" : "ready";
      this.updateStatusBar();

      if (missingEntryCount === 0) {
        this.recordLog(
          "crdt",
          `[${workspaceId}] HTTP markdown bootstrap stored ${runtime.markdownBootstrap.completedTargets} document(s).`
        );
      } else {
        this.recordLog(
          "crdt",
          `[${workspaceId}] HTTP markdown bootstrap stored ${runtime.markdownBootstrap.completedTargets}/${uncachedEntries.length} document(s).`,
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
      await this.bootstrapRoomMarkdownCache(workspaceId, runtime.treeStore.getEntries(), "rerun");
    }
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
