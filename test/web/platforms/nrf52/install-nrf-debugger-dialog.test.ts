// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/components/base-dialog.js", () => ({}));
vi.mock("@home-assistant/webawesome/dist/components/button/button.js", () => ({}));
vi.mock("../../../../src/components/process-terminal/process-terminal.js", () => ({}));
vi.mock("../../../../src/components/install-details-log.js", () => ({}));

const mocks = vi.hoisted(() => ({ flashCmsisDap: vi.fn() }));
vi.mock("../../../../src/platforms/nrf52/cmsis-dap/flash.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flashCmsisDap: mocks.flashCmsisDap,
}));

import { CmsisDapFlashError } from "../../../../src/platforms/nrf52/cmsis-dap/flash.js";
import { ESPHomeWebInstallNrfDebuggerDialog } from "../../../../src/web/platforms/nrf52/esphome-web-install-nrf-debugger-dialog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MCUBOOT_HEX = ":0400000001020304F2\n:00000001FF\n";
const APP_HEX = ":040080000506070862\n:00000001FF\n";

async function settle(el: ESPHomeWebInstallNrfDebuggerDialog): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
}

async function mount(): Promise<ESPHomeWebInstallNrfDebuggerDialog> {
  const el = new ESPHomeWebInstallNrfDebuggerDialog();
  (el as any)._localize = (k: string) => k;
  el.open = true;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function pick(el: ESPHomeWebInstallNrfDebuggerDialog, ...texts: string[]) {
  const input = el.shadowRoot!.querySelector("input[type=file]") as HTMLInputElement;
  const files = texts.map((t, i) => new File([t], `part${i}.hex`));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
  await settle(el);
}

const installButton = (el: ESPHomeWebInstallNrfDebuggerDialog) =>
  el.shadowRoot!.querySelector(".actions wa-button") as HTMLElement;
const disabled = (el: ESPHomeWebInstallNrfDebuggerDialog) =>
  installButton(el).hasAttribute("disabled");

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("esphome-web-install-nrf-debugger-dialog", () => {
  it("takes several hex files as one image and writes it through the probe", async () => {
    const el = await mount();
    const input = el.shadowRoot!.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(disabled(el)).toBe(true);

    await pick(el, MCUBOOT_HEX, APP_HEX);
    expect(disabled(el)).toBe(false);
    expect(el.shadowRoot!.textContent).toContain("part0.hex, part1.hex");

    mocks.flashCmsisDap.mockImplementation(async (_segments, hooks) => {
      hooks.onDeviceOpened();
      hooks.onProgress(50);
      return true;
    });
    installButton(el).click();
    await settle(el);

    const [segments] = mocks.flashCmsisDap.mock.calls[0];
    expect(segments.map((s: { address: number }) => s.address)).toEqual([0, 0x80]);
    expect((el as any)._state).toBe("success");
  });

  it("refuses a file that is not Intel HEX before the chooser", async () => {
    const el = await mount();
    await pick(el, "garbage");
    expect(disabled(el)).toBe(true);
    expect(el.shadowRoot!.textContent).toContain("firmware.cmsis_dap_bad_image");
  });

  it("goes back to the picked files when the chooser is dismissed", async () => {
    const el = await mount();
    await pick(el, MCUBOOT_HEX);
    mocks.flashCmsisDap.mockResolvedValue(false);
    installButton(el).click();
    await settle(el);
    expect((el as any)._state).toBe("idle");
    expect(disabled(el)).toBe(false);
  });

  it("names a failed write", async () => {
    const el = await mount();
    await pick(el, MCUBOOT_HEX);
    mocks.flashCmsisDap.mockRejectedValue(
      new CmsisDapFlashError("wrong-chip", new Error("part code 0x1234"))
    );
    installButton(el).click();
    await settle(el);
    expect((el as any)._state).toBe("error");
    expect((el as any)._errorTitle).toBe("firmware.cmsis_dap_wrong_chip");
    expect((el as any)._errorDetail).toBe("part code 0x1234");
  });
});
