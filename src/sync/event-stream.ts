import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { RolayApiClient } from "../api/client";
import type { WorkspaceEvent } from "../types/protocol";

export interface WorkspaceEventStreamHandlers {
  onOpen?: () => void;
  onEvent?: (event: WorkspaceEvent) => Promise<void> | void;
  onStatusChange?: (status: WorkspaceEventStreamStatus) => void;
  onError?: (error: Error) => void;
}

export type WorkspaceEventStreamStatus =
  | "stopped"
  | "connecting"
  | "open"
  | "reconnecting"
  | "error";

export class WorkspaceEventStream {
  private readonly apiClient: RolayApiClient;
  private readonly log: (message: string) => void;
  private abortController: AbortController | null = null;
  private stopped = true;
  private currentCursor: number | null = null;
  private reconnectAttempt = 0;
  private reconnectHandle: number | null = null;
  private workspaceId: string | null = null;
  private handlers: WorkspaceEventStreamHandlers | null = null;
  private connectionGeneration = 0;

  constructor(apiClient: RolayApiClient, log: (message: string) => void) {
    this.apiClient = apiClient;
    this.log = log;
  }

  start(
    workspaceId: string,
    cursor: number | null,
    handlers: WorkspaceEventStreamHandlers
  ): void {
    this.stop();
    this.workspaceId = workspaceId;
    this.currentCursor = cursor;
    this.handlers = handlers;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connectionGeneration += 1;
    this.workspaceId = null;
    this.handlers?.onStatusChange?.("stopped");
    this.abortController?.abort();
    this.abortController = null;

    if (this.reconnectHandle !== null) {
      window.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  getCursor(): number | null {
    return this.currentCursor;
  }

  reconnectNow(reason: string): void {
    if (this.stopped || !this.workspaceId || !this.handlers) {
      return;
    }

    this.log(`Restarting SSE after ${reason}.`);
    this.abortController?.abort();
    this.abortController = null;
    if (this.reconnectHandle !== null) {
      window.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.reconnectAttempt = Math.max(1, this.reconnectAttempt);
    this.handlers.onStatusChange?.("reconnecting");
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.workspaceId || !this.handlers) {
      return;
    }

    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.handlers.onStatusChange?.(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const query = this.currentCursor === null ? "" : `?cursor=${this.currentCursor}`;
      const path = `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/events${query}`;
      const response = await this.openAuthorizedStream(path, abortController.signal);
      if (generation !== this.connectionGeneration || this.stopped) {
        closeStreamResponse(response);
        return;
      }

      this.reconnectAttempt = 0;
      this.handlers.onStatusChange?.("open");
      this.handlers.onOpen?.();
      await this.consumeStream(response, abortController.signal);

      if (!this.stopped && generation === this.connectionGeneration) {
        this.scheduleReconnect();
      }
    } catch (error) {
      if (
        this.stopped ||
        generation !== this.connectionGeneration ||
        isAbortError(error)
      ) {
        return;
      }

      if (isSoftStreamCloseError(error)) {
        this.scheduleReconnect();
        return;
      }

      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.handlers.onStatusChange?.("error");
      this.handlers.onError?.(normalizedError);
      this.scheduleReconnect();
    }
  }

  private async consumeStream(
    response: Response | IncomingMessage,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      closeStreamResponse(response);
      throw createAbortError();
    }

    const parser = createParser({
      onEvent: (message) => {
        void this.handleMessage(message);
      }
    });

    if (isNodeResponse(response)) {
      response.setEncoding("utf8");
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener("abort", abortHandler);
          response.removeListener("end", endHandler);
          response.removeListener("error", errorHandler);
        };
        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          callback();
        };
        const abortHandler = () => {
          const abortError = createAbortError();
          response.destroy(abortError);
          settle(() => reject(abortError));
        };
        const endHandler = () => {
          settle(resolve);
        };
        const errorHandler = (error: Error) => {
          settle(() => reject(error));
        };

        signal.addEventListener("abort", abortHandler, { once: true });
        response.on("data", (chunk: string) => {
          parser.feed(chunk);
        });
        response.on("end", endHandler);
        response.on("error", errorHandler);
      });
      return;
    }

    if (!response.body) {
      throw new Error("SSE response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (!this.stopped && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      parser.feed(decoder.decode(value, { stream: true }));
    }
  }

  private async handleMessage(message: EventSourceMessage): Promise<void> {
    if (!message.event || !message.data) {
      return;
    }

    const eventId = Number(message.id);
    if (Number.isFinite(eventId)) {
      if (this.currentCursor !== null && eventId <= this.currentCursor) {
        return;
      }
      this.currentCursor = eventId;
    }

    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      data = message.data;
    }

    await this.handlers?.onEvent?.({
      id: Number.isFinite(eventId) ? eventId : this.currentCursor ?? 0,
      event: message.event,
      data
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.log(`SSE disconnected. Reconnecting in ${delay}ms.`);
    this.handlers?.onStatusChange?.("reconnecting");
    this.reconnectHandle = window.setTimeout(() => {
      this.reconnectHandle = null;
      void this.connect();
    }, delay);
  }

  private async openAuthorizedStream(
    path: string,
    signal: AbortSignal
  ): Promise<Response | IncomingMessage> {
    const accessToken = await this.apiClient.getValidAccessToken();
    const url = this.apiClient.buildAbsoluteUrl(path);
    let response = await this.openStream(url, accessToken, signal);

    if (getResponseStatus(response) === 401) {
      closeStreamResponse(response);
      await this.apiClient.refresh();
      const refreshedToken = await this.apiClient.getValidAccessToken();
      response = await this.openStream(url, refreshedToken, signal);
    }

    const status = getResponseStatus(response);
    if (status >= 400) {
      throw new Error(`SSE request failed with HTTP ${status}.`);
    }

    return response;
  }

  private async openStream(
    url: string,
    accessToken: string,
    signal: AbortSignal
  ): Promise<Response | IncomingMessage> {
    const nodeRequire = getNodeRequire();
    if (nodeRequire) {
      this.log(`Opening SSE transport=node-${getUrlProtocolName(url)} authority=${new URL(url).origin}.`);
      return openNodeRequest(url, accessToken, signal, nodeRequire, this.apiClient.getClientHeaders());
    }

    this.log(`Opening SSE transport=fetch authority=${new URL(url).origin}.`);
    return fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        ...this.apiClient.getClientHeaders()
      },
      signal
    });
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isSoftStreamCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }

  const message = error.message.trim().toLowerCase();
  return message === "aborted" || message.includes("premature close") || message.includes("socket hang up");
}

function isNodeResponse(response: Response | IncomingMessage): response is IncomingMessage {
  return typeof (response as IncomingMessage).setEncoding === "function";
}

function getResponseStatus(response: Response | IncomingMessage): number {
  return isNodeResponse(response) ? response.statusCode ?? 0 : response.status;
}

function closeStreamResponse(response: Response | IncomingMessage): void {
  if (isNodeResponse(response)) {
    response.destroy();
    return;
  }
  if (response.body) {
    void response.body.cancel().catch(() => undefined);
  }
}

function getUrlProtocolName(url: string): string {
  return new URL(url).protocol.replace(/:$/, "");
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
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

async function openNodeRequest(
  urlString: string,
  accessToken: string,
  signal: AbortSignal,
  nodeRequire: (id: string) => unknown,
  clientHeaders: Record<string, string>
): Promise<IncomingMessage> {
  const url = new URL(urlString);
  const requestModule = (
    url.protocol === "https:" ? nodeRequire("node:https") : nodeRequire("node:http")
  ) as {
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  };

  return new Promise<IncomingMessage>((resolve, reject) => {
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        ...clientHeaders
      }
    };

    const request = requestModule.request(options, (response) => {
      cleanup();
      resolve(response);
    });

    const abortHandler = () => {
      request.destroy(createAbortError());
      cleanup();
      reject(createAbortError());
    };

    const errorHandler = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      signal.removeEventListener("abort", abortHandler);
      request.removeListener("error", errorHandler);
    };

    signal.addEventListener("abort", abortHandler, { once: true });
    request.on("error", errorHandler);
    request.end();
  });
}
