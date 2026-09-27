/**
 * @vitest-environment happy-dom
 *
 * The nRF52 Bluetooth update flow: compile, download ``app_update.bin``,
 * the Connect step, and how the upload's outcomes land on the dialog.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { flashMcubootOverBle as FlashOverBle } from "../../../src/util/smp/smp-flash.js";

const mocks = vi.hoisted(() => ({
  compileOrFail: vi.fn(),
  fetchBinaries: vi.fn(),
  failNoBinaries: vi.fn(),
  requestBleDevice: vi.fn(),
  flashMcubootOverBle: vi.fn<typeof FlashOverBle>(),
}));
vi.mock("../../../src/components/firmware-install-dialog/install-flow.js", () => ({
  compileOrFail: mocks.compileOrFail,
  fetchBinaries: mocks.fetchBinaries,
  failNoBinaries: mocks.failNoBinaries,
}));
vi.mock("../../../src/util/web-bluetooth.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestBleDevice: mocks.requestBleDevice,
}));
vi.mock("../../../src/util/smp/smp-flash.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flashMcubootOverBle: mocks.flashMcubootOverBle,
}));

import type { ConfiguredDevice } from "../../../src/api/types/devices.js";
import type { ESPHomeFirmwareInstallDialog } from "../../../src/components/firmware-install-dialog.js";
import {
  nrfSmpDoFlash,
  SMP_APP_IMAGE,
  startNrfSmpInstall,
} from "../../../src/components/firmware-install-dialog/nrf-smp-install.js";
import {
  SmpServiceNotFoundError,
  SmpSlotError,
} from "../../../src/util/smp/smp-errors.js";
import { SMP_SERVICE_UUID } from "../../../src/util/smp/smp-uuids.js";
import { BleUnavailableError } from "../../../src/util/web-bluetooth.js";
import { makeMcubootImage } from "../../util/smp/_fake-smp-device.js";

const device = {
  configuration: "xiao.yaml",
  name: "xiao",
  friendly_name: "Xiao",
  target_platform: "nrf52",
} as ConfiguredDevice;
const bleDevice = { name: "xiao" } as BluetoothDevice;

interface FakeHost {
  _device: ConfiguredDevice | null;
  _api: { firmwareDownloadBytes: ReturnType<typeof vi.fn> };
  _localize: (key: string) => string;
  _log: { lines: string[]; enqueue: (line: string) => void };
  _step: string;
  _statusMessage: string;
  _errorMessage: string;
  _flashPercent: number;
  _smpImage: unknown;
  _fail: (title: string, detail?: string) => void;
}

function makeHost(bytes: ArrayBuffer): FakeHost {
  const lines: string[] = [];
  const host: FakeHost = {
    _device: device,
    _api: { firmwareDownloadBytes: vi.fn().mockResolvedValue(bytes) },
    _localize: (key) => key,
    _log: { lines, enqueue: (line) => lines.push(line) },
    _step: "queued",
    _statusMessage: "",
    _errorMessage: "",
    _flashPercent: 0,
    _smpImage: null,
    _fail(title, detail = "") {
      host._step = "error";
      host._statusMessage = title;
      host._errorMessage = detail;
    },
  };
  return host;
}

const asHost = (h: FakeHost) => h as unknown as ESPHomeFirmwareInstallDialog;
const bin = (file: string) => ({ file, title: file, type: "bin" });

async function builtHost(file = SMP_APP_IMAGE): Promise<FakeHost> {
  const bytes = await makeMcubootImage();
  mocks.fetchBinaries.mockResolvedValue([bin("zephyr/zephyr.hex"), bin(file)]);
  return makeHost(bytes.buffer as ArrayBuffer);
}

async function readyHost(): Promise<FakeHost> {
  const host = await builtHost();
  await startNrfSmpInstall(asHost(host));
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compileOrFail.mockResolvedValue(true);
  mocks.requestBleDevice.mockResolvedValue(bleDevice);
  mocks.flashMcubootOverBle.mockResolvedValue(undefined);
});

describe("startNrfSmpInstall", () => {
  it("downloads and parses app_update.bin, then waits for Connect", async () => {
    const host = await readyHost();
    expect(host._api.firmwareDownloadBytes).toHaveBeenCalledWith(
      "xiao.yaml",
      SMP_APP_IMAGE
    );
    expect(host._step).toBe("smp-ready");
    expect(host._statusMessage).toBe("firmware.smp_ready_title");
    expect(host._smpImage).toMatchObject({ version: "1.2.3+4" });
  });

  it("stops when the compile fails", async () => {
    const host = await builtHost();
    mocks.compileOrFail.mockResolvedValue(false);
    await startNrfSmpInstall(asHost(host));
    expect(mocks.fetchBinaries).not.toHaveBeenCalled();
    expect(host._step).toBe("queued");
  });

  it("fails a build without the MCUboot update image", async () => {
    const host = await builtHost("firmware.zip");
    await startNrfSmpInstall(asHost(host));
    expect(host._step).toBe("error");
    expect(host._statusMessage).toBe("firmware.smp_no_image");
  });

  it("fails an image that is not a valid MCUboot image", async () => {
    mocks.fetchBinaries.mockResolvedValue([bin(SMP_APP_IMAGE)]);
    const host = makeHost(new ArrayBuffer(64));
    await startNrfSmpInstall(asHost(host));
    expect(host._step).toBe("error");
    expect(host._statusMessage).toBe("firmware.smp_bad_image");
  });
});

describe("nrfSmpDoFlash", () => {
  it("picks the device by its names and runs the update", async () => {
    const host = await readyHost();
    mocks.flashMcubootOverBle.mockImplementation(async (_d, _img, hooks) => {
      hooks.onLog?.("Uploading 1072 bytes");
      hooks.onProgress(40);
    });
    await nrfSmpDoFlash(asHost(host));
    expect(mocks.requestBleDevice).toHaveBeenCalledWith(
      ["xiao", "Xiao"],
      SMP_SERVICE_UUID
    );
    expect(mocks.flashMcubootOverBle).toHaveBeenCalledWith(
      bleDevice,
      host._smpImage,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(host._log.lines).toEqual(["Uploading 1072 bytes"]);
    expect(host._flashPercent).toBe(40);
    expect(host._step).toBe("done");
    expect(host._statusMessage).toBe("firmware.smp_done");
  });

  it("stays on the step when the chooser is dismissed", async () => {
    const host = await readyHost();
    mocks.requestBleDevice.mockResolvedValue(null);
    await nrfSmpDoFlash(asHost(host));
    expect(host._step).toBe("smp-ready");
    expect(mocks.flashMcubootOverBle).not.toHaveBeenCalled();
    // Not left busy: a second click opens the chooser again.
    await nrfSmpDoFlash(asHost(host));
    expect(mocks.requestBleDevice).toHaveBeenCalledTimes(2);
  });

  it("opens one chooser for a double click", async () => {
    const host = await readyHost();
    const first = nrfSmpDoFlash(asHost(host));
    await nrfSmpDoFlash(asHost(host));
    await first;
    expect(mocks.requestBleDevice).toHaveBeenCalledTimes(1);
  });

  it("explains Bluetooth being off", async () => {
    const host = await readyHost();
    mocks.requestBleDevice.mockRejectedValue(new BleUnavailableError());
    await nrfSmpDoFlash(asHost(host));
    expect(host._step).toBe("error");
    expect(host._errorMessage).toBe("firmware.smp_bluetooth_unavailable");
  });

  it("explains a device without the SMP service", async () => {
    const host = await readyHost();
    mocks.flashMcubootOverBle.mockRejectedValue(new SmpServiceNotFoundError());
    await nrfSmpDoFlash(asHost(host));
    expect(host._step).toBe("error");
    expect(host._statusMessage).toBe("firmware.smp_flash_failed");
    expect(host._errorMessage).toBe("firmware.smp_service_not_found");
  });

  it("finishes when the device already runs the image", async () => {
    const host = await readyHost();
    mocks.flashMcubootOverBle.mockRejectedValue(new SmpSlotError("already-running"));
    await nrfSmpDoFlash(asHost(host));
    expect(host._step).toBe("done");
    expect(host._statusMessage).toBe("firmware.smp_already_running");
  });

  it("aborts the upload and stays quiet once the dialog moved on", async () => {
    const host = await readyHost();
    let signal: AbortSignal | undefined;
    mocks.flashMcubootOverBle.mockImplementation(async (_d, _img, hooks) => {
      signal = hooks.signal;
      host._device = null;
      hooks.onProgress(10);
      throw new Error("link lost");
    });
    await nrfSmpDoFlash(asHost(host));
    expect(signal?.aborted).toBe(true);
    expect(host._step).toBe("flashing");
    expect(host._flashPercent).toBe(0);
  });
});
