import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";

import type { LocalizeFunc } from "../../../common/localize.js";
import "../../../components/base-dialog.js";
import { localizeContext } from "../../../context/index.js";
import {
  cmsisDapFailureCopy,
  type CmsisDapImage,
  flashCmsisDap,
  NRF54L_CHIPS,
  parseCmsisDapImage,
} from "../../../platforms/nrf52/index.js";
import { espHomeStyles } from "../../../styles/shared.js";
import { getErrorMessage } from "../../../util/error-message.js";

import {
  type FilePickerError,
  filePickerStyles,
  renderFilePicker,
} from "../../install/file-picker.js";
import {
  installActionsStyles,
  installTerminalState,
  renderCloseButton,
  renderProgressCard,
  renderRetryButton,
} from "../../install/install-progress.js";
import { Preparation, type Prepared } from "../../install/preparation.js";

import "@home-assistant/webawesome/dist/components/button/button.js";

type InstallState = "idle" | "connecting" | "flashing" | "success" | "error";

// The one board with a known on-board probe; the engine checks the chip it finds.
const CHIP = NRF54L_CHIPS.nrf54lm20a;

/**
 * Install through a board's on-board CMSIS-DAP debugger (the Seeed XIAO
 * nRF54LM20A): one or more HEX files, written into the chip over WebUSB
 * whatever it runs. The files are read and checked when picked, so the
 * Install click goes straight to the USB chooser.
 */
@customElement("esphome-web-install-nrf-debugger-dialog")
export class ESPHomeWebInstallNrfDebuggerDialog extends LitElement {
  @property({ type: Boolean }) open = false;

  @consume({ context: localizeContext, subscribe: true })
  @state()
  private _localize: LocalizeFunc = (key) => key;

  @state() private _state: InstallState = "idle";
  @state() private _files: File[] = [];
  // Rounded so per-packet callbacks re-render only on a visible change.
  @state() private _progress = 0;
  @state() private _errorTitle = "";
  @state() private _errorDetail = "";
  @state() private _fileError: FilePickerError | null = null;
  @state() private _logLines: string[] = [];

  @query("input[type=file]") private _fileInput?: HTMLInputElement;

  private _abort: AbortController | null = null;

  private _image = new Preparation<File[], CmsisDapImage, FilePickerError>(
    this,
    (files) => this._parse(files),
    (failure) => this._onPrepared(failure),
    // A revoked file handle rejects the read.
    (err) => ({
      title: this._localize("firmware.cmsis_dap_bad_image"),
      detail: getErrorMessage(err),
    })
  );

  private async _parse(files: File[]): Promise<Prepared<CmsisDapImage, FilePickerError>> {
    const texts = await Promise.all(files.map((f) => f.text()));
    const parsed = parseCmsisDapImage(CHIP, texts);
    if ("segments" in parsed) return { value: parsed };
    return {
      failure: { title: this._localize(parsed.key), detail: parsed.detail },
      retryable: false,
    };
  }

  private _onPrepared(failure: FilePickerError | null): void {
    this._fileError = failure;
    if (this._image.state.kind === "idle") this._unpick();
  }

  // The input is emptied with the files: it fires no change for what it
  // still holds, so those files could not be picked a second time.
  private _unpick(): void {
    this._files = [];
    if (this._fileInput) this._fileInput.value = "";
  }

  private _log = (line: string) => {
    this._logLines = [...this._logLines, line];
  };

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && !this.open) this._reset();
  }

  private get _busy(): boolean {
    return this._state === "connecting" || this._state === "flashing";
  }

  private _reset(): void {
    this._abort?.abort();
    this._abort = null;
    this._state = "idle";
    this._unpick();
    this._fileError = null;
    this._image.clear();
    this._progress = 0;
    this._errorTitle = "";
    this._errorDetail = "";
    this._logLines = [];
  }

  private _onFileChange = (e: Event): void => {
    this._files = Array.from((e.target as HTMLInputElement).files ?? []);
    this._fileError = null;
    if (this._files.length > 0) this._image.start(this._files);
    else this._image.clear();
  };

  private async _install(): Promise<void> {
    const prepared = this._image.state;
    if (prepared.kind !== "ready" || this._state !== "idle") return;
    const image = prepared.value;
    this._logLines = [];
    this._state = "connecting";
    const abort = new AbortController();
    this._abort = abort;
    const current = () => this._abort === abort;
    try {
      // Nothing is awaited before the chooser: it needs the click's activation.
      const flashed = await flashCmsisDap(image.chip, image.segments, {
        signal: abort.signal,
        cancelled: () => !current(),
        onLog: (line) => {
          if (current()) this._log(line);
        },
        onDeviceOpened: () => {
          this._state = "flashing";
          this._progress = 0;
        },
        onProgress: (percent) => {
          if (current()) this._progress = Math.round(percent);
        },
      });
      if (!current()) return;
      this._state = flashed ? "success" : "idle";
    } catch (err) {
      if (!current()) return;
      const { title, detail } = cmsisDapFailureCopy(err, this._localize);
      this._errorTitle = title;
      this._errorDetail = detail;
      this._state = "error";
    } finally {
      if (current()) this._abort = null;
    }
  }

  private _onAfterHide(): void {
    this.dispatchEvent(new CustomEvent("after-hide", { bubbles: true }));
  }

  private _renderSetup() {
    return html`
      <p>${this._localize("web.nrf.debugger_hint")}</p>
      ${renderFilePicker({
        label: this._localize("web.nrf.debugger_file_label"),
        accept: ".hex",
        multiple: true,
        file: this._files,
        placeholder: this._localize("web.nrf.debugger_file_placeholder"),
        onChange: this._onFileChange,
        preparing:
          this._image.state.kind === "pending"
            ? this._localize("web.install.preparing")
            : undefined,
        error: this._fileError,
      })}
    `;
  }

  private _statusMessage(): string {
    switch (this._state) {
      case "connecting":
        return this._localize("web.nrf.debugger_connecting");
      case "flashing":
        return this._localize("web.nrf.install_flashing");
      case "success":
        return this._localize("web.nrf.install_done");
      default:
        return this._errorTitle;
    }
  }

  private _renderProgress() {
    return renderProgressCard(
      {
        state: installTerminalState(this._state),
        message: this._statusMessage(),
        detail: this._state === "error" ? this._errorDetail : "",
        progress: this._state === "flashing" ? this._progress : null,
        log: this._logLines,
      },
      this._localize
    );
  }

  private _renderAction() {
    switch (this._state) {
      case "idle":
        return html`
          <wa-button
            variant="brand"
            ?disabled=${this._image.state.kind !== "ready"}
            @click=${this._install}
          >
            ${this._localize("dashboard.install")}
          </wa-button>
        `;
      case "error":
        return renderRetryButton(this._localize, () => (this._state = "idle"));
      case "success":
        return renderCloseButton(this._localize, this._onAfterHide);
      default:
        return nothing;
    }
  }

  protected render() {
    return html`
      <esphome-base-dialog
        .label=${this._localize("web.nrf.debugger_title")}
        ?open=${this.open}
        ?busy=${this._busy}
        @after-hide=${this._onAfterHide}
      >
        ${this._state === "idle" ? this._renderSetup() : this._renderProgress()}
        <div class="actions">${this._renderAction()}</div>
      </esphome-base-dialog>
    `;
  }

  static styles = [espHomeStyles, filePickerStyles, installActionsStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    "esphome-web-install-nrf-debugger-dialog": ESPHomeWebInstallNrfDebuggerDialog;
  }
}
