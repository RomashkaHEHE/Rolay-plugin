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

export interface BlobUploadTicketResponse {
  alreadyExists: boolean;
  upload?: UploadTarget;
}

export interface BlobDownloadTicketResponse {
  hash: string;
  url: string;
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
