import {
  App,
  Notice,
  PluginSettingTab,
  setIcon
} from "obsidian";
import type RolayPlugin from "../main";
import type {
  AdminRoomListItem,
  ManagedUser,
  ManagedGlobalRole,
  RoomMember,
  User,
  WorkspaceRole
} from "../types/protocol";
import { openTextInputModal } from "../ui/text-input-modal";
import type { RolayPluginSettings } from "./data";

type SettingsView = "account" | "general" | "rooms" | "admin";
type StatusSnapshot = ReturnType<RolayPlugin["getStatusSnapshot"]>;
type RoomCardState = ReturnType<RolayPlugin["getRoomCardStates"]>[number];

interface CardElements {
  card: HTMLDivElement;
  body: HTMLDivElement;
}

export class RolaySettingTab extends PluginSettingTab {
  private readonly rolay: RolayPlugin;
  private activeView: SettingsView = "rooms";
  private activeRoomId: string | null = null;
  private isVisible = false;
  private renderHandle: number | null = null;
  private lastRenderKey: string | null = null;
  private resetScrollOnNextRender = false;

  constructor(app: App, plugin: RolayPlugin) {
    super(app, plugin);
    this.rolay = plugin;
  }

  override display(): void {
    const wasVisible = this.isVisible;
    this.isVisible = true;

    if (!wasVisible) {
      void this.rolay.activateSettingsPanelRealtime();
    }

    this.render();
  }

  override hide(): void {
    this.isVisible = false;
    this.rolay.deactivateSettingsPanelRealtime();

    if (this.renderHandle !== null) {
      window.clearTimeout(this.renderHandle);
      this.renderHandle = null;
    }

    super.hide();
  }

  requestRender(): void {
    if (!this.isVisible || this.renderHandle !== null) {
      return;
    }

    this.renderHandle = window.setTimeout(() => {
      this.renderHandle = null;
      if (!this.isVisible) {
        return;
      }

      if (this.hasFocusedTextInput()) {
        this.requestRender();
        return;
      }

      this.render();
    }, 120);
  }

  private render(): void {
    const { containerEl } = this;
    const settings = this.rolay.getSettings();
    const status = this.rolay.getStatusSnapshot();
    const currentUser = this.rolay.getCurrentUser();
    const isAdmin = Boolean(currentUser?.isAdmin);
    const roomCards = this.rolay.getRoomCardStates();
    const scrollHost = this.getScrollHost();

    if (!currentUser && this.activeView === "rooms") {
      this.activeView = "account";
    }

    if (!isAdmin && this.activeView === "admin") {
      this.activeView = currentUser ? "rooms" : "account";
    }

    let renderKey = this.getRenderKey();
    const shouldRestoreScroll = !this.resetScrollOnNextRender && this.lastRenderKey === renderKey;
    const preservedScrollTop = shouldRestoreScroll ? scrollHost?.scrollTop ?? 0 : 0;

    containerEl.empty();

    const shell = containerEl.createDiv({ cls: "rolay-settings-shell" });
    this.renderHero(shell, currentUser);

    if (this.activeRoomId) {
      const activeRoom = roomCards.find((room) => room.room.workspace.id === this.activeRoomId) ?? null;
      if (!activeRoom) {
        this.activeRoomId = null;
        this.activeView = "rooms";
        renderKey = this.getRenderKey();
      } else {
        this.renderRoomDetailView(shell, activeRoom);
        this.finishRender(scrollHost, renderKey, preservedScrollTop);
        return;
      }
    }

    this.renderTabSwitcher(shell, isAdmin);

    switch (this.activeView) {
      case "account":
        this.renderAccountView(shell, settings, currentUser);
        break;
      case "rooms":
        this.renderRoomsView(shell, currentUser, roomCards);
        break;
      case "admin":
        if (isAdmin) {
          this.renderAdminView(shell, currentUser);
          break;
        }
        this.activeView = "rooms";
        this.renderRoomsView(shell, currentUser, roomCards);
        renderKey = this.getRenderKey();
        break;
      case "general":
      default:
        this.renderGeneralView(shell, settings, status);
    }

    this.finishRender(scrollHost, renderKey, preservedScrollTop);
  }

  private renderHero(containerEl: HTMLElement, _currentUser: User | null): void {
    const heroEl = containerEl.createDiv({ cls: "rolay-settings-hero" });
    heroEl.createEl("div", {
      cls: "rolay-settings-brand",
      text: "Rolay"
    });
  }

  private renderTabSwitcher(containerEl: HTMLElement, isAdmin: boolean): void {
    const tabsEl = containerEl.createDiv({ cls: "rolay-settings-tabs" });
    if (this.rolay.getCurrentUser()) {
      this.createTabButton(tabsEl, "Rooms", "rooms");
    }
    this.createTabButton(tabsEl, "Account", "account");
    this.createTabButton(tabsEl, "General", "general");
    if (isAdmin) {
      this.createTabButton(tabsEl, "Admin", "admin");
    }
  }

  private createTabButton(containerEl: HTMLElement, label: string, view: SettingsView): void {
    const button = containerEl.createEl("button", {
      cls: "rolay-settings-tab-button",
      text: label
    });

    if (this.activeView === view) {
      button.classList.add("mod-cta");
    }

    button.addEventListener("click", () => {
      if (this.activeView === view && this.activeRoomId === null) {
        return;
      }

      this.resetScrollOnNextRender = true;
      this.activeRoomId = null;
      this.activeView = view;
      this.render();
    });
  }

  private renderAccountView(
    containerEl: HTMLElement,
    settings: RolayPluginSettings,
    currentUser: User | null
  ): void {
    const grid = this.createGrid(containerEl);

    if (!currentUser) {
      const loginCard = this.createCard(grid, "Log In");
      this.createInputField(loginCard.body, {
        label: "Username",
        value: settings.username,
        placeholder: "username",
        onChange: async (value) => {
          await this.rolay.updateSettings({
            username: value.trim()
          });
        }
      });
      this.createInputField(loginCard.body, {
        label: "Password",
        type: "password",
        value: settings.password,
        placeholder: "password",
        onChange: async (value) => {
          await this.rolay.updateSettings({
            password: value
          });
        }
      });

      const actions = this.createActionRow(loginCard.body);
      this.createActionButton(actions, "Login", "mod-cta", async () => {
        await this.rolay.loginWithSettings();
        this.activeView = "rooms";
        this.resetScrollOnNextRender = true;
        await this.rolay.activateSettingsPanelRealtime();
        this.requestRender();
      });
      return;
    }

    const overviewCard = this.createCard(grid, "Account");
    const overviewBadges = overviewCard.body.createDiv({ cls: "rolay-settings-badges" });
    this.createBadge(overviewBadges, currentUser.isAdmin ? "Admin" : "User", currentUser.isAdmin ? "accent" : "muted");
    this.createBadge(overviewBadges, currentUser.globalRole, "ready");
    this.createInfoBlock(overviewCard.body, [
      ["Login", currentUser.username],
      ["Display name", currentUser.displayName || "not set"],
      ["Role", currentUser.isAdmin ? "admin" : "user"]
    ]);
    const overviewActions = this.createActionRow(overviewCard.body);
    this.createActionButton(overviewActions, "Logout", "mod-warning", async () => {
      await this.rolay.logout();
      new Notice("Rolay session cleared.");
      this.activeRoomId = null;
      this.activeView = "account";
      this.resetScrollOnNextRender = true;
      this.rolay.deactivateSettingsPanelRealtime();
      this.requestRender();
    });

    const profileCard = this.createCard(grid, "Display Name", "Shown to collaborators in shared cursors and presence.");
    this.createInputField(profileCard.body, {
      value: this.rolay.getProfileDraftDisplayName(),
      placeholder: currentUser.displayName || "Display name",
      onChange: (value) => {
        this.rolay.setProfileDraftDisplayName(value);
      }
    });
    const profileActions = this.createActionRow(profileCard.body);
    this.createActionButton(profileActions, "Save", "mod-cta", async () => {
      await this.rolay.updateOwnDisplayName();
      this.requestRender();
    });

    const passwordDraft = this.rolay.getPasswordChangeDraft();
    const securityCard = this.createCard(grid, "Change Password");
    this.createInputField(securityCard.body, {
      label: "Current password",
      type: "password",
      value: passwordDraft.currentPassword,
      placeholder: "current password",
      onChange: (value) => {
        this.rolay.updatePasswordChangeDraft({
          currentPassword: value
        });
      }
    });
    this.createInputField(securityCard.body, {
      label: "New password",
      type: "password",
      value: passwordDraft.newPassword,
      placeholder: "new password",
      onChange: (value) => {
        this.rolay.updatePasswordChangeDraft({
          newPassword: value
        });
      }
    });
    this.createInputField(securityCard.body, {
      label: "Confirm new password",
      type: "password",
      value: passwordDraft.confirmPassword,
      placeholder: "repeat new password",
      onChange: (value) => {
        this.rolay.updatePasswordChangeDraft({
          confirmPassword: value
        });
      }
    });
    const securityActions = this.createActionRow(securityCard.body);
    this.createActionButton(securityActions, "Change password", "mod-cta", async () => {
      await this.rolay.changeOwnPassword();
      this.requestRender();
    });
  }

  private renderGeneralView(
    containerEl: HTMLElement,
    settings: RolayPluginSettings,
    status: StatusSnapshot
  ): void {
    const grid = this.createGrid(containerEl);

    const rootCard = this.createCard(grid, "Root Folder", "Base vault folder under which installed room folders are created.");
    this.createInputField(rootCard.body, {
      value: settings.syncRoot,
      placeholder: "Rolay",
      onChange: async (value) => {
        await this.rolay.updateSettings({
          syncRoot: value.trim()
        });
      }
    });

    const debugCard = this.createCard(grid, "Debug");
    const debugDetails = debugCard.body.createEl("details", { cls: "rolay-settings-details" });
    debugDetails.createEl("summary", {
      cls: "rolay-settings-details-summary",
      text: "Show runtime details"
    });
    const debugBody = debugDetails.createDiv({ cls: "rolay-settings-details-body" });
    this.createInfoBlock(debugBody, [
      ["Authenticated user", status.userLabel],
      ["Global role", status.globalRoleLabel],
      ["Admin mode", status.isAdmin ? "enabled" : "disabled"],
      ["Installed rooms", String(status.downloadedRoomCount)],
      ["Open streams", String(status.activeStreamCount)],
      ["Root folder", settings.syncRoot || "/"],
      ["Log file", status.persistentLogPath],
      ["CRDT session", status.crdtLabel]
    ]);
    debugBody.createEl("pre", {
      cls: "rolay-settings-log",
      text: status.recentLogs.length > 0 ? status.recentLogs.join("\n") : "No sync activity recorded yet."
    });
  }

  private renderRoomsView(
    containerEl: HTMLElement,
    currentUser: User | null,
    rooms: RoomCardState[]
  ): void {
    const topGrid = this.createGrid(containerEl);

    if (!currentUser) {
      const signedOutCard = this.createCard(
        topGrid,
        "Rooms",
        "Sign in first to create rooms, join by invite, and manage room folders."
      );
      signedOutCard.body.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "Log into Rolay to view and configure rooms."
      });
      return;
    }

    if (this.rolay.canCurrentUserCreateRooms()) {
      const createRoomDraft = this.rolay.getCreateRoomDraft();
      const createCard = this.createCard(topGrid, "Create Room");
      this.createInputField(createCard.body, {
        value: createRoomDraft.name,
        placeholder: "Physics Lab",
        onChange: (value) => {
          this.rolay.updateCreateRoomDraft({
            name: value
          });
        }
      });
      const createActions = this.createActionRow(createCard.body);
      this.createActionButton(createActions, "Create room", "mod-cta", async () => {
        await this.rolay.createRoomFromDraft();
        this.requestRender();
      });
    }

    const joinRoomDraft = this.rolay.getJoinRoomDraft();
    const joinCard = this.createCard(topGrid, "Join by Invite");
    this.createInputField(joinCard.body, {
      value: joinRoomDraft.code,
      placeholder: "paste invite key",
      onChange: (value) => {
        this.rolay.updateJoinRoomDraft({
          code: value
        });
      }
    });
    const joinActions = this.createActionRow(joinCard.body);
    this.createActionButton(joinActions, "Join room", "", async () => {
      await this.rolay.joinRoomFromDraft();
      this.requestRender();
    });

    const roomsCard = this.createCard(topGrid, "Rooms");
    this.renderRoomList(roomsCard.body, rooms);
  }

  private renderRoomList(containerEl: HTMLElement, rooms: RoomCardState[]): void {
    if (rooms.length === 0) {
      containerEl.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "No rooms available."
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "rolay-settings-list" });
    for (const room of rooms) {
      const itemEl = listEl.createDiv({ cls: "rolay-settings-list-item" });
      const titleWrap = itemEl.createDiv({ cls: "rolay-settings-list-title-wrap" });
      titleWrap.createDiv({
        cls: "rolay-settings-list-title",
        text: room.room.workspace.name
      });

      const actionButton = itemEl.createEl("button", {
        cls: "rolay-settings-icon-button",
        attr: {
          "aria-label": `Open settings for ${room.room.workspace.name}`,
          title: "Room settings"
        }
      });
      setIcon(actionButton, "settings");
      actionButton.addEventListener("click", () => {
        this.resetScrollOnNextRender = true;
        this.activeView = "rooms";
        this.activeRoomId = room.room.workspace.id;
        this.render();
      });
    }
  }

  private renderRoomDetailView(containerEl: HTMLElement, room: RoomCardState): void {
    const pageTop = containerEl.createDiv({ cls: "rolay-settings-page-top" });
    const navRow = pageTop.createDiv({ cls: "rolay-settings-page-nav" });
    const backButton = navRow.createEl("button", {
      cls: "rolay-settings-icon-button rolay-settings-back-button",
      attr: {
        "aria-label": "Back to rooms",
        title: "Back to rooms"
      }
    });
    setIcon(backButton, "arrow-left");
    backButton.addEventListener("click", () => {
      this.resetScrollOnNextRender = true;
      this.activeRoomId = null;
      this.activeView = "rooms";
      this.render();
    });
    const breadcrumb = navRow.createDiv({ cls: "rolay-settings-breadcrumb" });
    breadcrumb.createSpan({
      cls: "rolay-settings-page-nav-label",
      text: "Rooms"
    });
    breadcrumb.createSpan({
      cls: "rolay-settings-breadcrumb-separator",
      text: ">"
    });
    breadcrumb.createSpan({
      cls: "rolay-settings-breadcrumb-current",
      text: room.room.workspace.name
    });

    const badges = pageTop.createDiv({ cls: "rolay-settings-badges" });
    this.createBadge(badges, room.downloaded ? "Installed" : "Not installed", room.downloaded ? "ready" : "muted");
    this.createBadge(
      badges,
      room.downloaded
        ? room.streamStatus === "open"
          ? "Connected"
          : room.streamStatus === "stopped"
            ? "Disconnected"
            : "Connecting"
        : "Offline",
      !room.downloaded
        ? "muted"
        : room.streamStatus === "open"
          ? "ready"
          : room.streamStatus === "stopped"
            ? "muted"
            : "accent"
    );
    this.createBadge(
      badges,
      room.room.membershipRole === "owner" ? "Owner" : "Member",
      room.room.membershipRole === "owner" ? "accent" : "muted"
    );

    const grid = this.createGrid(containerEl);

    const infoCard = this.createCard(grid, "Room Info", "Stable room identity is always based on the room ID, not on the display name.");
    this.createInfoBlock(infoCard.body, [
      ["Name", room.room.workspace.name],
      ["Membership", room.room.membershipRole],
      ["Members", String(room.room.memberCount)],
      ["Connection", room.downloaded ? room.streamStatus : "not available"],
      ["Markdown preload", room.crdtCacheLabel]
    ]);
    this.addCopyableInfoLine(infoCard.body, "Room ID", room.room.workspace.id);

    const folderCard = this.createCard(
      grid,
      "Local Folder",
      room.downloaded
        ? "This only changes the local vault binding. It does not rename the room on the server."
        : "Install the room into a vault folder. Installation is blocked if that folder already exists."
    );
    this.createInfoBlock(folderCard.body, [
      ["Folder", room.downloaded ? room.folderName : "not installed"],
      ["Folder path", room.downloaded ? room.localRoot : "not installed"]
    ]);
    const folderActions = this.createActionRow(folderCard.body);
    this.createActionButton(
      folderActions,
      room.downloaded ? "Rename folder" : "Install folder",
      room.downloaded ? "" : "mod-cta",
      async () => {
        const nextFolderName = await openTextInputModal(this.app, {
          title: room.downloaded ? "Rename Rolay Room Folder" : "Install Rolay Room",
          label: "Local folder name",
          placeholder: room.room.workspace.name,
          initialValue: room.folderName || room.room.workspace.name,
          submitText: room.downloaded ? "Save" : "Install",
          description: room.downloaded
            ? "This only changes the local vault folder binding."
            : "Installation is blocked if the target folder already exists."
        });
        if (!nextFolderName) {
          return;
        }

        if (room.downloaded) {
          await this.rolay.renameInstalledRoomFolder(room.room.workspace.id, nextFolderName);
        } else {
          await this.rolay.installRoom(room.room.workspace.id, nextFolderName);
        }

        this.requestRender();
      }
    );

    const syncCard = this.createCard(
      grid,
      "Sync",
      room.downloaded
        ? "Connect or disconnect live sync for this local room folder."
        : "Install the folder first before live room sync can be enabled."
    );
    this.createInfoBlock(syncCard.body, [
      ["Status", room.downloaded ? room.streamStatus : "not installed"],
      ["Last snapshot", room.lastSnapshotLabel],
      ["Last cursor", room.lastCursorLabel]
    ]);
    if (room.downloaded) {
      const syncActions = this.createActionRow(syncCard.body);
      const isConnected = room.streamStatus !== "stopped";
      this.createActionButton(syncActions, isConnected ? "Disconnect" : "Connect", isConnected ? "" : "mod-cta", async () => {
        if (isConnected) {
          await this.rolay.disconnectRoom(room.room.workspace.id);
        } else {
          await this.rolay.connectRoom(room.room.workspace.id, true, "settings-connect");
        }
        this.requestRender();
      });
    }

    if (room.room.membershipRole === "owner") {
      const inviteCard = this.createCard(grid, "Invites", "Owner-only controls for the current invite key.");
      const inviteEnabled = room.invite?.enabled ?? room.room.inviteEnabled;
      this.createInfoBlock(inviteCard.body, [
        ["Enabled", String(inviteEnabled)],
        ["Updated", this.formatDateTime(room.invite?.updatedAt) ?? "syncing..."]
      ]);
      this.addCopyableInfoLine(
        inviteCard.body,
        "Invite key",
        room.invite?.code ?? "syncing...",
        Boolean(room.invite?.code)
      );
      const inviteActions = this.createActionRow(inviteCard.body);
      this.createActionButton(inviteActions, inviteEnabled ? "Disable invite" : "Enable invite", "", async () => {
        await this.rolay.setRoomInviteEnabled(room.room.workspace.id, !inviteEnabled);
        this.requestRender();
      });
      this.createActionButton(inviteActions, "Regenerate", "mod-warning", async () => {
        await this.rolay.regenerateRoomInvite(room.room.workspace.id);
        this.requestRender();
      });
    }
  }

  private renderAdminView(containerEl: HTMLElement, currentUser: User | null): void {
    const managedUserDraft = this.rolay.getManagedUserDraft();
    const adminRoomDraft = this.rolay.getAdminRoomMemberDraft();
    const adminRooms = this.rolay.getAdminRooms();
    const adminRoomMembers = this.rolay.getAdminRoomMembers();
    const adminSelectedRoomId = this.rolay.getAdminSelectedRoomId();
    const selectedAdminRoom = adminRooms.find((room) => room.workspace.id === adminSelectedRoomId) ?? null;

    const grid = this.createGrid(containerEl);

    const createUserCard = this.createCard(grid, "Create User");
    this.createInputField(createUserCard.body, {
      label: "Username",
      value: managedUserDraft.username,
      placeholder: "student1",
      onChange: (value) => {
        this.rolay.updateManagedUserDraft({
          username: value.trim()
        });
      }
    });
    this.createInputField(createUserCard.body, {
      label: "Temporary password",
      type: "password",
      value: managedUserDraft.password,
      placeholder: "temporary-password",
      onChange: (value) => {
        this.rolay.updateManagedUserDraft({
          password: value
        });
      }
    });
    this.createInputField(createUserCard.body, {
      label: "Display name",
      value: managedUserDraft.displayName ?? "",
      placeholder: "Student One",
      onChange: (value) => {
        this.rolay.updateManagedUserDraft({
          displayName: value
        });
      }
    });
    this.createSelectField(createUserCard.body, {
      label: "Managed role",
      value: managedUserDraft.globalRole ?? "reader",
      options: [
        ["writer", "writer"],
        ["reader", "reader"]
      ],
      onChange: (value) => {
        this.rolay.updateManagedUserDraft({
          globalRole: value as ManagedGlobalRole
        });
      }
    });
    const createUserActions = this.createActionRow(createUserCard.body);
    this.createActionButton(createUserActions, "Create user", "mod-cta", async () => {
      await this.rolay.createManagedUserFromDraft();
      this.requestRender();
    });

    const usersCard = this.createCard(grid, "Users");
    this.renderManagedUsers(usersCard.body, this.rolay.getManagedUsers(), currentUser?.id ?? null);

    const roomsCard = this.createCard(grid, "Rooms");
    this.renderAdminRooms(roomsCard.body, adminRooms, adminSelectedRoomId);

    const selectedRoomCard = this.createCard(grid, selectedAdminRoom ? "Selected Room" : "Room Members");

    if (!selectedAdminRoom) {
      selectedRoomCard.body.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "Select a room from the list to view members and add users."
      });
      return;
    }

    const selectedRoomBadges = selectedRoomCard.body.createDiv({ cls: "rolay-settings-badges" });
    this.createBadge(selectedRoomBadges, `${selectedAdminRoom.memberCount} members`, "ready");
    this.createBadge(selectedRoomBadges, `${selectedAdminRoom.ownerCount} owners`, "accent");
    this.createBadge(
      selectedRoomBadges,
      selectedAdminRoom.inviteEnabled ? "Invite on" : "Invite off",
      selectedAdminRoom.inviteEnabled ? "ready" : "muted"
    );

    this.createInfoBlock(selectedRoomCard.body, [
      ["Name", selectedAdminRoom.workspace.name],
      ["Room ID", selectedAdminRoom.workspace.id]
    ]);

    const selectedRoomActions = this.createActionRow(selectedRoomCard.body);
    this.createActionButton(selectedRoomActions, "Delete room", "mod-warning", async () => {
      if (
        !window.confirm(
          `Delete room ${selectedAdminRoom.workspace.name} (${selectedAdminRoom.workspace.id})? Local folder will not be deleted automatically.`
        )
      ) {
        return;
      }
      await this.rolay.deleteAdminRoom(selectedAdminRoom.workspace.id);
      this.requestRender();
    });

    const memberFormCard = this.createCard(grid, "Add Member");
    this.createInputField(memberFormCard.body, {
      label: "Username",
      value: adminRoomDraft.username,
      placeholder: "student1",
      onChange: (value) => {
        this.rolay.updateAdminRoomMemberDraft({
          username: value.trim()
        });
      }
    });
    this.createSelectField(memberFormCard.body, {
      label: "Membership role",
      value: adminRoomDraft.role ?? "member",
      options: [
        ["member", "member"],
        ["owner", "owner"]
      ],
      onChange: (value) => {
        this.rolay.updateAdminRoomMemberDraft({
          role: value as WorkspaceRole
        });
      }
    });
    const memberActions = this.createActionRow(memberFormCard.body);
    this.createActionButton(memberActions, "Add to room", "", async () => {
      await this.rolay.addUserToSelectedAdminRoom();
      this.requestRender();
    });

    const membersCard = this.createCard(grid, "Members");
    this.renderRoomMembers(membersCard.body, adminRoomMembers);
  }

  private renderManagedUsers(
    containerEl: HTMLElement,
    users: ManagedUser[],
    currentUserId: string | null
  ): void {
    if (users.length === 0) {
      containerEl.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "No managed users available."
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "rolay-settings-list" });
    for (const user of users) {
      const itemEl = listEl.createDiv({ cls: "rolay-settings-list-item rolay-settings-list-item-stack" });
      const topRow = itemEl.createDiv({ cls: "rolay-settings-list-item-top" });
      topRow.createDiv({
        cls: "rolay-settings-list-title",
        text: `${user.displayName} (@${user.username})`
      });
      const badges = topRow.createDiv({ cls: "rolay-settings-badges" });
      this.createBadge(badges, user.globalRole, "ready");
      if (user.disabledAt) {
        this.createBadge(badges, "Disabled", "muted");
      } else if (user.id === currentUserId) {
        this.createBadge(badges, "Current session", "accent");
      }

      this.createInfoBlock(itemEl, [
        ["User ID", user.id],
        ["Created", this.formatDateTime(user.createdAt) ?? "unknown"],
        ["Disabled", this.formatDateTime(user.disabledAt) ?? "active"]
      ]);

      if (user.id !== currentUserId) {
        const actions = this.createActionRow(itemEl);
        this.createActionButton(actions, "Delete", "mod-warning", async () => {
          if (!window.confirm(`Delete managed user ${user.username}?`)) {
            return;
          }
          await this.rolay.deleteManagedUser(user.id);
          this.requestRender();
        });
      }
    }
  }

  private renderAdminRooms(
    containerEl: HTMLElement,
    rooms: AdminRoomListItem[],
    selectedRoomId: string
  ): void {
    if (rooms.length === 0) {
      containerEl.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "No admin rooms available."
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "rolay-settings-list" });
    for (const room of rooms) {
      const itemEl = listEl.createDiv({
        cls: `rolay-settings-list-item${room.workspace.id === selectedRoomId ? " rolay-settings-list-item-active" : ""}`
      });
      const titleWrap = itemEl.createDiv({ cls: "rolay-settings-list-title-wrap" });
      titleWrap.createDiv({
        cls: "rolay-settings-list-title",
        text: room.workspace.name
      });
      titleWrap.createDiv({
        cls: "rolay-settings-list-meta",
        text: `${room.memberCount} members, ${room.ownerCount} owners`
      });

      const actionButton = itemEl.createEl("button", {
        cls: "rolay-settings-secondary-button",
        text: room.workspace.id === selectedRoomId ? "Selected" : "Inspect"
      });
      if (room.workspace.id === selectedRoomId) {
        actionButton.disabled = true;
      }
      actionButton.addEventListener("click", async () => {
        this.rolay.setAdminSelectedRoomId(room.workspace.id);
        await this.rolay.refreshAdminRoomMembers(false, room.workspace.id, false);
        this.requestRender();
      });
    }
  }

  private renderRoomMembers(containerEl: HTMLElement, members: RoomMember[]): void {
    if (members.length === 0) {
      containerEl.createEl("div", {
        cls: "rolay-settings-empty-state",
        text: "No members yet."
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: "rolay-settings-list" });
    for (const member of members) {
      const itemEl = listEl.createDiv({ cls: "rolay-settings-list-item rolay-settings-list-item-stack" });
      const topRow = itemEl.createDiv({ cls: "rolay-settings-list-item-top" });
      topRow.createDiv({
        cls: "rolay-settings-list-title",
        text: `${member.user.displayName} (@${member.user.username})`
      });
      const badges = topRow.createDiv({ cls: "rolay-settings-badges" });
      this.createBadge(badges, member.role, member.role === "owner" ? "accent" : "muted");
      this.createBadge(badges, member.user.globalRole, "ready");

      this.createInfoBlock(itemEl, [
        ["User ID", member.user.id],
        ["Joined", this.formatDateTime(member.joinedAt) ?? member.joinedAt]
      ]);
    }
  }

  private createGrid(containerEl: HTMLElement, twoColumns = false): HTMLDivElement {
    const grid = containerEl.createDiv({
      cls: twoColumns ? "rolay-settings-grid rolay-settings-grid-wide" : "rolay-settings-grid"
    });
    grid.createDiv({ cls: "rolay-settings-grid-column" });
    if (twoColumns) {
      grid.createDiv({ cls: "rolay-settings-grid-column" });
    }
    return grid;
  }

  private createCard(containerEl: HTMLElement, title: string, helpText?: string): CardElements {
    const cardHost = this.resolveCardHost(containerEl);
    const card = cardHost.createDiv({ cls: "rolay-settings-card" });
    const header = card.createDiv({ cls: "rolay-settings-card-header" });
    const titleRow = header.createDiv({ cls: "rolay-settings-card-title-row" });
    titleRow.createEl("h3", {
      cls: "rolay-settings-card-title",
      text: title
    });
    if (helpText) {
      const helpButton = titleRow.createEl("button", {
        cls: "rolay-settings-help-button",
        attr: {
          type: "button",
          "data-tooltip": helpText
        }
      });
      setIcon(helpButton, "help-circle");
      helpButton.createSpan({
        cls: "rolay-settings-sr-only",
        text: helpText
      });
    }

    return {
      card,
      body: card.createDiv({ cls: "rolay-settings-card-body" })
    };
  }

  private resolveCardHost(containerEl: HTMLElement): HTMLElement {
    if (
      !containerEl.classList.contains("rolay-settings-grid") &&
      !containerEl.classList.contains("rolay-settings-grid-wide")
    ) {
      return containerEl;
    }

    const columns = [...containerEl.children].filter((child): child is HTMLDivElement => {
      return child instanceof HTMLDivElement && child.classList.contains("rolay-settings-grid-column");
    });

    if (columns.length === 0) {
      return containerEl;
    }

    return columns.reduce((shortest, column) => {
      return column.offsetHeight < shortest.offsetHeight ? column : shortest;
    }, columns[0]);
  }

  private createInputField(
    containerEl: HTMLElement,
    options: {
      value: string;
      onChange: (value: string) => void | Promise<void>;
      placeholder?: string;
      type?: string;
      label?: string;
    }
  ): HTMLInputElement {
    const fieldEl = containerEl.createDiv({ cls: "rolay-settings-field" });
    if (options.label) {
      fieldEl.createDiv({
        cls: "rolay-settings-field-label",
        text: options.label
      });
    }

    const input = fieldEl.createEl("input", {
      cls: "rolay-settings-input",
      type: options.type ?? "text"
    });
    input.placeholder = options.placeholder ?? "";
    input.value = options.value;
    input.addEventListener("input", () => {
      void options.onChange(input.value);
    });
    return input;
  }

  private createSelectField(
    containerEl: HTMLElement,
    options: {
      value: string;
      onChange: (value: string) => void | Promise<void>;
      options: Array<readonly [value: string, label: string]>;
      label?: string;
    }
  ): HTMLSelectElement {
    const fieldEl = containerEl.createDiv({ cls: "rolay-settings-field" });
    if (options.label) {
      fieldEl.createDiv({
        cls: "rolay-settings-field-label",
        text: options.label
      });
    }

    const select = fieldEl.createEl("select", {
      cls: "rolay-settings-input"
    });
    for (const [value, label] of options.options) {
      select.createEl("option", {
        value,
        text: label
      });
    }
    select.value = options.value;
    select.addEventListener("change", () => {
      void options.onChange(select.value);
    });
    return select;
  }

  private formatDateTime(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(parsed);
  }

  private getRenderKey(): string {
    return this.activeRoomId ? `room:${this.activeRoomId}` : `view:${this.activeView}`;
  }

  private getScrollHost(): HTMLElement | null {
    let current: HTMLElement | null = this.containerEl;

    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const isScrollable = (overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight;
      if (isScrollable) {
        return current;
      }
      current = current.parentElement;
    }

    return this.containerEl;
  }

  private finishRender(scrollHost: HTMLElement | null, renderKey: string, scrollTop: number): void {
    this.lastRenderKey = renderKey;
    const nextScrollTop = this.resetScrollOnNextRender ? 0 : scrollTop;
    this.resetScrollOnNextRender = false;

    window.requestAnimationFrame(() => {
      if (!this.isVisible || !scrollHost) {
        return;
      }

      scrollHost.scrollTop = nextScrollTop;
    });
  }

  private createActionRow(containerEl: HTMLElement): HTMLDivElement {
    return containerEl.createDiv({ cls: "rolay-settings-action-row" });
  }

  private createActionButton(
    containerEl: HTMLElement,
    label: string,
    cls: string,
    onClick: () => Promise<void> | void
  ): HTMLButtonElement {
    const button = containerEl.createEl("button", {
      text: label,
      cls: cls || undefined
    });
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  private createInfoBlock(
    containerEl: HTMLElement,
    rows: Array<readonly [label: string, value: string]>
  ): HTMLDivElement {
    const block = containerEl.createDiv({ cls: "rolay-settings-info-block" });
    for (const [label, value] of rows) {
      const row = block.createDiv({ cls: "rolay-settings-info-row" });
      row.createDiv({
        cls: "rolay-settings-info-label",
        text: label
      });
      row.createDiv({
        cls: "rolay-settings-info-value",
        text: value
      });
    }
    return block;
  }

  private addCopyableInfoLine(
    containerEl: HTMLElement,
    label: string,
    value: string,
    allowCopy = true
  ): void {
    const row = containerEl.createDiv({ cls: "rolay-settings-copy-row" });
    const info = row.createDiv({ cls: "rolay-settings-copy-main" });
    info.createDiv({
      cls: "rolay-settings-info-label",
      text: label
    });
    info.createDiv({
      cls: "rolay-settings-info-value",
      text: value
    });

    if (!allowCopy) {
      return;
    }

    const copyButton = row.createEl("button", {
      cls: "rolay-settings-secondary-button",
      text: "Copy"
    });
    copyButton.addEventListener("click", () => {
      void this.copyToClipboard(value, `${label} copied.`);
    });
  }

  private createBadge(
    containerEl: HTMLElement,
    label: string,
    tone: "ready" | "muted" | "accent"
  ): void {
    containerEl.createSpan({
      cls: `rolay-settings-badge rolay-settings-badge-${tone}`,
      text: label
    });
  }

  private async copyToClipboard(text: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(successMessage);
    } catch (error) {
      new Notice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private hasFocusedTextInput(): boolean {
    const activeEl = document.activeElement;
    if (!(activeEl instanceof HTMLElement)) {
      return false;
    }

    if (!this.containerEl.contains(activeEl)) {
      return false;
    }

    if (
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      activeEl instanceof HTMLSelectElement
    ) {
      return true;
    }

    return activeEl.isContentEditable;
  }
}
