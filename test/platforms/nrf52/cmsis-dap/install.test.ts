// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { flashCmsisDap as FlashCmsisDap } from "../../../../src/platforms/nrf52/cmsis-dap/flash.js";

const mocks = vi.hoisted(() => ({
  flashCmsisDap: vi.fn<typeof FlashCmsisDap>(),
}));
vi.mock("../../../../src/platforms/nrf52/cmsis-dap/flash.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flashCmsisDap: mocks.flashCmsisDap,
}));

import { makeConfiguredDevice } from "../../../_make-configured-device.js";
import type { ConfiguredDevice } from "../../../../src/api/types/devices.js";
import { CmsisDapFlashError } from "../../../../src/platforms/nrf52/cmsis-dap/flash.js";
import type { CmsisDapImage } from "../../../../src/platforms/nrf52/cmsis-dap/image.js";
import {
  cmsisDapHexFiles,
  nrfCmsisDapInstall,
} from "../../../../src/platforms/nrf52/cmsis-dap/install.js";
import {
  installOf,
  installsFor,
  platformFor,
} from "../../../../src/platforms/registry.js";
import {
  asHost,
  bin,
  makeFlashHost,
} from "../../../components/firmware-install-dialog/_flash-host.js";

const HEX = ":0400000001020304F2\n:00000001FF\n";
const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

const device = (over: Partial<ConfiguredDevice> = {}) =>
  makeConfiguredDevice({
    configuration: "xiao.yaml",
    name: "xiao",
    target_platform: "nrf52",
    mcu: null,
    bootloader: "mcuboot",
    loaded_platforms: [],
    ...over,
  });

function makeHost(d = device(), files = ["zephyr/zephyr.hex"], text = HEX) {
  const host = makeFlashHost(d, {
    binaries: files.map((f) => bin(f)),
    downloadBytes: encode(text),
  });
  return host;
}

const flash = (host: ReturnType<typeof makeHost>) =>
  nrfCmsisDapInstall.steps["nrf-cmsis-dap-ready"].footer!().primary.run(asHost(host));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flashCmsisDap.mockResolvedValue(true);
});

describe("cmsisDapHexFiles", () => {
  const files = (listed: string[], platforms: string[] = []) =>
    cmsisDapHexFiles(
      listed.map((f) => bin(f)),
      { loaded_platforms: platforms }
    );

  it("takes merged.hex from an SDK that still makes it", () => {
    expect(
      files(["zephyr/merged.hex", "zephyr/zephyr.hex"], ["ota.zephyr_mcumgr"])
    ).toEqual(["zephyr/merged.hex"]);
  });

  it("takes MCUboot and the signed app from a build with the mcumgr OTA", () => {
    expect(files(["zephyr/zephyr.hex"], ["ota.zephyr_mcumgr"])).toEqual([
      "mcuboot/zephyr/zephyr.hex",
      "zephyr/zephyr/zephyr.signed.hex",
    ]);
  });

  it("takes the app alone without MCUboot, and nothing from a build with no hex", () => {
    expect(files(["zephyr/zephyr.hex"])).toEqual(["zephyr/zephyr.hex"]);
    expect(files(["firmware.elf"])).toBeNull();
  });
});

describe("offering the CMSIS-DAP install", () => {
  it("is offered to any nRF board built for MCUboot, ahead of everything else", () => {
    const d = device();
    expect(installsFor(d)).toContain(nrfCmsisDapInstall);
    expect(installOf(platformFor(d.target_platform), d)).toBe(nrfCmsisDapInstall);
  });

  it("is not offered to a build for another bootloader", () => {
    expect(installsFor(device({ bootloader: "adafruit" }))).not.toContain(
      nrfCmsisDapInstall
    );
  });

  it("is not offered where the bootloader is unknown", () => {
    expect(installsFor(device({ bootloader: null }))).not.toContain(nrfCmsisDapInstall);
  });
});

describe("CMSIS-DAP install", () => {
  it("downloads the hex images and shows the ready step", async () => {
    const host = makeHost(device({ loaded_platforms: ["ota.zephyr_mcumgr"] }));
    await nrfCmsisDapInstall.start(asHost(host));

    expect(host._api.firmwareDownloadBytes).toHaveBeenCalledWith(
      "xiao.yaml",
      "mcuboot/zephyr/zephyr.hex"
    );
    expect(host._api.firmwareDownloadBytes).toHaveBeenCalledWith(
      "xiao.yaml",
      "zephyr/zephyr/zephyr.signed.hex"
    );
    expect(host._step).toBe("nrf-cmsis-dap-ready");
    expect(nrfCmsisDapInstall.image.get(asHost(host))).toMatchObject({
      segments: [{ address: 0 }],
    });
  });

  it("fails a build without a hex image", async () => {
    const host = makeHost(device(), ["firmware.elf"]);
    await nrfCmsisDapInstall.start(asHost(host));
    expect(host._step).toBe("error");
    expect(host._statusMessage).toBe("firmware.cmsis_dap_no_hex");
  });

  it("fails a file that is not Intel HEX", async () => {
    const host = makeHost(device(), ["zephyr/zephyr.hex"], "not hex");
    await nrfCmsisDapInstall.start(asHost(host));
    expect(host._statusMessage).toBe("firmware.cmsis_dap_bad_image");
  });

  it("fails a download that did not arrive", async () => {
    const host = makeHost();
    vi.mocked(host._api.firmwareDownloadBytes).mockRejectedValue(new Error("404"));
    await nrfCmsisDapInstall.start(asHost(host));
    expect(host._statusMessage).toBe("firmware.download_failed");
    expect(host._errorMessage).toBe("404");
  });

  it("writes the image through the probe and reports progress", async () => {
    const host = makeHost();
    await nrfCmsisDapInstall.start(asHost(host));
    mocks.flashCmsisDap.mockImplementation(async (_segments, hooks) => {
      hooks.onDeviceOpened?.();
      hooks.onLog?.("Halted the nRF54LM20A");
      hooks.onProgress(60);
      return true;
    });

    await flash(host);

    const image = nrfCmsisDapInstall.image.get(asHost(host)) as CmsisDapImage;
    expect(mocks.flashCmsisDap).toHaveBeenCalledWith(
      image.segments,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(host._log.lines).toEqual(["Halted the nRF54LM20A"]);
    expect(host._flashPercent).toBe(60);
    expect(host._step).toBe("done");
    expect(host._flashBusy).toBe(false);
    expect(host._flashAbort).toBeNull();
  });

  it("stays on the ready step when the chooser is dismissed", async () => {
    const host = makeHost();
    await nrfCmsisDapInstall.start(asHost(host));
    mocks.flashCmsisDap.mockResolvedValue(false);
    await flash(host);
    expect(host._step).toBe("nrf-cmsis-dap-ready");
    expect(host._flashBusy).toBe(false);
  });

  it("names a failed write", async () => {
    const host = makeHost();
    await nrfCmsisDapInstall.start(asHost(host));
    mocks.flashCmsisDap.mockRejectedValue(
      new CmsisDapFlashError("access-denied", new Error("Access denied."))
    );
    await flash(host);
    expect(host._step).toBe("error");
    expect(host._statusMessage).toBe("firmware.cmsis_dap_access_denied");
    expect(host._errorMessage).toBe("Access denied.");
  });

  it("does not report into a dialog that moved on to another device", async () => {
    const host = makeHost();
    await nrfCmsisDapInstall.start(asHost(host));
    mocks.flashCmsisDap.mockImplementation(async () => {
      host._device = device({ name: "other" });
      throw new CmsisDapFlashError("flash", new Error("boom"));
    });
    await flash(host);
    expect(host._step).toBe("nrf-cmsis-dap-ready");
  });
});
