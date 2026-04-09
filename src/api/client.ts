import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { RolaySessionState } from "../settings/data";
import type {
  AddRoomMemberRequest,
  AddRoomMemberResponse,
  AdminRoomListResponse,
  ApiErrorResponse,
  BatchOperationsRequest,
  BatchOperationsResponse,
  BlobUploadCancelResponse,
  BlobDownloadTicketResponse,
  BlobUploadContentResponse,
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

export interface BlobTransferProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface BlobDownloadResult {
  data: ArrayBuffer;
  contentType: string | null;
  contentLength: number | null;
  hash: string | null;
}

const MAX_BINARY_REDIRECTS = 5;

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

  async cancelBlobUpload(
    entryId: string,
    uploadId: string
  ): Promise<BlobUploadCancelResponse> {
    return this.requestJson<BlobUploadCancelResponse>(
      "DELETE",
      `/v1/files/${encodeURIComponent(entryId)}/blob/uploads/${encodeURIComponent(uploadId)}`
    );
  }

  async uploadBlobContent(
    entryId: string,
    uploadId: string,
    data: ArrayBuffer,
    expectedHash: string,
    onProgress?: (progress: BlobTransferProgress) => void,
    signal?: AbortSignal,
    fallbackTarget?: BlobUploadTicketResponse["upload"]
  ): Promise<BlobUploadContentResponse> {
    const path =
      `/v1/files/${encodeURIComponent(entryId)}/blob/uploads/${encodeURIComponent(uploadId)}/content`;

    try {
      return await this.uploadBlobContentWithRefresh(
        path,
        data,
        expectedHash,
        onProgress,
        signal
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      if (!fallbackTarget || !shouldFallbackToRawUpload(error)) {
        throw error;
      }

      try {
        await this.uploadBlobToTarget(fallbackTarget, data, onProgress, signal);
        return {
          ok: true,
          hash: expectedHash,
          sizeBytes: data.byteLength
        };
      } catch (fallbackError) {
        if (fallbackError instanceof Error && fallbackError.name === "AbortError") {
          throw fallbackError;
        }

        throw new Error(
          `Authenticated blob upload failed (${formatUploadTransportError(error)}); ` +
          `raw upload fallback also failed (${formatUploadTransportError(fallbackError)}).`
        );
      }
    }
  }

  async uploadBlobToTarget(
    target: BlobUploadTicketResponse["upload"],
    data: ArrayBuffer,
    onProgress?: (progress: BlobTransferProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const uploadTarget = target;
    if (!uploadTarget) {
      throw new Error("Blob upload target is missing.");
    }

    const transportErrors: string[] = [];

    const electronUpload = tryElectronBinaryUpload(uploadTarget, data, onProgress, signal);
    if (electronUpload) {
      try {
        await electronUpload;
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        transportErrors.push(`electron: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      transportErrors.push("electron: unavailable");
    }

    const nodeUpload = tryNodeBinaryUpload(uploadTarget, data, onProgress, signal);
    if (nodeUpload) {
      try {
        await nodeUpload;
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        transportErrors.push(`node: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      transportErrors.push("node: unavailable");
    }

    try {
      await xhrBinaryRequest<void>({
        method: uploadTarget.method,
        url: uploadTarget.url,
        headers: uploadTarget.headers,
        body: data,
        signal,
        onUploadProgress: onProgress
      });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      transportErrors.push(`xhr: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const response = await fetch(uploadTarget.url, {
        method: uploadTarget.method,
        headers: uploadTarget.headers,
        body: new Uint8Array(data),
        signal
      });

      if (!response.ok) {
        throw await this.createFetchError(response);
      }

      onProgress?.({
        loadedBytes: data.byteLength,
        totalBytes: data.byteLength
      });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      transportErrors.push(`fetch: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`Blob upload failed via all transports (${transportErrors.join("; ")})`);
  }

  async downloadBlobFromUrl(
    url: string,
    onProgress?: (progress: BlobTransferProgress) => void,
    signal?: AbortSignal
  ): Promise<BlobDownloadResult> {
    const transportErrors: string[] = [];

    const electronDownload = tryElectronBinaryDownload(url, onProgress, signal);
    if (electronDownload) {
      try {
        return await electronDownload;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        transportErrors.push(`electron: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      transportErrors.push("electron: unavailable");
    }

    const nodeDownload = tryNodeBinaryDownload(url, onProgress, signal);
    if (nodeDownload) {
      try {
        return await nodeDownload;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        transportErrors.push(`node: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      transportErrors.push("node: unavailable");
    }

    try {
      return await xhrBinaryRequest<BlobDownloadResult>({
        method: "GET",
        url,
        responseType: "arraybuffer",
        signal,
        onDownloadProgress: onProgress,
        mapResponse: (request) => {
          const data = normalizeArrayBufferResponse(request.response);

          return {
            data,
            contentType: request.getResponseHeader("Content-Type"),
            contentLength: parseContentLengthHeader(request.getResponseHeader("Content-Length")),
            hash: request.getResponseHeader("X-Rolay-Blob-Hash")
          };
        }
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      transportErrors.push(`xhr: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      return await fetchBinaryDownload(url, onProgress, signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      transportErrors.push(`fetch: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`Blob download failed via all transports (${transportErrors.join("; ")})`);
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

  private async uploadBlobContentWithRefresh(
    path: string,
    data: ArrayBuffer,
    expectedHash: string,
    onProgress?: (progress: BlobTransferProgress) => void,
    signal?: AbortSignal
  ): Promise<BlobUploadContentResponse> {
    const initialToken = await this.getAccessToken();

    try {
      return await this.performAuthorizedBlobUpload(
        path,
        initialToken,
        data,
        expectedHash,
        onProgress,
        signal
      );
    } catch (error) {
      if (!(error instanceof RolayApiError) || error.status !== 401) {
        throw error;
      }

      await this.refresh();
      const nextToken = await this.getAccessToken();
      return this.performAuthorizedBlobUpload(
        path,
        nextToken,
        data,
        expectedHash,
        onProgress,
        signal
      );
    }
  }

  private async performAuthorizedBlobUpload(
    path: string,
    accessToken: string,
    data: ArrayBuffer,
    expectedHash: string,
    onProgress?: (progress: BlobTransferProgress) => void,
    signal?: AbortSignal
  ): Promise<BlobUploadContentResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream"
    };

    const absoluteUrl = this.buildUrl(path);

    const nodeResponse = tryNodeBinaryRequest(
      {
        method: "PUT",
        url: absoluteUrl,
        headers
      },
      data,
      onProgress,
      signal
    );
    if (nodeResponse) {
      const response = await nodeResponse;
      if (response.status >= 200 && response.status < 300) {
        return parseBlobUploadContentResponse(
          response.text,
          expectedHash,
          data.byteLength
        );
      }

      throw createTextError(response.status, response.text, response.statusText || `HTTP ${response.status}`);
    }

    try {
      return await xhrBinaryRequest<BlobUploadContentResponse>({
        method: "PUT",
        url: absoluteUrl,
        headers,
        body: data,
        signal,
        onUploadProgress: onProgress,
        mapResponse: (request) => {
          return parseBlobUploadContentResponse(
            extractXhrResponseText(request),
            expectedHash,
            data.byteLength
          );
        }
      });
    } catch (error) {
      if (error instanceof RolayApiError || (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
    }

    const response = await fetch(absoluteUrl, {
      method: "PUT",
      headers,
      body: new Uint8Array(data),
      signal
    });

    if (!response.ok) {
      throw await this.createFetchError(response);
    }

    onProgress?.({
      loadedBytes: data.byteLength,
      totalBytes: data.byteLength
    });

    return parseBlobUploadContentResponse(
      await response.text(),
      expectedHash,
      data.byteLength
    );
  }
}

interface XhrBinaryRequestOptions<TResult> {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  responseType?: XMLHttpRequestResponseType;
  signal?: AbortSignal;
  onUploadProgress?: (progress: BlobTransferProgress) => void;
  onDownloadProgress?: (progress: BlobTransferProgress) => void;
  mapResponse?: (request: XMLHttpRequest) => TResult;
}

function xhrBinaryRequest<TResult = void>(
  options: XhrBinaryRequestOptions<TResult>
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method, options.url, true);
    request.responseType = options.responseType ?? "";

    for (const [header, value] of Object.entries(options.headers ?? {})) {
      request.setRequestHeader(header, value);
    }

    const cleanup = () => {
      options.signal?.removeEventListener("abort", abortHandler);
    };

    const abortHandler = () => {
      request.abort();
      cleanup();
      reject(createAbortError());
    };

    if (options.signal) {
      if (options.signal.aborted) {
        reject(createAbortError());
        return;
      }

      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    request.upload.onprogress = (event) => {
      if (!options.onUploadProgress) {
        return;
      }

      options.onUploadProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : options.body?.byteLength ?? 0
      });
    };

    request.onprogress = (event) => {
      if (!options.onDownloadProgress) {
        return;
      }

      options.onDownloadProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : 0
      });
    };

    request.onerror = () => {
      cleanup();
      reject(new Error(`Request to ${options.url} failed.`));
    };

    request.onabort = () => {
      cleanup();
      reject(createAbortError());
    };

    request.onload = () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        reject(
          createTextError(
            request.status,
            extractXhrResponseText(request),
            request.statusText || `HTTP ${request.status}`
          )
        );
        return;
      }

      if (options.mapResponse) {
        resolve(options.mapResponse(request));
        return;
      }

      resolve(undefined as TResult);
    };

    request.send(options.body);
  });
}

function tryNodeBinaryUpload(
  target: NonNullable<BlobUploadTicketResponse["upload"]>,
  data: ArrayBuffer,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<void> | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) {
    return null;
  }

  const targetUrl = new URL(target.url);
  const requestModule = nodeRequire(targetUrl.protocol === "https:" ? "node:https" : "node:http") as {
    request: (
      options: {
        protocol: string;
        hostname: string;
        port?: number;
        path: string;
        method: string;
        headers: Record<string, string>;
      },
      callback: (response: NodeLikeIncomingMessage) => void
    ) => NodeLikeClientRequest;
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const headers = { ...target.headers };
    if (!hasHeader(headers, "content-length")) {
      headers["Content-Length"] = String(data.byteLength);
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const abortHandler = () => {
      request.destroy(createAbortError());
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    const request = requestModule.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: target.method,
        headers
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: unknown) => {
          if (typeof chunk === "string") {
            chunks.push(Buffer.from(chunk));
            return;
          }

          chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer));
        });

        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const responseText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
            finishReject(createTextError(status, responseText, response.statusMessage || `HTTP ${status}`));
            return;
          }

          onProgress?.({
            loadedBytes: data.byteLength,
            totalBytes: data.byteLength
          });
          finishResolve();
        });
      }
    );

    request.on("error", (error: Error) => {
      finishReject(new Error(`Request to ${target.url} failed: ${error.message}`));
    });

    request.write(Buffer.from(new Uint8Array(data)));
    request.end();
  });
}

function tryElectronBinaryUpload(
  target: NonNullable<BlobUploadTicketResponse["upload"]>,
  data: ArrayBuffer,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<void> | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) {
    return null;
  }

  let electronModule: {
    net?: {
      request: (options: {
        method: string;
        url: string;
      }) => ElectronLikeClientRequest;
    };
  } | null = null;

  try {
    electronModule = nodeRequire("electron") as {
      net?: {
        request: (options: {
          method: string;
          url: string;
        }) => ElectronLikeClientRequest;
      };
    };
  } catch {
    return null;
  }

  if (!electronModule?.net?.request) {
    return null;
  }

  const electronNet = electronModule.net;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const request = electronNet.request({
      method: target.method,
      url: target.url
    });

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const abortHandler = () => {
      request.abort();
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    for (const [header, value] of Object.entries(target.headers)) {
      request.setHeader(header, value);
    }

    if (!hasHeader(target.headers, "content-length")) {
      request.setHeader("Content-Length", String(data.byteLength));
    }

    request.on("response", (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: unknown) => {
        if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk));
          return;
        }

        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer));
      });

      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const responseText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
          finishReject(createTextError(status, responseText, response.statusMessage || `HTTP ${status}`));
          return;
        }

        onProgress?.({
          loadedBytes: data.byteLength,
          totalBytes: data.byteLength
        });
        finishResolve();
      });
    });

    request.on("error", (error: Error) => {
      finishReject(new Error(`Request to ${target.url} failed: ${error.message}`));
    });

    request.write(Buffer.from(new Uint8Array(data)));
    request.end();
  });
}

function tryNodeBinaryDownload(
  urlString: string,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<BlobDownloadResult> | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) {
    return null;
  }

  return startNodeBinaryDownload(urlString, onProgress, signal, nodeRequire, 0);
}

function startNodeBinaryDownload(
  urlString: string,
  onProgress: ((progress: BlobTransferProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  nodeRequire: (id: string) => unknown,
  redirectCount: number
): Promise<BlobDownloadResult> {
  if (redirectCount > MAX_BINARY_REDIRECTS) {
    return Promise.reject(new Error(`Binary download redirect limit exceeded for ${urlString}.`));
  }

  const targetUrl = new URL(urlString);
  const requestModule = nodeRequire(targetUrl.protocol === "https:" ? "node:https" : "node:http") as {
    request: (
      options: {
        protocol: string;
        hostname: string;
        port?: number;
        path: string;
        method: string;
      },
      callback: (response: NodeLikeIncomingMessage) => void
    ) => NodeLikeClientRequest;
  };

  return new Promise<BlobDownloadResult>((resolve, reject) => {
    let settled = false;
    let request!: NodeLikeClientRequest;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = (result: BlobDownloadResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const abortHandler = () => {
      request.destroy(createAbortError());
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    request = requestModule.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: "GET"
      },
      (response) => {
        const totalBytes = parseContentLengthHeader(getHeaderValue(response.headers, "content-length"));
        const chunks: Uint8Array[] = [];
        let loadedBytes = 0;

        response.on("data", (chunk: unknown) => {
          const bytes =
            typeof chunk === "string"
              ? Buffer.from(chunk)
              : chunk instanceof Uint8Array
                ? chunk
                : Buffer.from(chunk as ArrayBuffer);
          chunks.push(bytes);
          loadedBytes += bytes.byteLength;
          onProgress?.({
            loadedBytes,
            totalBytes: totalBytes ?? loadedBytes
          });
        });

        response.on("end", async () => {
          const status = response.statusCode ?? 0;
          const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
          const location = getHeaderValue(response.headers, "location");
          if (status >= 300 && status < 400 && location) {
            try {
              const redirectedUrl = new URL(location, urlString).toString();
              const redirectedResult = await startNodeBinaryDownload(
                redirectedUrl,
                onProgress,
                signal,
                nodeRequire,
                redirectCount + 1
              );
              finishResolve(redirectedResult);
            } catch (error) {
              finishReject(error);
            }
            return;
          }

          if (status < 200 || status >= 300) {
            finishReject(createTextError(status, buffer.toString("utf8"), response.statusMessage || `HTTP ${status}`));
            return;
          }

          finishResolve({
            data: normalizeArrayBufferResponse(buffer),
            contentType: getHeaderValue(response.headers, "content-type"),
            contentLength: totalBytes,
            hash: getHeaderValue(response.headers, "x-rolay-blob-hash")
          });
        });
      }
    );

    request.on("error", (error: Error) => {
      finishReject(new Error(`Request to ${urlString} failed: ${error.message}`));
    });

    request.end();
  });
}

function tryElectronBinaryDownload(
  url: string,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<BlobDownloadResult> | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) {
    return null;
  }

  let electronModule: {
    net?: {
      request: (options: {
        method: string;
        url: string;
      }) => ElectronLikeClientRequest;
    };
  } | null = null;

  try {
    electronModule = nodeRequire("electron") as {
      net?: {
        request: (options: {
          method: string;
          url: string;
        }) => ElectronLikeClientRequest;
      };
    };
  } catch {
    return null;
  }

  if (!electronModule?.net?.request) {
    return null;
  }

  return startElectronBinaryDownload(url, onProgress, signal, electronModule.net, 0);
}

function startElectronBinaryDownload(
  url: string,
  onProgress: ((progress: BlobTransferProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  electronNet: NonNullable<NonNullable<{
    request: (options: {
      method: string;
      url: string;
    }) => ElectronLikeClientRequest;
  }>>,
  redirectCount: number
): Promise<BlobDownloadResult> {
  if (redirectCount > MAX_BINARY_REDIRECTS) {
    return Promise.reject(new Error(`Binary download redirect limit exceeded for ${url}.`));
  }

  return new Promise<BlobDownloadResult>((resolve, reject) => {
    let settled = false;
    const request = electronNet.request({
      method: "GET",
      url
    });

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = (result: BlobDownloadResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const abortHandler = () => {
      request.abort();
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    request.on("response", (response) => {
      const totalBytes = parseContentLengthHeader(getHeaderValue(response.headers, "content-length"));
      const chunks: Uint8Array[] = [];
      let loadedBytes = 0;

      response.on("data", (chunk: unknown) => {
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : chunk instanceof Uint8Array
              ? chunk
              : Buffer.from(chunk as ArrayBuffer);
        chunks.push(bytes);
        loadedBytes += bytes.byteLength;
        onProgress?.({
          loadedBytes,
          totalBytes: totalBytes ?? loadedBytes
        });
      });

      response.on("end", async () => {
        const status = response.statusCode ?? 0;
        const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const location = getHeaderValue(response.headers, "location");
        if (status >= 300 && status < 400 && location) {
          try {
            const redirectedUrl = new URL(location, url).toString();
            const redirectedResult = await startElectronBinaryDownload(
              redirectedUrl,
              onProgress,
              signal,
              electronNet,
              redirectCount + 1
            );
            finishResolve(redirectedResult);
          } catch (error) {
            finishReject(error);
          }
          return;
        }

        if (status < 200 || status >= 300) {
          finishReject(createTextError(status, buffer.toString("utf8"), response.statusMessage || `HTTP ${status}`));
          return;
        }

        finishResolve({
          data: normalizeArrayBufferResponse(buffer),
          contentType: getHeaderValue(response.headers, "content-type"),
          contentLength: totalBytes,
          hash: getHeaderValue(response.headers, "x-rolay-blob-hash")
        });
      });
    });

    request.on("error", (error: Error) => {
      finishReject(new Error(`Request to ${url} failed: ${error.message}`));
    });

    request.end();
  });
}

interface NodeLikeIncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "end", listener: () => void): this;
}

interface NodeLikeClientRequest {
  on(event: "error", listener: (error: Error) => void): this;
  write(chunk: Uint8Array): void;
  end(): void;
  destroy(error?: Error): void;
}

interface ElectronLikeIncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "end", listener: () => void): this;
}

interface ElectronLikeClientRequest {
  on(event: "response", listener: (response: ElectronLikeIncomingMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): void;
  end(): void;
  abort(): void;
}

interface BinaryRequestResponse {
  status: number;
  statusText: string;
  text: string;
}

function hasHeader(headers: Record<string, string>, expectedName: string): boolean {
  const normalizedExpected = expectedName.toLowerCase();
  return Object.keys(headers).some((header) => header.toLowerCase() === normalizedExpected);
}

function tryNodeBinaryRequest(
  requestTarget: {
    method: string;
    url: string;
    headers: Record<string, string>;
  },
  data: ArrayBuffer,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<BinaryRequestResponse> | null {
  const nodeRequire = getNodeRequire();
  if (!nodeRequire) {
    return null;
  }

  const targetUrl = new URL(requestTarget.url);
  const requestModule = nodeRequire(targetUrl.protocol === "https:" ? "node:https" : "node:http") as {
    request: (
      options: {
        protocol: string;
        hostname: string;
        port?: number;
        path: string;
        method: string;
        headers: Record<string, string>;
      },
      callback: (response: NodeLikeIncomingMessage) => void
    ) => NodeLikeClientRequest;
  };

  return new Promise<BinaryRequestResponse>((resolve, reject) => {
    let settled = false;
    const headers = { ...requestTarget.headers };
    if (!hasHeader(headers, "content-length")) {
      headers["Content-Length"] = String(data.byteLength);
    }

    let request!: NodeLikeClientRequest;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = (response: BinaryRequestResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };

    const abortHandler = () => {
      request.destroy(createAbortError());
      finishReject(createAbortError());
    };

    if (signal?.aborted) {
      finishReject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    request = requestModule.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: requestTarget.method,
        headers
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: unknown) => {
          if (typeof chunk === "string") {
            chunks.push(Buffer.from(chunk));
            return;
          }

          chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer));
        });

        response.on("end", () => {
          onProgress?.({
            loadedBytes: data.byteLength,
            totalBytes: data.byteLength
          });

          finishResolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
          });
        });
      }
    );

    request.on("error", (error: Error) => {
      finishReject(new Error(`Request to ${requestTarget.url} failed: ${error.message}`));
    });

    request.write(Buffer.from(new Uint8Array(data)));
    request.end();
  });
}

function createRequestUrlError(response: RequestUrlResponse): RolayApiError {
  return createTextError(response.status, response.text, `HTTP ${response.status}`);
}

function parseBlobUploadContentResponse(
  responseText: string,
  expectedHash: string,
  fallbackSizeBytes: number
): BlobUploadContentResponse {
  if (!responseText.trim()) {
    return {
      ok: true,
      hash: expectedHash,
      sizeBytes: fallbackSizeBytes
    };
  }

  try {
    const parsed = JSON.parse(responseText) as Partial<BlobUploadContentResponse>;
    if (parsed?.ok === true) {
      return {
        ok: true,
        hash: typeof parsed.hash === "string" && parsed.hash.trim()
          ? parsed.hash
          : expectedHash,
        sizeBytes: typeof parsed.sizeBytes === "number" && parsed.sizeBytes >= 0
          ? parsed.sizeBytes
          : fallbackSizeBytes
      };
    }
  } catch {
    // Ignore parse failures and fall back to the expected upload result.
  }

  return {
    ok: true,
    hash: expectedHash,
    sizeBytes: fallbackSizeBytes
  };
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

function parseContentLengthHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  expectedName: string
): string | null {
  if (!headers) {
    return null;
  }

  const normalizedExpected = expectedName.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== normalizedExpected) {
      continue;
    }

    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return value ?? null;
  }

  return null;
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function normalizeArrayBufferResponse(response: unknown): ArrayBuffer {
  if (response instanceof ArrayBuffer) {
    return response;
  }

  if (ArrayBuffer.isView(response)) {
    const view = response;
    return toOwnedArrayBuffer(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }

  return new ArrayBuffer(0);
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function fetchBinaryDownload(
  url: string,
  onProgress?: (progress: BlobTransferProgress) => void,
  signal?: AbortSignal
): Promise<BlobDownloadResult> {
  const response = await fetch(url, {
    method: "GET",
    signal
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw createTextError(response.status, responseText, `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Binary download response body is empty.");
  }

  const totalBytes = parseContentLengthHeader(response.headers.get("Content-Length"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress?.({
      loadedBytes,
      totalBytes: totalBytes ?? loadedBytes
    });
  }

  return {
    data: toOwnedArrayBuffer(concatUint8Arrays(chunks)),
    contentType: response.headers.get("Content-Type"),
    contentLength: totalBytes,
    hash: response.headers.get("X-Rolay-Blob-Hash")
  };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function extractXhrResponseText(request: XMLHttpRequest): string {
  try {
    if (typeof request.responseText === "string") {
      return request.responseText;
    }
  } catch {
    // Accessing responseText may fail for non-text response types.
  }

  const response = request.response;
  if (typeof response === "string") {
    return response;
  }

  return "";
}

function shouldFallbackToRawUpload(error: unknown): boolean {
  if (!(error instanceof RolayApiError)) {
    return true;
  }

  return error.status === 404 ||
    error.status === 405 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500;
}

function formatUploadTransportError(error: unknown): string {
  if (error instanceof RolayApiError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getNodeRequire(): ((id: string) => unknown) | null {
  const candidate =
    (globalThis as { require?: (id: string) => unknown }).require ??
    (globalThis as { window?: { require?: (id: string) => unknown } }).window?.require;

  if (typeof candidate === "function") {
    return candidate;
  }

  try {
    return (Function("return typeof require === 'function' ? require : undefined;")() as
      | ((id: string) => unknown)
      | undefined
      | null) ?? null;
  } catch {
    return null;
  }
}
