/**
 * nRF52 update over Bluetooth for the firmware-install-dialog: MCUmgr (SMP)
 * into an MCUboot device running ESPHome's ``zephyr_mcumgr`` OTA with its BLE
 * transport. Compile, download ``app_update.bin``, then one user-gesture step
 * ("smp-ready" → Connect) opens the Bluetooth chooser and runs the upload.
 * The SMP engine loads on demand so it stays out of the main chunk.
 */
import type { LocalizeFunc } from "../../common/localize.js";
import { getErrorMessage } from "../../util/error-message.js";
import type { McubootImage } from "../../util/smp/mcuboot-image.js";
import { SmpServiceNotFoundError, SmpSlotError } from "../../util/smp/smp-errors.js";
import { SMP_SERVICE_UUID } from "../../util/smp/smp-uuids.js";
import { BleUnavailableError, requestBleDevice } from "../../util/web-bluetooth.js";
import type { ESPHomeFirmwareInstallDialog } from "../firmware-install-dialog.js";
import { compileOrFail, failNoBinaries, fetchBinaries } from "./install-flow.js";

export const loadSmpEngine = () => import("../../util/smp/smp-flash.js");

/** The signed MCUboot app image ESPHome builds for an MCUboot nRF52. */
export const SMP_APP_IMAGE = "zephyr/app_update.bin";

// Dialogs with a Connect click in flight, so a double click opens one chooser.
const busy = new WeakSet<ESPHomeFirmwareInstallDialog>();

/** Compile, download and check the image, then show the Connect step. */
export async function startNrfSmpInstall(
  host: ESPHomeFirmwareInstallDialog
): Promise<void> {
  const device = host._device;
  if (!device) return;
  const stale = () => host._device !== device;

  if (!(await compileOrFail(host, device.configuration))) return;

  host._statusMessage = host._localize("firmware.status_downloading");
  const binaries = await fetchBinaries(host, device.configuration);
  if (!binaries || stale()) return;
  const binary = binaries.find((b) => b.file === SMP_APP_IMAGE);
  if (!binary) {
    if (binaries.length === 0)
      failNoBinaries(host, { isWebFlasher: false, isEmpty: true });
    else host._fail(host._localize("firmware.smp_no_image"));
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await host._api.firmwareDownloadBytes(device.configuration, binary.file)
    );
  } catch {
    if (!stale()) host._fail(host._localize("firmware.download_failed"));
    return;
  }
  if (stale()) return;

  let image: McubootImage;
  try {
    const engine = await loadSmpEngine();
    image = await engine.parseMcubootImage(bytes);
  } catch (err) {
    if (!stale())
      host._fail(host._localize("firmware.smp_bad_image"), getErrorMessage(err));
    return;
  }
  if (stale()) return;

  host._smpImage = image;
  host._step = "smp-ready";
  host._statusMessage = host._localize("firmware.smp_ready_title");
}

function failureDetail(err: unknown, localize: LocalizeFunc): string {
  if (err instanceof SmpServiceNotFoundError) {
    return localize("firmware.smp_service_not_found");
  }
  if (err instanceof SmpSlotError && err.problem === "test-pending") {
    return localize("firmware.smp_test_pending");
  }
  return getErrorMessage(err);
}

/**
 * Pick the device in the Bluetooth chooser and update it.
 * Must be called directly from a user-gesture handler for requestDevice().
 */
export async function nrfSmpDoFlash(host: ESPHomeFirmwareInstallDialog): Promise<void> {
  const image = host._smpImage;
  const device = host._device;
  if (!image || !device || busy.has(host)) return;
  const stillCurrent = () => host._device === device && host._smpImage === image;

  busy.add(host);
  let bleDevice: BluetoothDevice | null;
  try {
    // The firmware advertises the node name; the friendly name is a guess.
    bleDevice = await requestBleDevice(
      [device.name, device.friendly_name],
      SMP_SERVICE_UUID
    );
  } catch (err) {
    if (stillCurrent()) {
      host._fail(
        host._localize("firmware.smp_flash_failed"),
        err instanceof BleUnavailableError
          ? host._localize("firmware.smp_bluetooth_unavailable")
          : getErrorMessage(err)
      );
    }
    return;
  } finally {
    busy.delete(host);
  }
  // The chooser outlives a dismissed dialog; don't update for an install that is gone.
  if (!bleDevice || !stillCurrent()) return;

  host._step = "flashing";
  host._statusMessage = host._localize("firmware.smp_uploading");
  host._flashPercent = 0;
  // Closing or reusing the dialog stops the upload at the next chunk; the
  // device keeps running its old image.
  const abort = new AbortController();
  try {
    // A cache hit: the engine loaded when the image was parsed.
    const { flashMcubootOverBle } = await loadSmpEngine();
    await flashMcubootOverBle(bleDevice, image, {
      signal: abort.signal,
      onProgress: (percent) => {
        if (stillCurrent()) host._flashPercent = percent;
        else abort.abort();
      },
      onLog: (line) => {
        if (stillCurrent()) host._log.enqueue(line);
        else abort.abort();
      },
    });
  } catch (err) {
    if (!stillCurrent()) return;
    if (err instanceof SmpSlotError && err.problem === "already-running") {
      host._statusMessage = host._localize("firmware.smp_already_running");
      host._step = "done";
      return;
    }
    host._fail(
      host._localize("firmware.smp_flash_failed"),
      failureDetail(err, host._localize)
    );
    return;
  }
  if (!stillCurrent()) return;
  host._statusMessage = host._localize("firmware.smp_done");
  host._step = "done";
}
