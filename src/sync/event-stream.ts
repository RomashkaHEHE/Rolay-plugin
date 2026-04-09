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

  private async connect(): Promise<void> {
    if (this.stopped || !this.workspaceId || !this.handlers) {
      return;
    }

    this.handlers.onStatusChange?.(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.abortController = new AbortController();

    try {
      const query = this.currentCursor === null ? "" : `?cursor=${this.currentCursor}`;
      const path = `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/events${query}`;
      const response = await this.openAuthorizedStream(path, this.abortController.signal);

      this.reconnectAttempt = 0;
      this.handlers.onStatusChange?.("open");
      this.handlers.onOpen?.();
      await this.consumeStream(response, this.abortController.signal);

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    } catch (error) {
      if (this.stopped || isAbortError(error)) {
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
    const parser = createParser({
      onEvent: (message) => {
        void this.handleMessage(message);
      }
    });

    if (isNodeResponse(response)) {
      response.setEncoding("utf8");
      await new Promise<void>((resolve, reject) => {
        const abortHandler = () => {
          reject(createAbortError());
        };

        signal.addEventListener("abort", abortHandler, { once: true });
        response.on("data", (chunk: string) => {
          parser.feed(chunk);
        });
        response.on("end", () => {
          signal.removeEventListener("abort", abortHandler);
          resolve();
        });
        response.on("error", (error: Error) => {
          signal.removeEventListener("abort", abortHandler);
          reject(error);
        });
      });
      return;
    }

    if (!response.body) {
      throw new Error("SSE response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (!this.stopped) {
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
      return openNodeRequest(url, accessToken, signal, nodeRequire);
    }

    return fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`
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

function isNodeResponse(response: Response | IncomingMessage): response is IncomingMessage {
  return typeof (response as IncomingMessage).setEncoding === "function";
}

function getResponseStatus(response: Response | IncomingMessage): number {
  return isNodeResponse(response) ? response.statusCode ?? 0 : response.status;
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
  nodeRequire: (id: string) => unknown
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
        Authorization: `Bearer ${accessToken}`
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
