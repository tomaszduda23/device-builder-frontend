import { css, html, nothing, type TemplateResult } from "lit";

/** Why a picked file cannot be installed. */
export interface FilePickerError {
  title: string;
  detail: string;
}

/**
 * The file row the file-driven install dialogs share: a labelled input, the
 * picked name, and what is happening to the file (being prepared, refused).
 */
export function renderFilePicker(picker: {
  label: string;
  accept: string;
  /** The picked file, or files with ``multiple``. */
  file: File | readonly File[] | null;
  placeholder: string;
  /** Several files make one image (a bootloader and an app). */
  multiple?: boolean;
  onChange: (e: Event) => void;
  /** The line to show while the picked file is read and checked. */
  preparing?: string;
  error?: FilePickerError | null;
}): TemplateResult {
  return html`
    <div class="file-row">
      <label class="file-label">
        <span>${picker.label}</span>
        <input
          type="file"
          accept=${picker.accept}
          ?multiple=${picker.multiple ?? false}
          @change=${picker.onChange}
        />
      </label>
      <span class="file-name">${pickedName(picker.file) ?? picker.placeholder}</span>
      ${renderFileStatus(picker.preparing, picker.error)}
    </div>
  `;
}

function pickedName(file: File | readonly File[] | null): string | null {
  if (file === null) return null;
  if (file instanceof File) return file.name;
  return file.length > 0 ? file.map((f) => f.name).join(", ") : null;
}

/** What is happening to the file: being prepared, or refused. */
export function renderFileStatus(
  preparing?: string,
  error?: FilePickerError | null
): TemplateResult {
  return html`
    ${
      preparing
        ? html`<span class="file-status" role="status">${preparing}</span>`
        : nothing
    }
    ${
      error
        ? html`<span class="file-status file-status--error" role="alert"
            >${error.title}${error.detail ? `: ${error.detail}` : ""}</span
          >`
        : nothing
    }
  `;
}

export const filePickerStyles = css`
  .file-row {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
  }
  .file-label {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    font-size: var(--wa-font-size-s);
    font-weight: var(--wa-font-weight-bold);
    color: var(--wa-color-text-normal);
  }
  .file-label input[type="file"] {
    font-size: var(--wa-font-size-s);
    font-family: inherit;
  }
  .file-status {
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-text-quiet);
  }
  .file-status--error {
    color: var(--esphome-error);
  }
  .file-name {
    font-size: var(--wa-font-size-s);
    color: var(--wa-color-text-quiet);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
