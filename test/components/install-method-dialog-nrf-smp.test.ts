/**
 * @vitest-environment happy-dom
 *
 * The nRF52 Bluetooth update row: offered in install mode for a build with
 * the MCUmgr OTA and a BLE server, in a browser with Web Bluetooth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../_mock-webawesome.js";

vi.mock("@home-assistant/webawesome/dist/components/callout/callout.js", () => ({}));

import { DeviceState } from "../../src/api/types/devices.js";
import { defaultLocalize } from "../../src/common/localize.js";
import { ESPHomeInstallMethodDialog } from "../../src/components/install-method-dialog.js";
import {
  restoreWebSerialEnv,
  setLocalhostWithWebSerial,
} from "./_install-method-dialog-env.js";

const SMP_BUILD = ["nrf52", "zephyr_mcumgr", "zephyr_ble_server"];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function mount(
  platform: string,
  integrations: string[],
  mode: "install" | "logs" = "install"
): Promise<ESPHomeInstallMethodDialog> {
  const dialog = new ESPHomeInstallMethodDialog();
  (dialog as any)._localize = defaultLocalize;
  (dialog as any)._api = {};
  dialog.deviceState = DeviceState.ONLINE;
  dialog.deviceTargetPlatform = platform;
  dialog.deviceIntegrations = integrations;
  dialog.mode = mode;
  document.body.appendChild(dialog);
  await dialog.updateComplete;
  return dialog;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const hasBleRow = (d: ESPHomeInstallMethodDialog): boolean =>
  !!d.shadowRoot!.querySelector('wa-icon[name="bluetooth"]');

beforeEach(() => {
  setLocalhostWithWebSerial();
  Object.defineProperty(navigator, "bluetooth", { value: {}, configurable: true });
});

afterEach(() => {
  restoreWebSerialEnv();
  delete (navigator as { bluetooth?: unknown }).bluetooth;
  document.body.innerHTML = "";
});

describe("install-method-dialog nRF52 Bluetooth update row", () => {
  it("is offered for an nRF52 build with the MCUmgr OTA over BLE", async () => {
    expect(hasBleRow(await mount("nrf52", SMP_BUILD))).toBe(true);
  });

  it("selects the nrf-smp-ble method", async () => {
    const d = await mount("nrf52", SMP_BUILD);
    const selected = vi.fn();
    d.addEventListener("select-method", (e) => selected((e as CustomEvent).detail));
    const row = d
      .shadowRoot!.querySelector('wa-icon[name="bluetooth"]')!
      .closest(".option") as HTMLElement;
    row.click();
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ method: "nrf-smp-ble" })
    );
  });

  it.each([
    ["without zephyr_mcumgr", "nrf52", ["nrf52", "zephyr_ble_server"]],
    ["without zephyr_ble_server", "nrf52", ["nrf52", "zephyr_mcumgr"]],
    ["on another platform", "esp32", SMP_BUILD],
  ])("is not offered %s", async (_label, platform, integrations) => {
    expect(hasBleRow(await mount(platform, integrations))).toBe(false);
  });

  it("is not offered without Web Bluetooth", async () => {
    delete (navigator as { bluetooth?: unknown }).bluetooth;
    expect(hasBleRow(await mount("nrf52", SMP_BUILD))).toBe(false);
  });

  it("is not offered in logs mode", async () => {
    expect(hasBleRow(await mount("nrf52", SMP_BUILD, "logs"))).toBe(false);
  });
});
