import { App, Modal, setIcon } from "obsidian";

import type { PluginUpdateState } from "../update/plugin-updater";

interface PluginUpdateModalConfig {
  getState: () => PluginUpdateState;
  startInstall: () => Promise<void>;
}

export class PluginUpdateModal extends Modal {
  private readonly config: PluginUpdateModalConfig;

  constructor(app: App, config: PluginUpdateModalConfig) {
    super(app);
    this.config = config;
  }

  override onOpen(): void {
    this.modalEl.classList.add("rolay-update-modal");
    this.setTitle("Rolay update");
    this.render();
  }

  private render(): void {
    const state = this.config.getState();
    this.contentEl.empty();

    if (state.status === "restart-required") {
      this.contentEl.createEl("p", {
        text: `Rolay ${state.latestVersion ?? "update"} is installed. Restart Obsidian to load the new files.`
      });
      this.createCloseButton();
      return;
    }

    if (state.status === "downloading" || state.status === "installing") {
      this.contentEl.createEl("p", {
        text: `Rolay update is in progress: ${state.progressPercent}%.`
      });
      const progress = this.contentEl.createEl("progress", {
        cls: "rolay-update-modal-progress"
      });
      progress.max = 100;
      progress.value = state.progressPercent;
      this.createCloseButton();
      return;
    }

    this.contentEl.createEl("p", {
      text: state.latestVersion
        ? `Installed: ${state.currentVersion}. Available: ${state.latestVersion}.`
        : `Installed version: ${state.currentVersion}.`
    });
    this.contentEl.createEl("p", {
      cls: "rolay-update-modal-note",
      text:
        "Force update downloads and verifies main.js, manifest.json, and styles.css, preserves local Rolay data, then reloads the plugin when Obsidian allows it."
    });
    if (state.lastError) {
      this.contentEl.createEl("p", {
        cls: "rolay-update-modal-error",
        text: state.lastError
      });
    }

    const actions = this.contentEl.createDiv({ cls: "rolay-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Later" });
    cancelButton.addEventListener("click", () => this.close());

    const updateButton = actions.createEl("button", {
      cls: "mod-cta rolay-update-action"
    });
    setIcon(updateButton, "download");
    updateButton.createSpan({ text: "Force update" });
    updateButton.addEventListener("click", () => {
      updateButton.disabled = true;
      cancelButton.disabled = true;
      this.close();
      void this.config.startInstall();
    });
  }

  private createCloseButton(): void {
    const actions = this.contentEl.createDiv({ cls: "rolay-modal-actions" });
    const closeButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Close"
    });
    closeButton.addEventListener("click", () => this.close());
  }
}
