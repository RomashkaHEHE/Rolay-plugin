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
}

export interface PluginUpdateInstallResult {
  version: string;
  reloaded: boolean;
  restartRequired: boolean;
}

interface PluginUpdaterConfig {
  app: App;
  apiClient: RolayApiClient;
  pluginId: string;
  currentVersion: string;
  prepareForInstall: () => Promise<void>;
  onStateChange: (state: PluginUpdateState) => void;
  log: (message: string, error?: boolean) => void;
}

interface DownloadedUpdateFile {
  descriptor: PluginUpdateFileDescriptor;
  data: ArrayBuffer;
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
const INITIAL_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BACKUPS_TO_KEEP = 2;

export class PluginUpdater {
  private readonly config: PluginUpdaterConfig;
  private state: PluginUpdateState;
  private latestManifest: PluginUpdateManifest | null = null;
  private initialCheckHandle: number | null = null;
  private checkIntervalHandle: number | null = null;
  private checkPromise: Promise<PluginUpdateState> | null = null;
  private installPromise: Promise<PluginUpdateInstallResult> | null = null;
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
      lastError: null
    };
  }

  start(): void {
    if (this.initialCheckHandle !== null || this.checkIntervalHandle !== null) {
      return;
    }
    this.stopped = false;

    this.initialCheckHandle = window.setTimeout(() => {
      this.initialCheckHandle = null;
      void this.checkForUpdates().catch(() => undefined);
    }, INITIAL_CHECK_DELAY_MS);
    this.checkIntervalHandle = window.setInterval(() => {
      void this.checkForUpdates().catch(() => undefined);
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.initialCheckHandle !== null) {
      window.clearTimeout(this.initialCheckHandle);
      this.initialCheckHandle = null;
    }
    if (this.checkIntervalHandle !== null) {
      window.clearInterval(this.checkIntervalHandle);
      this.checkIntervalHandle = null;
    }
  }

  getState(): PluginUpdateState {
    return { ...this.state };
  }

  checkForUpdates(): Promise<PluginUpdateState> {
    if (this.stopped) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    if (this.installPromise) {
      return Promise.resolve(this.getState());
    }

    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  installAvailableUpdate(): Promise<PluginUpdateInstallResult> {
    if (this.stopped) {
      return Promise.reject(new Error("Rolay unloaded before the update could start."));
    }
    if (this.installPromise) {
      return this.installPromise;
    }

    this.installPromise = this.runInstall().finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private async runCheck(): Promise<PluginUpdateState> {
    this.updateState({
      status: "checking",
      progressPercent: 0,
      lastError: null
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
      this.updateState({
        status: updateAvailable ? "available" : "current",
        latestVersion: manifest.latestVersion,
        releasedAt: manifest.releasedAt,
        progressPercent: updateAvailable ? 0 : 100,
        lastCheckedAt: new Date().toISOString(),
        lastError: null
      });
      this.log(
        updateAvailable
          ? `Plugin update ${manifest.latestVersion} is available (current ${this.config.currentVersion}).`
          : `Plugin version ${this.config.currentVersion} is current.`
      );
      return this.getState();
    } catch (error) {
      if (this.stopped) {
        return this.getState();
      }
      const message = describeError(error);
      this.updateState({
        status: "error",
        progressPercent: 0,
        lastCheckedAt: new Date().toISOString(),
        lastError: message
      });
      this.log(`Plugin update check failed: ${message}`, true);
      throw error;
    }
  }

  private async runInstall(): Promise<PluginUpdateInstallResult> {
    let manifest = this.latestManifest;
    if (!manifest || compareSemver(manifest.latestVersion, this.config.currentVersion) <= 0) {
      await this.checkForUpdates();
      manifest = this.latestManifest;
    }
    if (!manifest || compareSemver(manifest.latestVersion, this.config.currentVersion) <= 0) {
      throw new Error("No newer Rolay plugin version is available.");
    }

    try {
      const files = await this.downloadAndVerifyFiles(manifest);
      this.assertRunning();
      await this.config.prepareForInstall();
      this.assertRunning();
      this.updateState({
        status: "installing",
        progressPercent: 95,
        lastError: null
      });
      await this.installFiles(manifest, files);
      this.updateState({
        status: "restart-required",
        progressPercent: 100,
        lastError: null
      });
      this.log(
        `Plugin update ${manifest.latestVersion} was installed. Attempting a soft reload.`
      );

      const reloadScheduled = this.scheduleSoftReload();
      if (!reloadScheduled) {
        this.log(
          `Plugin update ${manifest.latestVersion} is on disk; Obsidian restart is required.`
        );
      }
      return {
        version: manifest.latestVersion,
        reloaded: reloadScheduled,
        restartRequired: !reloadScheduled
      };
    } catch (error) {
      const message = describeError(error);
      this.updateState({
        status: "error",
        progressPercent: 0,
        lastError: message
      });
      this.log(`Plugin update installation failed: ${message}`, true);
      throw error;
    }
  }

  private async downloadAndVerifyFiles(
    manifest: PluginUpdateManifest
  ): Promise<Map<PluginUpdateFileName, DownloadedUpdateFile>> {
    this.updateState({
      status: "downloading",
      progressPercent: 0,
      lastError: null
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

  private log(message: string, error = false): void {
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
