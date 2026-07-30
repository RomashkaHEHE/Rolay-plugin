import {
  App,
  Notice,
  normalizePath,
  requireApiVersion,
  type DataAdapter
} from "obsidian";

import { RolayApiClient } from "../api/client";
import type {
  PluginUpdateFileDescriptor,
  PluginUpdateFileName,
  PluginUpdateManifest
} from "../types/protocol";
import { normalizeSha256Hash, sha256Hash } from "../utils/sha256";

export type PluginUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "waiting"
  | "downloading"
  | "installing"
  | "restart-required"
  | "error";

export interface PluginUpdateState {
  status: PluginUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releasedAt: string | null;
  progressPercent: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  waitingReason: string | null;
}

interface PluginUpdaterConfig {
  app: App;
  apiClient: RolayApiClient;
  pluginId: string;
  currentVersion: string;
  getInstallBlockers: () => string[];
  prepareForInstall: () => Promise<boolean>;
  onStateChange: (state: PluginUpdateState) => void;
  log: (message: string, error?: unknown) => void;
}

interface DownloadedUpdateFile {
  descriptor: PluginUpdateFileDescriptor;
  data: ArrayBuffer;
}

interface VerifiedUpdateDownload {
  version: string;
  files: Map<PluginUpdateFileName, DownloadedUpdateFile>;
}

interface InstalledFileRecord {
  targetPath: string;
  rollbackPath: string;
  hadOriginal: boolean;
}

interface InternalPluginManager {
  disablePlugin?: (pluginId: string) => Promise<void>;
  enablePlugin?: (pluginId: string) => Promise<void>;
  loadManifests?: () => Promise<void>;
}

const REQUIRED_UPDATE_FILES: readonly PluginUpdateFileName[] = [
  "main.js",
  "manifest.json",
  "styles.css"
];
const INSTALL_ORDER: readonly PluginUpdateFileName[] = [
  "styles.css",
  "main.js",
  "manifest.json"
];
const PLAIN_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const INITIAL_CHECK_DELAY_MS = 0;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const STARTUP_DEFERRED_CHECK_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000
] as const;
const INSTALL_RETRY_DELAY_MS = 5_000;
const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000
] as const;
const PERSISTENT_ERROR_THRESHOLD = 3;
const BLOCKER_LOG_INTERVAL_MS = 60_000;
const BACKUPS_TO_KEEP = 2;

export class PluginUpdater {
  private readonly config: PluginUpdaterConfig;
  private state: PluginUpdateState;
  private latestManifest: PluginUpdateManifest | null = null;
  private verifiedDownload: VerifiedUpdateDownload | null = null;
  private checkHandle: number | null = null;
  private checkScheduledAt: number | null = null;
  private installHandle: number | null = null;
  private installScheduledAt: number | null = null;
  private checkPromise: Promise<PluginUpdateState> | null = null;
  private installPromise: Promise<void> | null = null;
  private failurePhase: "check" | "installation" | null = null;
  private lastBlockerSignature = "";
  private lastBlockerLoggedAt = 0;
  private startupCheckCompleted = false;
  private startupDeferredCheckAttempt = 0;
  private started = false;
  private stopped = false;

  constructor(config: PluginUpdaterConfig) {
    this.config = config;
    this.state = {
      status: "idle",
      currentVersion: config.currentVersion,
      latestVersion: null,
      releasedAt: null,
      progressPercent: 0,
      lastCheckedAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      waitingReason: null
    };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    this.startupCheckCompleted = false;
    this.startupDeferredCheckAttempt = 0;
    this.scheduleCheck(INITIAL_CHECK_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.checkHandle !== null) {
      window.clearTimeout(this.checkHandle);
      this.checkHandle = null;
      this.checkScheduledAt = null;
    }
    if (this.installHandle !== null) {
      window.clearTimeout(this.installHandle);
      this.installHandle = null;
      this.installScheduledAt = null;
    }
    this.verifiedDownload = null;
  }

  getState(): PluginUpdateState {
    return { ...this.state };
  }

  checkNow(): void {
    if (!this.started || this.stopped || this.state.status === "restart-required") {
      return;
    }
    this.scheduleCheck(0);
  }

  notifyConnectivityRestored(): void {
    if (!this.started || this.stopped || this.state.status === "restart-required") {
      return;
    }
    if (isPluginUpdateAvailable(this.state)) {
      this.scheduleInstall(0);
    }
    this.startupDeferredCheckAttempt = 0;
    this.scheduleCheck(0);
  }

  private scheduleCheck(delayMs: number): void {
    if (!this.started || this.stopped || this.state.status === "restart-required") {
      return;
    }

    const scheduledAt = Date.now() + Math.max(0, delayMs);
    if (
      this.checkHandle !== null &&
      this.checkScheduledAt !== null &&
      this.checkScheduledAt <= scheduledAt
    ) {
      return;
    }
    if (this.checkHandle !== null) {
      window.clearTimeout(this.checkHandle);
    }

    this.checkScheduledAt = scheduledAt;
    this.checkHandle = window.setTimeout(() => {
      this.checkHandle = null;
      this.checkScheduledAt = null;
      void this.runAutomaticCheck();
    }, Math.max(0, delayMs));
  }

  private scheduleInstall(delayMs: number): void {
    if (
      !this.started ||
      this.stopped ||
      this.state.status === "restart-required"
    ) {
      return;
    }

    const scheduledAt = Date.now() + Math.max(0, delayMs);
    if (
      this.installHandle !== null &&
      this.installScheduledAt !== null &&
      this.installScheduledAt <= scheduledAt
    ) {
      return;
    }
    if (this.installHandle !== null) {
      window.clearTimeout(this.installHandle);
    }

    this.installScheduledAt = scheduledAt;
    this.installHandle = window.setTimeout(() => {
      this.installHandle = null;
      this.installScheduledAt = null;
      void this.runAutomaticInstall();
    }, Math.max(0, delayMs));
  }

  private async runAutomaticCheck(): Promise<void> {
    if (this.stopped || this.state.status === "restart-required") {
      return;
    }
    if (navigator.onLine === false) {
      this.scheduleCheck(this.getDeferredCheckDelay());
      return;
    }
    if (this.checkPromise) {
      return;
    }
    if (this.installPromise) {
      this.scheduleCheck(
        this.startupCheckCompleted
          ? CHECK_INTERVAL_MS
          : this.getDeferredCheckDelay()
      );
      return;
    }

    const check = this.runCheck();
    this.checkPromise = check;
    try {
      const state = await check;
      this.startupCheckCompleted = true;
      this.startupDeferredCheckAttempt = 0;
      if (isPluginUpdateAvailable(state)) {
        this.scheduleInstall(0);
      }
      this.scheduleCheck(CHECK_INTERVAL_MS);
    } catch (error) {
      if (!this.stopped) {
        const retryDelay = this.recordFailure("check", error);
        this.scheduleCheck(retryDelay);
      }
    } finally {
      if (this.checkPromise === check) {
        this.checkPromise = null;
      }
    }
  }

  private getDeferredCheckDelay(): number {
    if (this.startupCheckCompleted) {
      return CHECK_INTERVAL_MS;
    }

    const index = Math.min(
      this.startupDeferredCheckAttempt,
      STARTUP_DEFERRED_CHECK_DELAYS_MS.length - 1
    );
    this.startupDeferredCheckAttempt += 1;
    return STARTUP_DEFERRED_CHECK_DELAYS_MS[index];
  }

  private async runAutomaticInstall(): Promise<void> {
    if (
      this.stopped ||
      this.state.status === "restart-required" ||
      this.installPromise
    ) {
      return;
    }
    if (!this.latestManifest || !isPluginUpdateAvailable(this.state)) {
      this.scheduleCheck(0);
      return;
    }

    const blockers = this.config.getInstallBlockers();
    if (blockers.length > 0) {
      this.updateWaitingState(blockers);
      this.scheduleInstall(INSTALL_RETRY_DELAY_MS);
      return;
    }

    const install = this.runInstall();
    this.installPromise = install;
    try {
      await install;
    } catch (error) {
      if (!this.stopped) {
        const retryDelay = this.recordFailure("installation", error);
        this.scheduleInstall(retryDelay);
      }
    } finally {
      if (this.installPromise === install) {
        this.installPromise = null;
      }
    }
  }

  private updateWaitingState(blockers: string[]): void {
    const waitingReason = blockers.length > 0
      ? blockers.join(", ")
      : "sync activity is still settling";
    const progressPercent = this.verifiedDownload ? 90 : 0;
    if (
      this.state.status !== "waiting" ||
      this.state.progressPercent !== progressPercent ||
      this.state.waitingReason !== waitingReason
    ) {
      this.updateState({
        status: "waiting",
        progressPercent,
        lastError: null,
        nextRetryAt: null,
        waitingReason
      });
    }

    const signature = blockers.join("|");
    const now = Date.now();
    if (
      signature !== this.lastBlockerSignature ||
      now - this.lastBlockerLoggedAt >= BLOCKER_LOG_INTERVAL_MS
    ) {
      this.lastBlockerSignature = signature;
      this.lastBlockerLoggedAt = now;
      this.log(
        `Plugin update ${this.latestManifest?.latestVersion ?? ""} is waiting for a safe idle window: ${waitingReason}.`
      );
    }
  }

  private recordFailure(phase: "check" | "installation", error: unknown): number {
    const message = describeError(error);
    const consecutiveFailures = this.state.consecutiveFailures + 1;
    const retryDelay = getRetryDelay(consecutiveFailures);
    this.failurePhase = phase;
    this.updateState({
      status: "error",
      progressPercent: this.verifiedDownload ? 90 : 0,
      lastCheckedAt: phase === "check"
        ? new Date().toISOString()
        : this.state.lastCheckedAt,
      lastError: message,
      consecutiveFailures,
      nextRetryAt: new Date(Date.now() + retryDelay).toISOString(),
      waitingReason: null
    });
    this.log(
      `Plugin update ${phase} failed (attempt ${consecutiveFailures}); retrying automatically: ${message}`,
      error
    );
    return retryDelay;
  }

  private clearScheduledWork(): void {
    if (this.checkHandle !== null) {
      window.clearTimeout(this.checkHandle);
      this.checkHandle = null;
      this.checkScheduledAt = null;
    }
    if (this.installHandle !== null) {
      window.clearTimeout(this.installHandle);
      this.installHandle = null;
      this.installScheduledAt = null;
    }
  }

  private async runCheck(): Promise<PluginUpdateState> {
    const previousLatestVersion = this.latestManifest?.latestVersion ?? null;
    const previousLastError = this.state.lastError;
    this.updateState({
      status: "checking",
      progressPercent: 0
    });

    try {
      const manifest = await this.config.apiClient.getLatestPluginUpdate();
      this.assertRunning();
      validateUpdateManifest(manifest, this.config.pluginId);
      this.latestManifest = manifest;
      const updateAvailable = compareSemver(
        manifest.latestVersion,
        this.config.currentVersion
      ) > 0;
      const preserveInstallFailures =
        updateAvailable &&
        this.failurePhase === "installation" &&
        previousLatestVersion === manifest.latestVersion;
      const shouldLogCheckResult =
        previousLatestVersion === null ||
        previousLatestVersion !== manifest.latestVersion ||
        this.failurePhase === "check";
      if (
        this.verifiedDownload &&
        (
          !updateAvailable ||
          this.verifiedDownload.version !== manifest.latestVersion
        )
      ) {
        this.verifiedDownload = null;
      }
      this.updateState({
        status: updateAvailable ? "available" : "current",
        latestVersion: manifest.latestVersion,
        releasedAt: manifest.releasedAt,
        progressPercent: updateAvailable ? 0 : 100,
        lastCheckedAt: new Date().toISOString(),
        lastError: preserveInstallFailures ? previousLastError : null,
        consecutiveFailures: preserveInstallFailures
          ? this.state.consecutiveFailures
          : 0,
        nextRetryAt: null,
        waitingReason: null
      });
      if (!preserveInstallFailures) {
        this.failurePhase = null;
      }
      if (shouldLogCheckResult) {
        this.log(
          updateAvailable
            ? `Plugin update ${manifest.latestVersion} is available (current ${this.config.currentVersion}).`
            : `Plugin version ${this.config.currentVersion} is current.`
        );
      }
      return this.getState();
    } catch (error) {
      if (this.stopped) {
        return this.getState();
      }
      throw error;
    }
  }

  private async runInstall(): Promise<void> {
    const manifest = this.latestManifest;
    if (!manifest || compareSemver(manifest.latestVersion, this.config.currentVersion) <= 0) {
      return;
    }

    let verifiedDownload = this.verifiedDownload;
    if (!verifiedDownload || verifiedDownload.version !== manifest.latestVersion) {
      const files = await this.downloadAndVerifyFiles(manifest);
      verifiedDownload = {
        version: manifest.latestVersion,
        files
      };
      this.verifiedDownload = verifiedDownload;
    }

    this.assertRunning();
    if (!(await this.config.prepareForInstall())) {
      this.updateWaitingState(this.config.getInstallBlockers());
      this.scheduleInstall(INSTALL_RETRY_DELAY_MS);
      return;
    }
    this.assertRunning();
    this.updateState({
      status: "installing",
      progressPercent: 95,
      lastError: null,
      nextRetryAt: null,
      waitingReason: null
    });
    await this.installFiles(manifest, verifiedDownload.files);
    this.verifiedDownload = null;
    this.failurePhase = null;
    this.updateState({
      status: "restart-required",
      progressPercent: 100,
      lastError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
      waitingReason: null
    });
    this.log(
      `Plugin update ${manifest.latestVersion} was installed automatically. Attempting a soft reload.`
    );

    this.clearScheduledWork();
    const reloadScheduled = this.scheduleSoftReload();
    if (!reloadScheduled) {
      this.log(
        `Plugin update ${manifest.latestVersion} is on disk; Obsidian restart is required.`
      );
    }
  }

  private async downloadAndVerifyFiles(
    manifest: PluginUpdateManifest
  ): Promise<Map<PluginUpdateFileName, DownloadedUpdateFile>> {
    this.updateState({
      status: "downloading",
      progressPercent: 0,
      lastError: null,
      nextRetryAt: null,
      waitingReason: null
    });

    const downloaded = new Map<PluginUpdateFileName, DownloadedUpdateFile>();
    const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    let completedBytes = 0;

    for (const descriptor of manifest.files) {
      this.assertRunning();
      const response = await this.config.apiClient.downloadPluginUpdateFile(descriptor.url);
      this.assertRunning();
      await verifyDownloadedFile(descriptor, response.data);
      downloaded.set(descriptor.name, {
        descriptor,
        data: response.data
      });
      completedBytes += response.data.byteLength;
      this.updateState({
        status: "downloading",
        progressPercent: totalBytes > 0
          ? Math.min(90, Math.round((completedBytes / totalBytes) * 90))
          : 90
      });
    }

    validateDownloadedPluginManifest(
      downloaded.get("manifest.json")?.data,
      manifest.latestVersion,
      this.config.pluginId
    );
    return downloaded;
  }

  private async installFiles(
    manifest: PluginUpdateManifest,
    files: Map<PluginUpdateFileName, DownloadedUpdateFile>
  ): Promise<void> {
    const adapter = this.config.app.vault.adapter;
    const pluginRoot = normalizePath(
      `${this.config.app.vault.configDir}/plugins/${this.config.pluginId}`
    );
    if (!(await adapter.exists(pluginRoot))) {
      throw new Error(`Rolay plugin folder does not exist at ${pluginRoot}.`);
    }

    const updateRoot = normalizePath(`${pluginRoot}/.rolay-update`);
    const operationId = createOperationId();
    const stagingRoot = normalizePath(`${updateRoot}/staging-${operationId}`);
    const rollbackRoot = normalizePath(`${updateRoot}/rollback-${operationId}`);
    const backupRoot = normalizePath(
      `${updateRoot}/backup-${Date.now()}-${this.config.currentVersion}`
    );
    await ensureDirectory(adapter, updateRoot);
    await ensureDirectory(adapter, stagingRoot);
    await ensureDirectory(adapter, rollbackRoot);
    await ensureDirectory(adapter, backupRoot);
    let replacementCompleted = false;

    try {
      for (const name of REQUIRED_UPDATE_FILES) {
        const file = files.get(name);
        if (!file) {
          throw new Error(`Verified update is missing ${name}.`);
        }
        const stagingPath = normalizePath(`${stagingRoot}/${name}`);
        await adapter.writeBinary(stagingPath, file.data);
        await verifyDownloadedFile(file.descriptor, await adapter.readBinary(stagingPath));
      }

      for (const name of REQUIRED_UPDATE_FILES) {
        const targetPath = normalizePath(`${pluginRoot}/${name}`);
        if (await adapter.exists(targetPath)) {
          await adapter.copy(targetPath, normalizePath(`${backupRoot}/${name}`));
        } else if (name !== "styles.css") {
          throw new Error(`Installed plugin is missing required file ${name}.`);
        }
      }

      await replaceInstalledFiles(
        adapter,
        pluginRoot,
        stagingRoot,
        rollbackRoot
      );
      replacementCompleted = true;
      this.log(
        `Installed verified plugin ${manifest.latestVersion}; backup stored at ${backupRoot}.`
      );
    } finally {
      await removeDirectoryIfPresent(adapter, stagingRoot);
      if (replacementCompleted) {
        await removeDirectoryIfPresent(adapter, rollbackRoot);
      }
    }

    await pruneOldBackups(adapter, updateRoot);
  }

  private scheduleSoftReload(): boolean {
    const manager = (this.config.app as App & {
      plugins?: InternalPluginManager;
    }).plugins;
    if (
      typeof manager?.disablePlugin !== "function" ||
      typeof manager.enablePlugin !== "function" ||
      typeof manager.loadManifests !== "function"
    ) {
      return false;
    }

    window.setTimeout(() => {
      void this.reloadPlugin(manager);
    }, 250);
    return true;
  }

  private async reloadPlugin(manager: InternalPluginManager): Promise<void> {
    try {
      await manager.disablePlugin?.(this.config.pluginId);
      await manager.loadManifests?.();
      await manager.enablePlugin?.(this.config.pluginId);
    } catch (error) {
      console.error("[Rolay] Soft plugin reload failed", error);
      try {
        await manager.enablePlugin?.(this.config.pluginId);
      } catch {
        // The files are already installed; normal Obsidian startup can load them.
      }
      new Notice(
        "Rolay update is installed, but the plugin could not reload. Restart Obsidian to apply it.",
        10_000
      );
    }
  }

  private updateState(update: Partial<PluginUpdateState>): void {
    if (this.stopped) {
      return;
    }
    this.state = {
      ...this.state,
      ...update
    };
    this.config.onStateChange(this.getState());
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("Rolay unloaded before the update operation completed.");
    }
  }

  private log(message: string, error?: unknown): void {
    if (!this.stopped) {
      this.config.log(message, error);
    }
  }
}

export function isPluginUpdateAvailable(state: PluginUpdateState): boolean {
  return Boolean(
    state.latestVersion &&
    compareSemver(state.latestVersion, state.currentVersion) > 0
  );
}

export function hasPersistentPluginUpdateError(state: PluginUpdateState): boolean {
  return state.status === "error" &&
    state.consecutiveFailures >= PERSISTENT_ERROR_THRESHOLD;
}

export function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  if (!PLAIN_SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid plain semver version: ${version}`);
  }
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0], parts[1], parts[2]];
}

function validateUpdateManifest(manifest: PluginUpdateManifest, pluginId: string): void {
  if (manifest.pluginId !== pluginId) {
    throw new Error(`Update manifest targets unexpected plugin ${manifest.pluginId}.`);
  }
  parseSemver(manifest.latestVersion);
  if (Number.isNaN(Date.parse(manifest.releasedAt))) {
    throw new Error("Update manifest has an invalid release timestamp.");
  }
  if (manifest.files.length !== REQUIRED_UPDATE_FILES.length) {
    throw new Error("Update manifest must describe exactly three plugin files.");
  }

  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!REQUIRED_UPDATE_FILES.includes(file.name) || seen.has(file.name)) {
      throw new Error(`Update manifest contains unexpected or duplicate file ${file.name}.`);
    }
    seen.add(file.name);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new Error(`Update manifest has an invalid size for ${file.name}.`);
    }
    if (normalizeSha256Hash(file.sha256) !== file.sha256) {
      throw new Error(`Update manifest has a non-canonical SHA-256 for ${file.name}.`);
    }
    const expectedPath = `/v1/plugin-updates/${manifest.latestVersion}/files/${file.name}`;
    if (file.url !== expectedPath) {
      throw new Error(`Update manifest has an unexpected download path for ${file.name}.`);
    }
  }

  for (const name of REQUIRED_UPDATE_FILES) {
    if (!seen.has(name)) {
      throw new Error(`Update manifest is missing ${name}.`);
    }
  }
}

async function verifyDownloadedFile(
  descriptor: PluginUpdateFileDescriptor,
  data: ArrayBuffer
): Promise<void> {
  if (data.byteLength !== descriptor.sizeBytes) {
    throw new Error(
      `${descriptor.name} has ${data.byteLength} bytes; expected ${descriptor.sizeBytes}.`
    );
  }
  const actualHash = await sha256Hash(data);
  if (actualHash !== descriptor.sha256) {
    throw new Error(`${descriptor.name} failed SHA-256 verification.`);
  }
}

function validateDownloadedPluginManifest(
  data: ArrayBuffer | undefined,
  version: string,
  pluginId: string
): void {
  if (!data) {
    throw new Error("Downloaded plugin manifest is missing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Error("Downloaded plugin manifest is not valid UTF-8 JSON.");
  }
  if (!isRecord(parsed) || parsed.id !== pluginId || parsed.version !== version) {
    throw new Error(
      `Downloaded manifest must declare id "${pluginId}" and version "${version}".`
    );
  }
  if (typeof parsed.minAppVersion !== "string" || !parsed.minAppVersion.trim()) {
    throw new Error("Downloaded manifest has no minAppVersion.");
  }
  if (!requireApiVersion(parsed.minAppVersion)) {
    throw new Error(
      `Rolay ${version} requires Obsidian ${parsed.minAppVersion} or newer.`
    );
  }
}

async function replaceInstalledFiles(
  adapter: DataAdapter,
  pluginRoot: string,
  stagingRoot: string,
  rollbackRoot: string
): Promise<void> {
  const installed: InstalledFileRecord[] = [];

  try {
    for (const name of INSTALL_ORDER) {
      const targetPath = normalizePath(`${pluginRoot}/${name}`);
      const stagingPath = normalizePath(`${stagingRoot}/${name}`);
      const rollbackPath = normalizePath(`${rollbackRoot}/${name}`);
      const hadOriginal = await adapter.exists(targetPath);

      if (hadOriginal) {
        await adapter.rename(targetPath, rollbackPath);
      }

      try {
        await adapter.rename(stagingPath, targetPath);
      } catch (error) {
        if (hadOriginal && await adapter.exists(rollbackPath)) {
          await adapter.rename(rollbackPath, targetPath);
        }
        throw error;
      }

      installed.push({
        targetPath,
        rollbackPath,
        hadOriginal
      });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of installed.reverse()) {
      try {
        if (await adapter.exists(file.targetPath)) {
          await adapter.remove(file.targetPath);
        }
        if (file.hadOriginal && await adapter.exists(file.rollbackPath)) {
          await adapter.rename(file.rollbackPath, file.targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(describeError(rollbackError));
      }
    }

    if (rollbackErrors.length > 0) {
      throw new Error(
        `${describeError(error)} Rollback also failed: ${rollbackErrors.join("; ")}`
      );
    }
    throw error;
  }
}

async function ensureDirectory(adapter: DataAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) {
    await adapter.mkdir(path);
  }
}

async function removeDirectoryIfPresent(adapter: DataAdapter, path: string): Promise<void> {
  try {
    if (await adapter.exists(path)) {
      await adapter.rmdir(path, true);
    }
  } catch {
    // Cleanup must not turn an installed and verified update into a failure.
  }
}

async function pruneOldBackups(adapter: DataAdapter, updateRoot: string): Promise<void> {
  try {
    const listing = await adapter.list(updateRoot);
    const backups = listing.folders
      .filter((path) => path.startsWith(`${updateRoot}/backup-`))
      .sort()
      .reverse();
    for (const path of backups.slice(BACKUPS_TO_KEEP)) {
      await adapter.rmdir(path, true);
    }
  } catch {
    // Backup retention is best-effort and does not affect update validity.
  }
}

function createOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? randomId.replace(/-/g, "") : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRetryDelay(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(0, consecutiveFailures - 1),
    RETRY_DELAYS_MS.length - 1
  );
  return RETRY_DELAYS_MS[index];
}
