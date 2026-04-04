import { HocuspocusProvider } from "@hocuspocus/provider";
import { MarkdownView, Notice, TFile, type App, type Editor } from "obsidian";
import * as Y from "yjs";
import { RolayApiClient } from "../api/client";
import {
  getCodeMirrorEditorView,
  getMarkdownViewsForFile,
  getMarkdownEditorViewsForFile,
  setRemotePresenceDecorations,
  type SharedCursorPresence
} from "./shared-presence";
import { applyTextPatchToEditor, diffText } from "../utils/text-diff";
import type { FileEntry, User } from "../types/protocol";

const LOCAL_EDITOR_ORIGIN = "rolay-local-editor";

export interface CrdtSessionState {
  entryId: string;
  filePath: string;
  docId: string;
  status: "idle" | "connecting" | "synced" | "offline";
}

interface CrdtSessionManagerConfig {
  app: App;
  apiClient: RolayApiClient;
  getCurrentUser: () => User | null;
  isLiveSyncEnabledForLocalPath: (localPath: string) => boolean;
  getPersistedCrdtState: (entryId: string) => Uint8Array | null;
  persistCrdtState: (entryId: string, filePath: string, state: Uint8Array) => void;
  resolveEntryByLocalPath: (localPath: string) => FileEntry | null;
  log: (message: string) => void;
}

export class CrdtSessionManager {
  private readonly app: App;
  private readonly apiClient: RolayApiClient;
  private readonly getCurrentUser: () => User | null;
  private readonly isLiveSyncEnabledForLocalPath: (localPath: string) => boolean;
  private readonly getPersistedCrdtState: (entryId: string) => Uint8Array | null;
  private readonly persistCrdtState: (entryId: string, filePath: string, state: Uint8Array) => void;
  private readonly resolveEntryByLocalPath: (localPath: string) => FileEntry | null;
  private readonly log: (message: string) => void;
  private readonly pendingOfflineUpdates = new Map<string, Uint8Array>();
  private activeSession: BoundCrdtSession | null = null;

  constructor(config: CrdtSessionManagerConfig) {
    this.app = config.app;
    this.apiClient = config.apiClient;
    this.getCurrentUser = config.getCurrentUser;
    this.isLiveSyncEnabledForLocalPath = config.isLiveSyncEnabledForLocalPath;
    this.getPersistedCrdtState = config.getPersistedCrdtState;
    this.persistCrdtState = config.persistCrdtState;
    this.resolveEntryByLocalPath = config.resolveEntryByLocalPath;
    this.log = config.log;
  }

  async bindToFile(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") {
      await this.disconnect();
      return;
    }

    const entry = this.resolveEntryByLocalPath(file.path);
    if (!entry || entry.kind !== "markdown") {
      await this.disconnect();
      return;
    }

    const liveSyncEnabled = this.isLiveSyncEnabledForLocalPath(file.path);
    const persistedCrdtState = this.getPersistedCrdtState(entry.id);

    if (this.activeSession?.matches(file, entry)) {
      if (liveSyncEnabled && this.activeSession.isOffline()) {
        const pendingOfflineUpdate = this.detachActiveSession() ?? persistedCrdtState;
        await this.activeSession.destroy();
        this.activeSession = null;
        await this.connect(file, entry, pendingOfflineUpdate);
        return;
      }

      if (!liveSyncEnabled) {
        await this.activeSession.goOffline();
      }

      this.activeSession.syncEditorContext();
      return;
    }

    await this.disconnect();

    if (liveSyncEnabled) {
      await this.connect(file, entry, persistedCrdtState);
      return;
    }

    const pendingOfflineUpdate = this.pendingOfflineUpdates.get(entry.id) ?? persistedCrdtState;
    if (pendingOfflineUpdate) {
      await this.openOffline(file, entry, pendingOfflineUpdate);
      return;
    }

    this.log(`No persisted CRDT cache is available for offline markdown ${file.path}. Remote-safe merge will start after the next live sync.`);
  }

  async refreshActiveSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const { file } = this.activeSession;
    await this.bindToFile(file);
  }

  async disconnect(): Promise<void> {
    this.detachActiveSession();
    await this.activeSession?.destroy();
    this.activeSession = null;
  }

  handleEditorChange(editor: Editor, view: MarkdownView): void {
    if (!this.activeSession || !view.file) {
      return;
    }

    if (view.file.path !== this.activeSession.file.path) {
      return;
    }

    this.activeSession.pushLocalText(editor.getValue());
  }

  handleEditorSelectionChange(filePath: string, editor: Editor, focused: boolean): void {
    if (!this.activeSession || filePath !== this.activeSession.file.path) {
      return;
    }

    this.activeSession.updateLocalPresence(editor, focused);
  }

  async goOffline(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    await this.activeSession.goOffline();
  }

  getState(): CrdtSessionState | null {
    if (!this.activeSession) {
      return null;
    }

    return this.activeSession.getState();
  }

  async seedRemoteMarkdown(entry: FileEntry, localText: string, contextLabel = entry.path): Promise<void> {
    if (!localText) {
      return;
    }

    await this.mergeRemoteMarkdownState(entry, createMarkdownTextState(localText), contextLabel);
  }

  async mergeRemoteMarkdownState(
    entry: FileEntry,
    localState: Uint8Array,
    contextLabel = entry.path
  ): Promise<void> {
    if (localState.byteLength === 0) {
      return;
    }

    this.log(`Merging local markdown state into remote CRDT doc for ${contextLabel}.`);
    const bootstrap = await this.apiClient.createCrdtToken(entry.id);
    await mergeRemoteMarkdownState({
      wsUrl: bootstrap.wsUrl,
      docId: bootstrap.docId,
      token: createCrdtTokenSupplier(this.apiClient, entry.id, bootstrap.token),
      localState,
      log: this.log,
      contextLabel
    });
  }

  private async connect(file: TFile, entry: FileEntry, pendingOfflineUpdate?: Uint8Array | null): Promise<void> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      this.log(`Skipping CRDT session for ${file.path} because no authenticated user is available.`);
      return;
    }

    this.log(`Opening CRDT session for ${file.path}.`);

    const bootstrap = await this.apiClient.createCrdtToken(entry.id);
    const session = new BoundCrdtSession(
      this.app,
      file,
      entry,
      currentUser,
      bootstrap.docId,
      bootstrap.wsUrl,
      createCrdtTokenSupplier(this.apiClient, entry.id, bootstrap.token),
      this.log,
      this.persistCrdtState,
      pendingOfflineUpdate ?? this.pendingOfflineUpdates.get(entry.id) ?? null
    );

    this.activeSession = session;
    await session.open();
    this.pendingOfflineUpdates.delete(entry.id);
  }

  private async openOffline(file: TFile, entry: FileEntry, pendingOfflineUpdate: Uint8Array): Promise<void> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      return;
    }

    const session = new BoundCrdtSession(
      this.app,
      file,
      entry,
      currentUser,
      entry.id,
      null,
      null,
      this.log,
      this.persistCrdtState,
      pendingOfflineUpdate
    );

    this.activeSession = session;
    await session.openOffline();
    this.pendingOfflineUpdates.delete(entry.id);
  }

  private detachActiveSession(): Uint8Array | null {
    if (!this.activeSession) {
      return null;
    }

    const pendingOfflineUpdate = this.activeSession.capturePendingOfflineUpdate();
    if (pendingOfflineUpdate) {
      this.pendingOfflineUpdates.set(this.activeSession.entry.id, pendingOfflineUpdate);
      this.persistCrdtState(this.activeSession.entry.id, this.activeSession.file.path, pendingOfflineUpdate);
    }
    return pendingOfflineUpdate;
  }
}

interface AwarenessUserPayload {
  userId: string;
  displayName: string;
  color: string;
}

interface AwarenessSelectionPayload {
  anchor: number;
  head: number;
}

class BoundCrdtSession {
  readonly file: TFile;
  readonly entry: FileEntry;

  private readonly app: App;
  private readonly currentUser: User;
  private readonly log: (message: string) => void;
  private readonly persistCrdtState: (entryId: string, filePath: string, state: Uint8Array) => void;
  private readonly docId: string;
  private readonly wsUrl: string | null;
  private readonly token: string | (() => Promise<string>) | null;
  private readonly awarenessUser: AwarenessUserPayload;
  private readonly yDocument = new Y.Doc();
  private readonly yText: Y.Text;
  private provider: HocuspocusProvider | null = null;
  private status: "idle" | "connecting" | "synced" | "offline" = "idle";
  private applyingRemoteText = false;
  private lastLocalSelectionKey: string | null = null;
  private remoteObserverBound = false;
  private persistenceObserverBound = false;
  private persistHandle: number | null = null;
  private pendingOfflineUpdate: Uint8Array | null;

  constructor(
    app: App,
    file: TFile,
    entry: FileEntry,
    currentUser: User,
    docId: string,
    wsUrl: string | null,
    token: string | (() => Promise<string>) | null,
    log: (message: string) => void,
    persistCrdtState: (entryId: string, filePath: string, state: Uint8Array) => void,
    pendingOfflineUpdate: Uint8Array | null = null
  ) {
    this.app = app;
    this.file = file;
    this.entry = entry;
    this.currentUser = currentUser;
    this.docId = docId;
    this.wsUrl = wsUrl;
    this.token = token;
    this.log = log;
    this.persistCrdtState = persistCrdtState;
    this.awarenessUser = buildAwarenessUserPayload(currentUser);
    this.yText = this.yDocument.getText("content");
    this.pendingOfflineUpdate = pendingOfflineUpdate;
  }

  async open(): Promise<void> {
    if (!this.wsUrl || !this.token) {
      throw new Error(`CRDT bootstrap is missing for ${this.file.path}.`);
    }

    this.status = "connecting";
    this.bindRemoteObserver();
    this.bindPersistenceObserver();

    this.provider = new HocuspocusProvider({
      url: this.wsUrl,
      name: this.docId,
      document: this.yDocument,
      token: this.token,
      onOpen: () => {
        this.log(`CRDT websocket opened for ${this.file.path}.`);
      },
      onStatus: ({ status }) => {
        this.log(`CRDT provider status for ${this.file.path}: ${status}.`);
      },
      onSynced: () => {
        this.status = "synced";
        this.applyPendingOfflineUpdateIfNeeded();
        this.syncEditorContext();
      },
      onAwarenessChange: () => {
        this.renderRemotePresence();
      },
      onDisconnect: () => {
        this.log(`CRDT websocket disconnected for ${this.file.path}.`);
        this.clearRemotePresence();
      },
      onAuthenticationFailed: ({ reason }) => {
        this.log(`CRDT auth failed for ${this.file.path}: ${reason}`);
        this.clearLocalPresence();
        this.clearRemotePresence();
        this.provider?.disconnect();
        this.status = "offline";
        new Notice(`Rolay CRDT auth failed for ${this.file.path}.`);
      }
    });

    this.publishLocalUserPresence();
  }

  async openOffline(): Promise<void> {
    this.bindRemoteObserver();
    this.bindPersistenceObserver();
    this.status = "offline";
    this.applyPendingOfflineUpdateIfNeeded();
    this.syncEditorContext();
  }

  matches(file: TFile, entry: FileEntry): boolean {
    return this.file.path === file.path && this.entry.id === entry.id;
  }

  isOffline(): boolean {
    return this.status === "offline";
  }

  syncEditorContext(): void {
    this.seedOrSyncEditor();
    this.updateLocalPresenceFromActiveView();
    this.renderRemotePresence();
  }

  pushLocalText(nextText: string): void {
    if ((this.status !== "synced" && this.status !== "offline") || this.applyingRemoteText) {
      return;
    }

    const currentText = this.yText.toString();
    if (currentText === nextText) {
      return;
    }

    const patch = diffText(currentText, nextText);
    this.yDocument.transact(() => {
      if (patch.deleteCount > 0) {
        this.yText.delete(patch.start, patch.deleteCount);
      }

      if (patch.insertText.length > 0) {
        this.yText.insert(patch.start, patch.insertText);
      }
    }, LOCAL_EDITOR_ORIGIN);
  }

  async goOffline(): Promise<void> {
    if (this.status === "offline") {
      return;
    }

    this.clearLocalPresence();
    this.clearRemotePresence();
    this.provider?.disconnect();
    this.status = "offline";
    this.log(`CRDT session moved offline for ${this.file.path}.`);
  }

  updateLocalPresence(editor: Editor, focused: boolean): void {
    if (!this.provider || this.status === "offline") {
      return;
    }

    this.publishLocalUserPresence();

    if (!focused) {
      if (this.lastLocalSelectionKey === null) {
        return;
      }

      this.provider.setAwarenessField("selection", null);
      this.lastLocalSelectionKey = null;
      return;
    }

    const selection = getPrimaryEditorSelection(editor);
    const selectionKey = `${selection.anchor}:${selection.head}`;
    if (selectionKey === this.lastLocalSelectionKey) {
      return;
    }

    this.provider.setAwarenessField("selection", selection);
    this.lastLocalSelectionKey = selectionKey;
  }

  getState(): CrdtSessionState {
    return {
      entryId: this.entry.id,
      filePath: this.file.path,
      docId: this.docId,
      status: this.status
    };
  }

  async destroy(): Promise<void> {
    this.clearLocalPresence();
    this.clearRemotePresence();
    this.flushPersistedState();
    this.provider?.destroy();
    this.provider = null;
    this.yDocument.destroy();
    this.status = "idle";
  }

  capturePendingOfflineUpdate(): Uint8Array | null {
    if (this.status !== "offline") {
      return null;
    }

    return Y.encodeStateAsUpdate(this.yDocument);
  }

  private bindRemoteObserver(): void {
    if (this.remoteObserverBound) {
      return;
    }

    this.remoteObserverBound = true;
    this.yText.observe((_event, transaction) => {
      if (transaction.origin === LOCAL_EDITOR_ORIGIN) {
        return;
      }

      this.syncRemoteIntoOpenEditors();
    });
  }

  private bindPersistenceObserver(): void {
    if (this.persistenceObserverBound) {
      return;
    }

    this.persistenceObserverBound = true;
    this.yDocument.on("update", () => {
      this.schedulePersistedState();
    });
  }

  private syncRemoteIntoOpenEditors(): void {
    const views = getMarkdownViewsForFile(this.app, this.file.path);
    if (views.length === 0) {
      return;
    }

    const remoteText = this.yText.toString();
    this.applyingRemoteText = true;
    try {
      for (const view of views) {
        const currentText = view.editor.getValue();
        if (currentText === remoteText) {
          continue;
        }

        applyTextPatchToEditor(view.editor, currentText, remoteText);
      }
    } finally {
      this.applyingRemoteText = false;
    }
  }

  private seedOrSyncEditor(): void {
    const views = getMarkdownViewsForFile(this.app, this.file.path);
    if (views.length === 0) {
      return;
    }

    const remoteText = this.yText.toString();

    if (!remoteText) {
      for (const view of views) {
        const currentText = view.editor.getValue();
        if (!currentText) {
          continue;
        }

        this.log(`Seeding empty CRDT doc from local editor content for ${this.file.path}.`);
        this.pushLocalText(currentText);
        return;
      }
    }

    this.syncRemoteIntoOpenEditors();
  }

  private publishLocalUserPresence(): void {
    this.provider?.setAwarenessField("user", this.awarenessUser);
  }

  private clearLocalPresence(): void {
    if (!this.provider) {
      return;
    }

    this.provider.setAwarenessField("selection", null);
    this.lastLocalSelectionKey = null;
  }

  private applyPendingOfflineUpdateIfNeeded(): void {
    if (!this.pendingOfflineUpdate) {
      return;
    }

    Y.applyUpdate(this.yDocument, this.pendingOfflineUpdate, "rolay-pending-offline");
    this.log(`Applied pending offline markdown changes for ${this.file.path}.`);
    this.pendingOfflineUpdate = null;
  }

  private schedulePersistedState(): void {
    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
    }

    this.persistHandle = window.setTimeout(() => {
      this.persistHandle = null;
      this.flushPersistedState();
    }, 300);
  }

  private flushPersistedState(): void {
    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
      this.persistHandle = null;
    }

    this.persistCrdtState(this.entry.id, this.file.path, Y.encodeStateAsUpdate(this.yDocument));
  }

  private updateLocalPresenceFromActiveView(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.file.path !== this.file.path) {
      this.clearLocalPresence();
      return;
    }

    const editorView = getCodeMirrorEditorView(view.editor);
    if (!editorView) {
      this.clearLocalPresence();
      return;
    }

    this.updateLocalPresence(view.editor, editorView.hasFocus);
  }

  private renderRemotePresence(): void {
    const remotePresence = this.getRemotePresence();
    for (const editorView of getMarkdownEditorViewsForFile(this.app, this.file.path)) {
      setRemotePresenceDecorations(editorView, remotePresence);
    }
  }

  private clearRemotePresence(): void {
    for (const editorView of getMarkdownEditorViewsForFile(this.app, this.file.path)) {
      setRemotePresenceDecorations(editorView, []);
    }
  }

  private getRemotePresence(): SharedCursorPresence[] {
    const awareness = this.provider?.awareness;
    if (!awareness) {
      return [];
    }

    const remotePresence: SharedCursorPresence[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === this.yDocument.clientID) {
        continue;
      }

      const presence = parseRemotePresenceState(clientId, state);
      if (presence) {
        remotePresence.push(presence);
      }
    }

    return remotePresence;
  }
}

function buildAwarenessUserPayload(user: User): AwarenessUserPayload {
  return {
    userId: user.id,
    displayName: user.displayName || user.username,
    color: buildPresenceColor(user.id)
  };
}

function buildPresenceColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 56%)`;
}

function getPrimaryEditorSelection(editor: Editor): AwarenessSelectionPayload {
  return {
    anchor: editor.posToOffset(editor.getCursor("anchor")),
    head: editor.posToOffset(editor.getCursor("head"))
  };
}

function parseRemotePresenceState(
  clientId: number,
  state: { [key: string]: unknown }
): SharedCursorPresence | null {
  const user = isRecord(state.user) ? state.user : null;
  const selection = isRecord(state.selection) ? state.selection : null;
  if (!user || !selection) {
    return null;
  }

  const userId = typeof user.userId === "string" ? user.userId : "";
  const displayName = typeof user.displayName === "string" ? user.displayName : userId;
  const color = typeof user.color === "string" && user.color ? user.color : buildPresenceColor(userId || String(clientId));
  const anchor = typeof selection.anchor === "number" ? selection.anchor : Number.NaN;
  const head = typeof selection.head === "number" ? selection.head : Number.NaN;

  if (!userId || !Number.isFinite(anchor) || !Number.isFinite(head)) {
    return null;
  }

  return {
    clientId,
    userId,
    displayName: displayName || userId,
    color,
    selection: {
      anchor,
      head
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function createCrdtTokenSupplier(
  apiClient: RolayApiClient,
  entryId: string,
  initialToken: string
): () => Promise<string> {
  let nextToken: string | null = initialToken;

  return async () => {
    if (nextToken) {
      const token = nextToken;
      nextToken = null;
      return token;
    }

    const bootstrap = await apiClient.createCrdtToken(entryId);
    return bootstrap.token;
  };
}

interface RemoteMarkdownSeedOptions {
  wsUrl: string;
  docId: string;
  token: string | (() => Promise<string>);
  localState: Uint8Array;
  log: (message: string) => void;
  contextLabel: string;
}

async function mergeRemoteMarkdownState(options: RemoteMarkdownSeedOptions): Promise<void> {
  if (options.localState.byteLength === 0) {
    return;
  }

  const yDocument = new Y.Doc();
  Y.applyUpdate(yDocument, options.localState, "rolay-import-bootstrap");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let provider: HocuspocusProvider | null = null;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      timeoutHandle && window.clearTimeout(timeoutHandle);
      try {
        callback();
      } finally {
        provider?.destroy();
        yDocument.destroy();
      }
    };

    const timeoutHandle = window.setTimeout(() => {
      settle(() => {
        reject(new Error(`Timed out while seeding remote markdown for ${options.contextLabel}.`));
      });
    }, 15_000);

    provider = new HocuspocusProvider({
      url: options.wsUrl,
      name: options.docId,
      document: yDocument,
      token: options.token,
      onSynced: () => {
        window.setTimeout(() => {
          settle(() => {
            options.log(`Merged local markdown state into remote CRDT doc for ${options.contextLabel}.`);
            resolve();
          });
        }, 500);
      },
      onAuthenticationFailed: () => {
        settle(() => {
          reject(new Error(`CRDT auth failed while seeding ${options.contextLabel}.`));
        });
      }
    });
  });
}

export function createMarkdownTextState(text: string): Uint8Array {
  const yDocument = new Y.Doc();
  try {
    if (text) {
      yDocument.getText("content").insert(0, text);
    }
    return Y.encodeStateAsUpdate(yDocument);
  } finally {
    yDocument.destroy();
  }
}
