import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { RolaySessionState } from "../settings/data";
import type {
  AddRoomMemberRequest,
  AddRoomMemberResponse,
  AdminRoomListResponse,
  ApiErrorResponse,
  BatchOperationsRequest,
  BatchOperationsResponse,
  BlobDownloadTicketResponse,
  BlobUploadTicketRequest,
  BlobUploadTicketResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  CreateManagedUserRequest,
  CreateRoomRequest,
  CrdtTokenResponse,
  InviteStateResponse,
  JoinRoomRequest,
  LoginRequest,
  LoginResponse,
  MarkdownBootstrapRequest,
  MarkdownBootstrapResponse,
  ManagedUserResponse,
  RefreshRequest,
  RefreshResponse,
  RoomListResponse,
  RoomMemberListResponse,
  TreeSnapshotResponse,
  UpdateInviteStateRequest,
  UpdateProfileRequest,
  UserListResponse,
  UserResponse,
  WorkspaceResponse
} from "../types/protocol";

interface RolayApiClientConfig {
  getServerUrl: () => string;
  getSession: () => RolaySessionState | null;
  saveSession: (session: RolaySessionState | null) => Promise<void>;
}

interface JsonRequestOptions {
  auth?: boolean;
}

export class RolayApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code = "http_error", details?: Record<string, unknown>) {
    super(message);
    this.name = "RolayApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class RolayApiClient {
  private readonly config: RolayApiClientConfig;

  constructor(config: RolayApiClientConfig) {
    this.config = config;
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    const response = await this.requestJson<LoginResponse>(
      "POST",
      "/v1/auth/login",
      request,
      { auth: false }
    );

    await this.config.saveSession({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      user: response.user,
      authenticatedAt: new Date().toISOString()
    });

    return response;
  }

  async refresh(): Promise<RefreshResponse> {
    const session = this.config.getSession();
    if (!session?.refreshToken) {
      throw new Error("No refresh token is stored yet.");
    }

    const body: RefreshRequest = {
      refreshToken: session.refreshToken
    };

    try {
      const response = await this.requestJson<RefreshResponse>(
        "POST",
        "/v1/auth/refresh",
        body,
        { auth: false }
      );

      await this.config.saveSession({
        ...session,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        authenticatedAt: new Date().toISOString()
      });

      return response;
    } catch (error) {
      if (error instanceof RolayApiError && error.status === 401) {
        await this.config.saveSession(null);
      }

      throw error;
    }
  }

  async getCurrentUser(): Promise<UserResponse> {
    return this.requestJson<UserResponse>(
      "GET",
      "/v1/auth/me"
    );
  }

  async updateCurrentUserProfile(body: UpdateProfileRequest): Promise<UserResponse> {
    return this.requestJson<UserResponse>(
      "PATCH",
      "/v1/auth/me/profile",
      body
    );
  }

  async changeCurrentUserPassword(body: ChangePasswordRequest): Promise<ChangePasswordResponse> {
    const response = await this.requestJson<ChangePasswordResponse>(
      "PATCH",
      "/v1/auth/me/password",
      body
    );

    await this.config.saveSession({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      user: response.user,
      authenticatedAt: new Date().toISOString()
    });

    return response;
  }

  async listRooms(): Promise<RoomListResponse> {
    return this.requestJson<RoomListResponse>(
      "GET",
      "/v1/rooms"
    );
  }

  async createRoom(body: CreateRoomRequest): Promise<WorkspaceResponse> {
    return this.requestJson<WorkspaceResponse>(
      "POST",
      "/v1/rooms",
      body
    );
  }

  async joinRoom(body: JoinRoomRequest): Promise<WorkspaceResponse> {
    return this.requestJson<WorkspaceResponse>(
      "POST",
      "/v1/rooms/join",
      body
    );
  }

  async getRoomInvite(workspaceId: string): Promise<InviteStateResponse> {
    return this.requestJson<InviteStateResponse>(
      "GET",
      `/v1/rooms/${encodeURIComponent(workspaceId)}/invite`
    );
  }

  async updateRoomInviteState(
    workspaceId: string,
    body: UpdateInviteStateRequest
  ): Promise<InviteStateResponse> {
    return this.requestJson<InviteStateResponse>(
      "PATCH",
      `/v1/rooms/${encodeURIComponent(workspaceId)}/invite`,
      body
    );
  }

  async regenerateRoomInvite(workspaceId: string): Promise<InviteStateResponse> {
    return this.requestJson<InviteStateResponse>(
      "POST",
      `/v1/rooms/${encodeURIComponent(workspaceId)}/invite/regenerate`
    );
  }

  async listManagedUsers(): Promise<UserListResponse> {
    return this.requestJson<UserListResponse>(
      "GET",
      "/v1/admin/users"
    );
  }

  async createManagedUser(body: CreateManagedUserRequest): Promise<UserResponse> {
    return this.requestJson<UserResponse>(
      "POST",
      "/v1/admin/users",
      body
    );
  }

  async deleteManagedUser(userId: string): Promise<ManagedUserResponse> {
    return this.requestJson<ManagedUserResponse>(
      "DELETE",
      `/v1/admin/users/${encodeURIComponent(userId)}`
    );
  }

  async listAllRoomsAsAdmin(): Promise<AdminRoomListResponse> {
    return this.requestJson<AdminRoomListResponse>(
      "GET",
      "/v1/admin/workspaces"
    );
  }

  async listRoomMembersAsAdmin(workspaceId: string): Promise<RoomMemberListResponse> {
    return this.requestJson<RoomMemberListResponse>(
      "GET",
      `/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/members`
    );
  }

  async addRoomMemberAsAdmin(
    workspaceId: string,
    body: AddRoomMemberRequest
  ): Promise<AddRoomMemberResponse> {
    return this.requestJson<AddRoomMemberResponse>(
      "POST",
      `/v1/admin/workspaces/${encodeURIComponent(workspaceId)}/members`,
      body
    );
  }

  async deleteRoomAsAdmin(workspaceId: string): Promise<WorkspaceResponse> {
    return this.requestJson<WorkspaceResponse>(
      "DELETE",
      `/v1/admin/workspaces/${encodeURIComponent(workspaceId)}`
    );
  }

  async getWorkspaceTree(workspaceId: string): Promise<TreeSnapshotResponse> {
    return this.requestJson<TreeSnapshotResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tree`
    );
  }

  async applyBatchOperations(
    workspaceId: string,
    body: BatchOperationsRequest
  ): Promise<BatchOperationsResponse> {
    return this.requestJson<BatchOperationsResponse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/ops/batch`,
      body
    );
  }

  async createCrdtToken(entryId: string): Promise<CrdtTokenResponse> {
    return this.requestJson<CrdtTokenResponse>(
      "POST",
      `/v1/files/${encodeURIComponent(entryId)}/crdt-token`
    );
  }

  async getWorkspaceMarkdownBootstrap(
    workspaceId: string,
    body?: MarkdownBootstrapRequest
  ): Promise<MarkdownBootstrapResponse> {
    return this.requestJson<MarkdownBootstrapResponse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/markdown/bootstrap`,
      body
    );
  }

  async createBlobUploadTicket(
    entryId: string,
    body: BlobUploadTicketRequest
  ): Promise<BlobUploadTicketResponse> {
    return this.requestJson<BlobUploadTicketResponse>(
      "POST",
      `/v1/files/${encodeURIComponent(entryId)}/blob/upload-ticket`,
      body
    );
  }

  async createBlobDownloadTicket(entryId: string): Promise<BlobDownloadTicketResponse> {
    return this.requestJson<BlobDownloadTicketResponse>(
      "POST",
      `/v1/files/${encodeURIComponent(entryId)}/blob/download-ticket`
    );
  }

  async fetchAuthorizedStream(path: string, init: RequestInit = {}): Promise<Response> {
    const initialToken = await this.getAccessToken();
    let response = await this.fetchStream(path, initialToken, init);

    if (response.status === 401) {
      await this.refresh();
      const nextToken = await this.getAccessToken();
      response = await this.fetchStream(path, nextToken, init);
    }

    if (!response.ok) {
      throw await this.createFetchError(response);
    }

    return response;
  }

  buildAbsoluteUrl(path: string): string {
    return this.buildUrl(path);
  }

  async getValidAccessToken(): Promise<string> {
    return this.getAccessToken();
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    options: JsonRequestOptions = {}
  ): Promise<T> {
    const auth = options.auth !== false;
    const response = auth
      ? await this.requestWithRefresh(method, path, body)
      : await this.performRequest(method, path, body, undefined);

    if (response.status >= 400) {
      throw createRequestUrlError(response);
    }

    return response.json as T;
  }

  private async requestWithRefresh(
    method: string,
    path: string,
    body?: unknown
  ): Promise<RequestUrlResponse> {
    const initialToken = await this.getAccessToken();
    let response = await this.performRequest(method, path, body, initialToken);

    if (response.status === 401) {
      await this.refresh();
      const nextToken = await this.getAccessToken();
      response = await this.performRequest(method, path, body, nextToken);
    }

    if (response.status >= 400) {
      throw createRequestUrlError(response);
    }

    return response;
  }

  private async performRequest(
    method: string,
    path: string,
    body: unknown,
    accessToken?: string
  ): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json"
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    return requestUrl({
      url: this.buildUrl(path),
      method,
      headers,
      contentType: body === undefined ? undefined : "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false
    });
  }

  private async getAccessToken(): Promise<string> {
    const session = this.config.getSession();
    if (session?.accessToken) {
      return session.accessToken;
    }

    if (session?.refreshToken) {
      const response = await this.refresh();
      return response.accessToken;
    }

    throw new Error("You are not authenticated yet.");
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.getServerUrl().trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("Server URL is empty.");
    }

    return `${baseUrl}${path}`;
  }

  private async fetchStream(
    path: string,
    accessToken: string,
    init: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("Accept", "text/event-stream");
    headers.set("Authorization", `Bearer ${accessToken}`);

    return fetch(this.buildUrl(path), {
      ...init,
      headers
    });
  }

  private async createFetchError(response: Response): Promise<RolayApiError> {
    const fallbackMessage = `HTTP ${response.status}`;
    const responseText = await response.text();
    return createTextError(response.status, responseText, fallbackMessage);
  }
}

function createRequestUrlError(response: RequestUrlResponse): RolayApiError {
  return createTextError(response.status, response.text, `HTTP ${response.status}`);
}

function createTextError(
  status: number,
  responseText: string,
  fallbackMessage: string
): RolayApiError {
  try {
    const parsed = JSON.parse(responseText) as ApiErrorResponse;
    if (parsed?.error?.message) {
      return new RolayApiError(
        status,
        parsed.error.message,
        parsed.error.code,
        parsed.error.details
      );
    }
  } catch {
    // Ignore parse failures and fall back to the generic message.
  }

  return new RolayApiError(status, responseText || fallbackMessage);
}
