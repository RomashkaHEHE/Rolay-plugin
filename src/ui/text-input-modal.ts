import { Modal, Setting, type App } from "obsidian";

interface TextInputModalOptions {
  title: string;
  label: string;
  placeholder?: string;
  submitText: string;
  initialValue?: string;
  description?: string;
}

export class TextInputModal extends Modal {
  private readonly options: TextInputModalOptions;
  private readonly resolve: (value: string | null) => void;
  private submitted = false;
  private inputEl!: HTMLInputElement;

  constructor(app: App, options: TextInputModalOptions, resolve: (value: string | null) => void) {
    super(app);
    this.options = options;
    this.resolve = resolve;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.options.title });

    if (this.options.description) {
      contentEl.createEl("p", { text: this.options.description });
    }

    new Setting(contentEl)
      .setName(this.options.label)
      .addText((text) => {
        text
          .setPlaceholder(this.options.placeholder ?? "")
          .setValue(this.options.initialValue ?? "");
        this.inputEl = text.inputEl;
        this.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      });

    const buttonRow = contentEl.createDiv({ cls: "rolay-modal-actions" });
    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    const submitButton = buttonRow.createEl("button", {
      text: this.options.submitText,
      cls: "mod-cta"
    });

    cancelButton.addEventListener("click", () => this.close());
    submitButton.addEventListener("click", () => this.submit());

    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  override onClose(): void {
    if (!this.submitted) {
      this.resolve(null);
    }

    this.contentEl.empty();
  }

  private submit(): void {
    const value = this.inputEl?.value.trim() ?? "";
    if (!value) {
      this.inputEl?.focus();
      return;
    }

    this.submitted = true;
    this.resolve(value);
    this.close();
  }
}

export function openTextInputModal(app: App, options: TextInputModalOptions): Promise<string | null> {
  return new Promise((resolve) => {
    new TextInputModal(app, options, resolve).open();
  });
}
