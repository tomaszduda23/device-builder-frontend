/**
 * The Device Builder's install through a board's on-board CMSIS-DAP probe
 * (the Seeed XIAO nRF54LM20A): compile, download the hex images ESPHome's
 * own ``upload_using_cmsis_dap`` writes, then one user-gesture step that
 * picks the probe and writes them. Works whatever firmware the chip runs.
 */
import type { ConfiguredDevice } from "../../../api/types/devices.js";
import type { FirmwareBinary } from "../../../api/types/firmware-jobs.js";
import type { LocalizeFunc } from "../../../common/localize.js";
import type { ESPHomeFirmwareInstallDialog } from "../../../components/firmware-install-dialog.js";
import { installLog } from "../../../components/firmware-install-dialog/browser-flash-steps.js";
import {
  compileOrFail,
  fetchBinaries,
} from "../../../components/firmware-install-dialog/install-flow.js";
import { getErrorMessage } from "../../../util/error-message.js";
import { notifyError } from "../../../util/notify.js";
import { openFailureMessage } from "../../../util/serial-open-error.js";
import { requestSerialPort } from "../../../util/web-serial.js";
import { isWebUsbSupported } from "../../../util/web-usb.js";
import {
  type BrowserInstall,
  FLASH_ACTION_KEY,
  FlashImageSlot,
} from "../../platform-support.js";
import { cmsisDapFailureCopy, flashCmsisDap } from "./flash.js";
import { type CmsisDapImage, parseCmsisDapImage } from "./image.js";
import { CMSIS_DAP_BOARDS, CMSIS_DAP_PROBES, cmsisDapBoardOf } from "./probe.js";

declare module "../../platform-support.js" {
  interface BrowserFlasherSteps {
    "nrf-cmsis-dap": "nrf-cmsis-dap-ready";
  }
}

// The ``ota:`` platform whose build chains MCUboot in front of the app.
const MCUMGR_OTA = "ota.zephyr_mcumgr";

// Paths under the build directory, as ESPHome's ``upload_using_cmsis_dap``
// picks them. merged.hex only exists on SDKs before 3.4.0 (MCUboot and the
// app together); a newer build is MCUboot plus the signed app, or the app
// alone without MCUboot.
const MERGED_HEX = "zephyr/merged.hex";
const APP_HEX = "zephyr/zephyr.hex";
const MCUBOOT_HEX = "mcuboot/zephyr/zephyr.hex";
const SIGNED_APP_HEX = "zephyr/zephyr/zephyr.signed.hex";

/** The hex files that make up the firmware, in write order; null when the build has none. */
export function cmsisDapHexFiles(
  binaries: readonly FirmwareBinary[],
  device: Pick<ConfiguredDevice, "loaded_platforms">
): string[] | null {
  const listed = (file: string) => binaries.some((b) => b.file === file);
  if (listed(MERGED_HEX)) return [MERGED_HEX];
  // Not listed for download: the backend serves any file of the build.
  if (device.loaded_platforms.includes(MCUMGR_OTA)) return [MCUBOOT_HEX, SIGNED_APP_HEX];
  return listed(APP_HEX) ? [APP_HEX] : null;
}

const cmsisDapImage = new FlashImageSlot<CmsisDapImage>();

function showReady(host: ESPHomeFirmwareInstallDialog): void {
  host._step = "nrf-cmsis-dap-ready";
  host._statusMessage = host._localize("firmware.cmsis_dap_ready_title");
}

/** Compile, download and parse the hex images, then show the ready step. */
async function startCmsisDapInstall(host: ESPHomeFirmwareInstallDialog): Promise<void> {
  const device = host._device;
  const chip = cmsisDapBoardOf(device?.board_id)?.chip;
  if (!device || !chip) return;
  const stale = () => host._device !== device;
  if (!(await compileOrFail(host, device.configuration)) || stale()) return;

  host._statusMessage = host._localize("firmware.status_downloading");
  host._step = "downloading";
  const binaries = await fetchBinaries(host, device.configuration);
  if (!binaries || stale()) return;
  const files = cmsisDapHexFiles(binaries, device);
  if (!files) {
    host._fail(host._localize("firmware.cmsis_dap_no_hex"));
    return;
  }
  const texts: string[] = [];
  try {
    for (const file of files) {
      const bytes = await host._api.firmwareDownloadBytes(device.configuration, file);
      texts.push(new TextDecoder().decode(bytes));
    }
  } catch (err) {
    if (!stale()) {
      host._fail(host._localize("firmware.download_failed"), getErrorMessage(err));
    }
    return;
  }
  if (stale()) return;
  const parsed = parseCmsisDapImage(chip, texts);
  if ("key" in parsed) {
    host._fail(host._localize(parsed.key), parsed.detail);
    return;
  }
  cmsisDapImage.set(host, parsed);
  showReady(host);
}

/** Pick the probe and write the image; runs from the Flash click (user gesture). */
async function flashOverProbe(host: ESPHomeFirmwareInstallDialog): Promise<void> {
  const image = cmsisDapImage.get(host);
  if (!image || host._flashBusy) return;
  const device = host._device;
  const stillCurrent = () => host._device === device && cmsisDapImage.get(host) === image;
  host._flashBusy = true;
  const abort = new AbortController();
  host._flashAbort = abort;
  let flashed: boolean;
  try {
    flashed = await flashCmsisDap(image.chip, image.segments, {
      signal: abort.signal,
      cancelled: () => !stillCurrent(),
      onLog: installLog(host, stillCurrent),
      onDeviceOpened: () => {
        host._flashBusy = false;
        host._step = "flashing";
        host._statusMessage = host._localize("firmware.status_flashing");
        host._flashPercent = 0;
      },
      onProgress: (percent) => {
        if (stillCurrent()) host._flashPercent = percent;
      },
    });
  } catch (err) {
    if (!stillCurrent()) return;
    const { title, detail } = cmsisDapFailureCopy(err, host._localize);
    host._fail(title, detail);
    return;
  } finally {
    if (stillCurrent()) host._flashBusy = false;
    if (host._flashAbort === abort) host._flashAbort = null;
  }
  if (!flashed || !stillCurrent()) return;
  host._statusMessage = host._localize("firmware.status_done");
  host._step = "done";
}

/** The probe's serial bridge carries the console; pick it for the logs. */
async function pickProbeSerialPort(localize: LocalizeFunc): Promise<SerialPort | null> {
  try {
    return await requestSerialPort({
      filters: CMSIS_DAP_PROBES.map((p) => ({
        usbVendorId: p.vendorId,
        usbProductId: p.productId,
      })),
    });
  } catch (err) {
    notifyError(
      openFailureMessage(err, localize, "dashboard.logs_web_serial_open_failed")
    );
    return null;
  }
}

export const nrfCmsisDapInstall: BrowserInstall<"nrf-cmsis-dap"> = {
  id: "nrf-cmsis-dap",
  methodKey: "nrf_cmsis_dap",
  // Only boards with the debugger on board; an unknown board is not offered.
  boards: Object.keys(CMSIS_DAP_BOARDS),
  // It writes MCUboot itself; ESPHome takes the probe for these builds only.
  bootloaders: ["mcuboot"],
  available: isWebUsbSupported,
  icon: "usb",
  holdsPort: () => false,
  image: cmsisDapImage,
  start: startCmsisDapInstall,
  showFirstStep: showReady,
  pickLogsPort: pickProbeSerialPort,
  steps: {
    "nrf-cmsis-dap-ready": {
      detailKey: "firmware.cmsis_dap_ready_desc",
      footer: () => ({ primary: { run: flashOverProbe, labelKey: FLASH_ACTION_KEY } }),
    },
  },
};
