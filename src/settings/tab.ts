import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RolayPlugin from "../main";
import type { RoomCardState } from "../main";
import type {
  AdminRoomListItem,
  ManagedUser,
  RoomMember
} from "../types/protocol";
import { openTextInputModal } from "../ui/text-input-modal";
import { normalizeServerUrl } from "./data";

export class RolaySettingTab extends PluginSettingTab {
  private readonly plugin: RolayPlugin;

  constructor(app: App, plugin: RolayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.getSettings();
    const status = this.plugin.getStatusSnapshot();
    const currentUser = this.plugin.getCurrentUser();
    const rooms = this.plugin.getRoomCardStates();
    const managedUserDraft = this.plugin.getManagedUserDraft();
    const createRoomDraft = this.plugin.getCreateRoomDraft();
    const joinRoomDraft = this.plugin.getJoinRoomDraft();
    const adminRoomDraft = this.plugin.getAdminRoomMemberDraft();
    const adminRooms = this.plugin.getAdminRooms();
    const adminRoomMembers = this.plugin.getAdminRoomMembers();
    const adminSelectedRoomId = this.plugin.getAdminSelectedRoomId();
    const selectedAdminRoom = adminRooms.find((room) => room.workspace.id === adminSelectedRoomId) ?? null;

    containerEl.empty();
    containerEl.createEl("h2", { text: "Rolay" });
    containerEl.createEl("p", {
      text: "Configure Rolay auth, room folder bindings, live sync, and admin controls."
    });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Base URL of the Rolay server.")
      .addText((text) => {
        text
          .setPlaceholder("http://46.16.36.87:3000")
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              serverUrl: normalizeServerUrl(value)
            });
          });
      });

    new Setting(containerEl)
      .setName("Sync Root")
      .setDesc("Base vault folder under which installed room folders are created.")
      .addText((text) => {
        text
          .setPlaceholder("Rolay")
          .setValue(settings.syncRoot)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              syncRoot: value.trim()
            });
          });
      });

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("Sent during login and shown server-side as the session label.")
      .addText((text) => {
        text
          .setValue(settings.deviceName)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              deviceName: value.trim()
            });
          });
      });

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Rolay account username.")
      .addText((text) => {
        text
          .setValue(settings.username)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              username: value.trim()
            });
          });
      });

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Stored in plugin data for the current MVP.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(settings.password)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              password: value
            });
          });
      });

    new Setting(containerEl)
      .setName("Auto-connect on startup")
      .setDesc("If auth is available, resume sync for every room that already has an installed local folder.")
      .addToggle((toggle) => {
        toggle
          .setValue(settings.autoConnect)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              autoConnect: value
            });
          });
      });

    new Setting(containerEl)
      .setName("Auth")
      .setDesc("Login, refresh, or clear the current Rolay session.")
      .addButton((button) => {
        button.setButtonText("Login").onClick(async () => {
          await this.plugin.loginWithSettings();
          this.display();
        });
      })
      .addButton((button) => {
        button.setButtonText("Refresh").onClick(async () => {
          await this.plugin.refreshSession();
          this.display();
        });
      })
      .addButton((button) => {
        button.setButtonText("Logout").setWarning().onClick(async () => {
          await this.plugin.logout();
          new Notice("Rolay session cleared.");
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Current profile")
      .setDesc("Reload `GET /v1/auth/me` and refresh room/admin state from the server.")
      .addButton((button) => {
        button.setButtonText("Reload profile").onClick(async () => {
          await this.plugin.fetchCurrentUser(true);
          this.display();
        });
      });

    containerEl.createEl("h3", { text: "Logged-in Profile" });
    const profileContainer = containerEl.createDiv({ cls: "rolay-settings-status" });
    this.addInfoLine(profileContainer, "Login", currentUser?.username ?? "not authenticated");
    this.addInfoLine(profileContainer, "Display name", currentUser?.displayName ?? "not authenticated");
    this.addInfoLine(profileContainer, "Global role", currentUser?.globalRole ?? "not authenticated");
    this.addInfoLine(profileContainer, "Admin privileges", currentUser ? (currentUser.isAdmin ? "yes" : "no") : "not authenticated");

    new Setting(containerEl)
      .setName("Display Name")
      .setDesc("Every user can update their own display name through `PATCH /v1/auth/me/profile`.")
      .addText((text) => {
        text
          .setPlaceholder(currentUser?.displayName ?? "Display name")
          .setValue(this.plugin.getProfileDraftDisplayName())
          .onChange((value) => {
            this.plugin.setProfileDraftDisplayName(value);
          });
      })
      .addButton((button) => {
        button.setButtonText("Save name").onClick(async () => {
          await this.plugin.updateOwnDisplayName();
          this.display();
        });
      });

    containerEl.createEl("h3", { text: "Rooms" });
    new Setting(containerEl)
      .setName("Room list")
      .setDesc("Reload all rooms available to the current user. Room membership is gained only by invite key or admin assignment.")
      .addButton((button) => {
        button.setButtonText("Refresh rooms").onClick(async () => {
          await this.plugin.refreshRooms(true);
          this.display();
        });
      });

    this.renderRoomCards(containerEl, rooms);

    if (currentUser && this.plugin.canCurrentUserCreateRooms()) {
      new Setting(containerEl)
        .setName("New room name")
        .setDesc("Only writer/admin users can create rooms. The local folder is still not installed until you press the room's install button.")
        .addText((text) => {
          text
            .setPlaceholder("Physics Lab")
            .setValue(createRoomDraft.name)
            .onChange((value) => {
              this.plugin.updateCreateRoomDraft({
                name: value
              });
            });
        })
        .addButton((button) => {
          button.setCta().setButtonText("Create room").onClick(async () => {
            await this.plugin.createRoomFromDraft();
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName("Join by invite key")
      .setDesc("Join a room using its current invite key.")
      .addText((text) => {
        text
          .setPlaceholder("paste invite key")
          .setValue(joinRoomDraft.code)
          .onChange((value) => {
            this.plugin.updateJoinRoomDraft({
              code: value
            });
          });
      })
      .addButton((button) => {
        button.setButtonText("Join room").onClick(async () => {
          await this.plugin.joinRoomFromDraft();
          this.display();
        });
      });

    if (status.isAdmin) {
      containerEl.createEl("h3", { text: "Admin Users" });
      new Setting(containerEl)
        .setName("Managed users")
        .setDesc("Reload the global user list.")
        .addButton((button) => {
          button.setButtonText("Refresh users").onClick(async () => {
            await this.plugin.refreshManagedUsers(true);
            this.display();
          });
        });

      new Setting(containerEl)
        .setName("New username")
        .setDesc("Username for the managed account.")
        .addText((text) => {
          text
            .setPlaceholder("student1")
            .setValue(managedUserDraft.username)
            .onChange((value) => {
              this.plugin.updateManagedUserDraft({
                username: value.trim()
              });
            });
        });

      new Setting(containerEl)
        .setName("Temporary password")
        .setDesc("Required for admin-created users.")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("temporary-password")
            .setValue(managedUserDraft.password)
            .onChange((value) => {
              this.plugin.updateManagedUserDraft({
                password: value
              });
            });
        });

      new Setting(containerEl)
        .setName("Initial display name")
        .setDesc("Optional. If empty, the server can fall back to the username.")
        .addText((text) => {
          text
            .setPlaceholder("Student One")
            .setValue(managedUserDraft.displayName ?? "")
            .onChange((value) => {
              this.plugin.updateManagedUserDraft({
                displayName: value
              });
            });
        });

      new Setting(containerEl)
        .setName("Managed user role")
        .setDesc("Admin-created users currently support `writer` and `reader`.")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("writer", "writer")
            .addOption("reader", "reader")
            .setValue(managedUserDraft.globalRole ?? "reader")
            .onChange((value) => {
              this.plugin.updateManagedUserDraft({
                globalRole: value as "writer" | "reader"
              });
            });
        })
        .addButton((button) => {
          button.setCta().setButtonText("Create user").onClick(async () => {
            await this.plugin.createManagedUserFromDraft();
            this.display();
          });
        });

      this.renderManagedUsers(containerEl, this.plugin.getManagedUsers(), currentUser?.id ?? null);

      containerEl.createEl("h3", { text: "Admin Rooms" });
      new Setting(containerEl)
        .setName("Admin room list")
        .setDesc("Reload all rooms visible to admin.")
        .addButton((button) => {
          button.setButtonText("Refresh admin rooms").onClick(async () => {
            await this.plugin.refreshAdminRooms(true);
            this.display();
          });
        });

      new Setting(containerEl)
        .setName("Selected admin room")
        .setDesc("Choose which room to inspect for members or room deletion.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Select room");
          for (const room of adminRooms) {
            dropdown.addOption(room.workspace.id, `${room.workspace.name} (${room.workspace.id})`);
          }
          dropdown
            .setValue(adminSelectedRoomId)
            .onChange((value) => {
              this.plugin.setAdminSelectedRoomId(value);
              this.display();
            });
        })
        .addButton((button) => {
          button.setButtonText("Load members").onClick(async () => {
            await this.plugin.refreshAdminRoomMembers(true);
            this.display();
          });
        })
        .addButton((button) => {
          button.setWarning().setButtonText("Delete room").onClick(async () => {
            if (!selectedAdminRoom) {
              new Notice("Select an admin room first.");
              return;
            }

            if (!window.confirm(`Delete room ${selectedAdminRoom.workspace.name} (${selectedAdminRoom.workspace.id})? Local folder will not be deleted automatically.`)) {
              return;
            }

            await this.plugin.deleteAdminRoom();
            this.display();
          });
        });

      this.renderAdminRooms(containerEl, adminRooms, adminSelectedRoomId);

      if (selectedAdminRoom) {
        const adminRoomInfo = containerEl.createDiv({ cls: "rolay-settings-status" });
        this.addInfoLine(adminRoomInfo, "Selected room", `${selectedAdminRoom.workspace.name} (${selectedAdminRoom.workspace.id})`);
        this.addInfoLine(adminRoomInfo, "Owners", String(selectedAdminRoom.ownerCount));
        this.addInfoLine(adminRoomInfo, "Members", String(selectedAdminRoom.memberCount));

        new Setting(containerEl)
          .setName("Username to add")
          .setDesc("Add an existing user to the selected room by username.")
          .addText((text) => {
            text
              .setPlaceholder("student1")
              .setValue(adminRoomDraft.username)
              .onChange((value) => {
                this.plugin.updateAdminRoomMemberDraft({
                  username: value.trim()
                });
              });
          });

        new Setting(containerEl)
          .setName("Membership role")
          .setDesc("Role inside the selected room.")
          .addDropdown((dropdown) => {
            dropdown
              .addOption("member", "member")
              .addOption("owner", "owner")
              .setValue(adminRoomDraft.role ?? "member")
              .onChange((value) => {
                this.plugin.updateAdminRoomMemberDraft({
                  role: value as "owner" | "member"
                });
              });
          })
          .addButton((button) => {
            button.setButtonText("Add to room").onClick(async () => {
              await this.plugin.addUserToSelectedAdminRoom();
              this.display();
            });
          });

        this.renderRoomMembers(containerEl, adminRoomMembers);
      }
    }

    containerEl.createEl("h3", { text: "Status" });
    const statusContainer = containerEl.createDiv({ cls: "rolay-settings-status" });
    this.addInfoLine(statusContainer, "Authenticated user", status.userLabel);
    this.addInfoLine(statusContainer, "Global role", status.globalRoleLabel);
    this.addInfoLine(statusContainer, "Admin mode", status.isAdmin ? "enabled" : "disabled");
    this.addInfoLine(statusContainer, "Installed rooms", String(status.downloadedRoomCount));
    this.addInfoLine(statusContainer, "Open streams", String(status.activeStreamCount));
    this.addInfoLine(statusContainer, "Sync root", settings.syncRoot || "/");
    this.addInfoLine(statusContainer, "CRDT session", status.crdtLabel);

    containerEl.createEl("h3", { text: "Recent sync log" });
    const logLines = status.recentLogs.length > 0 ? status.recentLogs.join("\n") : "No sync activity recorded yet.";
    containerEl.createEl("pre", {
      cls: "rolay-settings-log",
      text: logLines
    });
  }

  private renderRoomCards(containerEl: HTMLElement, rooms: RoomCardState[]): void {
    const listEl = containerEl.createDiv({ cls: "rolay-settings-status" });
    if (rooms.length === 0) {
      listEl.createEl("div", { text: "No rooms loaded yet." });
      return;
    }

    for (const card of rooms) {
      const itemEl = listEl.createDiv({ cls: "rolay-room-item" });
      this.addInfoLine(itemEl, "Room", card.room.workspace.name);
      this.addInfoLine(itemEl, "Room ID", card.room.workspace.id);
      this.addInfoLine(itemEl, "Membership", card.room.membershipRole);
      this.addInfoLine(itemEl, "Members", String(card.room.memberCount));
      this.addInfoLine(itemEl, "Folder status", card.downloaded ? "installed" : "not installed");
      this.addInfoLine(itemEl, "Local folder", card.downloaded ? card.folderName : `default: ${card.room.workspace.name}`);
      this.addInfoLine(itemEl, "Local root", card.downloaded ? card.localRoot : "not installed");
      this.addInfoLine(itemEl, "Folder exists in vault", card.downloaded ? (card.folderExists ? "yes" : "no") : "n/a");
      this.addInfoLine(itemEl, "SSE stream", card.streamStatus);
      this.addInfoLine(itemEl, "Last cursor", card.lastCursorLabel);
      this.addInfoLine(itemEl, "Last snapshot", card.lastSnapshotLabel);
      this.addInfoLine(itemEl, "Entries", String(card.entryCount));

      new Setting(itemEl)
        .setName("Local folder binding")
        .setDesc(card.downloaded
          ? "This room already has a local folder binding. Use `Rename` to move it to another local folder name without changing the room on the server."
          : "Install this room into a local vault folder. The default folder name is the room name.")
        .addButton((button) => {
          if (!card.downloaded) {
            button.setCta();
          }

          button.setButtonText(card.downloaded ? "Rename" : "Install").onClick(async () => {
              const nextFolderName = await openTextInputModal(this.app, {
                title: card.downloaded ? "Rename Rolay Room Folder" : "Install Rolay Room",
                label: "Local folder name",
                placeholder: card.room.workspace.name,
                initialValue: card.folderName || card.room.workspace.name,
                submitText: card.downloaded ? "Rename" : "Install",
                description: card.downloaded
                  ? "Rename only the local vault folder. The room identity on the server stays the same."
                  : "Install the room into a local vault folder. Installation is blocked if that folder already exists."
              });

              if (!nextFolderName) {
                return;
              }

              if (card.downloaded) {
                await this.plugin.renameInstalledRoomFolder(card.room.workspace.id, nextFolderName);
              } else {
                await this.plugin.installRoom(card.room.workspace.id, nextFolderName);
              }
              this.display();
            });
        });

      const downloadSetting = new Setting(itemEl)
        .setName("Room sync")
        .setDesc(card.downloaded
          ? "This room already has an installed local folder and can sync in parallel with other installed rooms. Use the single Connect/Disconnect control to manage its live sync state."
          : "Install the room first. Once a local folder is bound, you can connect or disconnect live sync for this room.");

      if (card.downloaded) {
        const isConnected = card.streamStatus !== "stopped";
        downloadSetting.addButton((button) => {
          button.setButtonText(isConnected ? "Disconnect" : "Connect").onClick(async () => {
            if (isConnected) {
              await this.plugin.disconnectRoom(card.room.workspace.id);
            } else {
              await this.plugin.connectRoom(card.room.workspace.id, true, "settings-connect");
            }
            this.display();
          });
        });
      }

      if (card.room.membershipRole === "owner") {
        const inviteState = card.invite;
        this.addInfoLine(itemEl, "Invite enabled", String(inviteState?.enabled ?? card.room.inviteEnabled));
        this.addInfoLine(itemEl, "Invite key", inviteState?.code ?? "not loaded");
        if (inviteState?.updatedAt) {
          this.addInfoLine(itemEl, "Invite updated", inviteState.updatedAt);
        }

        new Setting(itemEl)
          .setName("Invite controls")
          .setDesc("Owner-only controls for this room.")
          .addButton((button) => {
            button.setButtonText("Load invite").onClick(async () => {
              await this.plugin.refreshRoomInvite(card.room.workspace.id, true);
              this.display();
            });
          })
          .addButton((button) => {
            button
              .setButtonText(inviteState?.enabled ?? card.room.inviteEnabled ? "Disable invite" : "Enable invite")
              .onClick(async () => {
                await this.plugin.setRoomInviteEnabled(card.room.workspace.id, !(inviteState?.enabled ?? card.room.inviteEnabled));
                this.display();
              });
          })
          .addButton((button) => {
            button.setWarning().setButtonText("Regenerate").onClick(async () => {
              await this.plugin.regenerateRoomInvite(card.room.workspace.id);
              this.display();
            });
          });
      }
    }
  }

  private renderManagedUsers(containerEl: HTMLElement, users: ManagedUser[], currentUserId: string | null): void {
    const listEl = containerEl.createDiv({ cls: "rolay-settings-status" });
    if (users.length === 0) {
      listEl.createEl("div", { text: "No managed users loaded yet." });
      return;
    }

    for (const user of users) {
      const itemEl = listEl.createDiv({ cls: "rolay-room-item" });
      this.addInfoLine(itemEl, "User", `${user.displayName} (@${user.username})`);
      this.addInfoLine(itemEl, "Role", user.globalRole);
      this.addInfoLine(itemEl, "User ID", user.id);
      if (user.createdAt) {
        this.addInfoLine(itemEl, "Created", user.createdAt);
      }
      if (user.disabledAt) {
        this.addInfoLine(itemEl, "Disabled", user.disabledAt);
      }

      const actionsEl = itemEl.createDiv({ cls: "rolay-room-actions" });
      if (user.id === currentUserId) {
        actionsEl.createEl("span", { text: "current session user" });
      } else {
        const deleteButton = actionsEl.createEl("button", {
          text: "Delete"
        });
        deleteButton.classList.add("mod-warning");
        deleteButton.addEventListener("click", async () => {
          if (!window.confirm(`Delete managed user ${user.username}?`)) {
            return;
          }

          await this.plugin.deleteManagedUser(user.id);
          this.display();
        });
      }
    }
  }

  private renderAdminRooms(containerEl: HTMLElement, rooms: AdminRoomListItem[], selectedRoomId: string): void {
    const listEl = containerEl.createDiv({ cls: "rolay-settings-status" });
    if (rooms.length === 0) {
      listEl.createEl("div", { text: "No admin rooms loaded yet." });
      return;
    }

    for (const room of rooms) {
      const itemEl = listEl.createDiv({ cls: "rolay-room-item" });
      this.addInfoLine(itemEl, "Room", room.workspace.name);
      this.addInfoLine(itemEl, "Room ID", room.workspace.id);
      this.addInfoLine(itemEl, "Selected", room.workspace.id === selectedRoomId ? "yes" : "no");
      this.addInfoLine(itemEl, "Members", String(room.memberCount));
      this.addInfoLine(itemEl, "Owners", String(room.ownerCount));
      this.addInfoLine(itemEl, "Invite enabled", String(room.inviteEnabled));

      const actionsEl = itemEl.createDiv({ cls: "rolay-room-actions" });
      const inspectButton = actionsEl.createEl("button", {
        text: "Inspect"
      });
      inspectButton.addEventListener("click", async () => {
        this.plugin.setAdminSelectedRoomId(room.workspace.id);
        await this.plugin.refreshAdminRoomMembers(false, room.workspace.id);
        this.display();
      });
    }
  }

  private renderRoomMembers(containerEl: HTMLElement, members: RoomMember[]): void {
    containerEl.createEl("h4", { text: "Selected Room Members" });
    const listEl = containerEl.createDiv({ cls: "rolay-settings-status" });
    if (members.length === 0) {
      listEl.createEl("div", { text: "No members loaded yet." });
      return;
    }

    for (const member of members) {
      const itemEl = listEl.createDiv({ cls: "rolay-room-item" });
      this.addInfoLine(itemEl, "Member", `${member.user.displayName} (@${member.user.username})`);
      this.addInfoLine(itemEl, "Role", member.role);
      this.addInfoLine(itemEl, "Global role", member.user.globalRole);
      this.addInfoLine(itemEl, "Joined", member.joinedAt);
    }
  }

  private addInfoLine(containerEl: HTMLElement, label: string, value: string): void {
    containerEl.createEl("div", {
      text: `${label}: ${value}`
    });
  }
}
