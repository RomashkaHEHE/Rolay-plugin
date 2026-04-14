export type EntryKind = "folder" | "markdown" | "binary";
export type ContentMode = "none" | "crdt" | "blob";
export type GlobalRole = "admin" | "writer" | "reader";
export type ManagedGlobalRole = "writer" | "reader";
export type WorkspaceRole = "owner" | "member";
export type TreeOperationType =
  | "create_folder"
  | "create_markdown"
  | "create_binary_placeholder"
  | "rename_entry"
  | "move_entry"
  | "delete_entry"
  | "restore_entry"
  | "commit_blob_revision";

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  globalRole: GlobalRole;
}

export interface ManagedUser extends User {
  createdAt?: string;
  disabledAt?: string | null;
}

export interface Workspace {
  id: string;
  slug?: string;
  name: string;
}

export interface WorkspaceResponse {
  workspace: Workspace;
}

export interface RoomListItem {
  workspace: Workspace;
  membershipRole: WorkspaceRole;
  createdAt: string;
  memberCount: number;
  inviteEnabled: boolean;
}

export interface AdminRoomListItem extends RoomListItem {
  ownerCount: number;
}

export interface RoomListResponse {
  workspaces: RoomListItem[];
}

export interface AdminRoomListResponse {
  workspaces: AdminRoomListItem[];
}

export interface LoginRequest {
  username: string;
  password: string;
  deviceName: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface UserResponse {
  user: User;
}

export interface ManagedUserResponse {
  user: ManagedUser;
}

export interface UserListResponse {
  users: ManagedUser[];
}

export interface UpdateProfileRequest {
  displayName: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface CreateManagedUserRequest {
  username: string;
  password: string;
  displayName?: string;
  globalRole?: ManagedGlobalRole;
}

export interface CreateRoomRequest {
  name: string;
  slug?: string;
}

export interface JoinRoomRequest {
  code: string;
}

export interface InviteState {
  workspaceId: string;
  code: string;
  enabled: boolean;
  updatedAt: string;
}

export interface InviteStateResponse {
  invite: InviteState;
}

export interface UpdateInviteStateRequest {
  enabled: boolean;
}

export interface RoomMember {
  user: User;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface RoomMemberListResponse {
  members: RoomMember[];
}

export interface Membership {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface AddRoomMemberRequest {
  username: string;
  role?: WorkspaceRole;
}

export interface AddRoomMemberResponse {
  workspace: Workspace;
  user: User;
  membership: Membership;
}

export interface BlobRevision {
  hash: string;
  sizeBytes: number;
  mimeType: string;
}

export interface FileEntry {
  id: string;
  path: string;
  kind: EntryKind;
  contentMode: ContentMode;
  entryVersion: number;
  docId?: string;
  mimeType?: string;
  blob?: BlobRevision;
  deleted: boolean;
  updatedAt: string;
}

export interface TreeSnapshotResponse {
  workspace: Workspace;
  cursor: number;
  entries: FileEntry[];
}

export interface OperationPreconditions {
  entryVersion?: number;
  path?: string;
}

export interface TreeOperation {
  opId: string;
  type: TreeOperationType;
  path?: string;
  entryId?: string;
  newPath?: string;
  hash?: string;
  sizeBytes?: number;
  mimeType?: string;
  preconditions?: OperationPreconditions;
}

export interface OperationResult {
  opId: string;
  status: "applied" | "conflict" | "rejected";
  eventSeq?: number;
  reason?: string;
  entry?: FileEntry;
  serverEntry?: FileEntry;
  suggestedPath?: string;
}

export interface BatchOperationsRequest {
  deviceId: string;
  operations: TreeOperation[];
}

export interface BatchOperationsResponse {
  results: OperationResult[];
}

export interface CrdtTokenResponse {
  entryId: string;
  docId: string;
  provider: string;
  wsUrl: string;
  token: string;
  expiresAt: string;
}

export interface MarkdownBootstrapRequest {
  entryIds?: string[];
  includeState?: boolean;
}

export interface MarkdownBootstrapDocument {
  entryId: string;
  docId: string;
  stateBytes: number;
  encodedBytes: number;
  state?: string;
}

export interface MarkdownBootstrapResponse {
  workspaceId: string;
  encoding: "base64";
  includesState: boolean;
  documentCount: number;
  totalStateBytes: number;
  totalEncodedBytes: number;
  documents: MarkdownBootstrapDocument[];
}

export interface BlobUploadTicketRequest {
  hash: string;
  sizeBytes: number;
  mimeType: string;
}

export interface UploadTarget {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
}

export interface CancelTarget {
  method: "DELETE";
  url: string;
}

export interface BlobUploadTicketResponse {
  alreadyExists: boolean;
  uploadId: string;
  hash: string;
  sizeBytes: number;
  mimeType: string;
  uploadedBytes: number;
  expiresAt: string;
  upload?: UploadTarget;
  cancel?: CancelTarget;
}

export interface BlobUploadContentResponse {
  ok: boolean;
  uploadId?: string;
  receivedBytes?: number;
  uploadedBytes?: number;
  sizeBytes: number;
  complete?: boolean;
  hash?: string;
}

export interface BlobDownloadTicketResponse {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  contentUrl?: string;
  rangeSupported?: boolean;
  url: string;
}

export interface BlobUploadCancelResponse {
  ok: boolean;
  uploadId: string;
  wasActive: boolean;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface WorkspaceEvent<TPayload = unknown> {
  id: number;
  event: string;
  data: TPayload;
}

export type SettingsEventType =
  | "stream.ready"
  | "auth.me.updated"
  | "room.created"
  | "room.updated"
  | "room.deleted"
  | "room.membership.changed"
  | "room.invite.updated"
  | "admin.user.created"
  | "admin.user.updated"
  | "admin.user.deleted"
  | "admin.room.members.updated"
  | "ping";

export type SettingsEventScope =
  | "settings.stream"
  | "auth.me"
  | "rooms"
  | "room.invite"
  | "admin.users"
  | "admin.rooms"
  | "admin.room.members";

export interface SettingsEventEnvelope<TPayload = unknown> {
  eventId: number;
  type: SettingsEventType | string;
  occurredAt: string;
  scope: SettingsEventScope | string;
  payload: TPayload;
}

export interface SettingsStreamReadyPayload {
  cursor?: number;
}

export interface SettingsRoomDeletedPayload {
  workspaceId: string;
}

export interface SettingsInviteUpdatedPayload {
  invite: InviteState;
}

export interface SettingsRoomPayload<TRoom = RoomListItem | AdminRoomListItem> {
  room: TRoom;
}

export interface SettingsRoomMembershipChangedPayload {
  workspaceId?: string;
  room?: RoomListItem;
  removed?: boolean;
}

export interface SettingsAdminUserDeletedPayload {
  userId: string;
}

export interface SettingsAdminRoomMembersUpdatedPayload {
  workspaceId: string;
  members: RoomMember[];
}

export type SettingsStreamEvent<TPayload = unknown> = WorkspaceEvent<TPayload>;

export interface NotePresenceViewer {
  presenceId: string;
  userId: string;
  displayName: string;
  color: string;
  hasSelection: boolean;
}

export interface NotePresenceSnapshotNote {
  entryId: string;
  viewers: NotePresenceViewer[];
}

export interface NotePresenceSnapshotPayload {
  workspaceId: string;
  notes: NotePresenceSnapshotNote[];
}

export interface NotePresenceUpdatedPayload {
  workspaceId: string;
  entryId: string;
  viewers: NotePresenceViewer[];
}

export type NotePresenceStreamEvent<TPayload = unknown> = WorkspaceEvent<TPayload>;
