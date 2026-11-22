/**
 * Writing an image through a board's on-board CMSIS-DAP probe, from the
 * chooser to the restart: the sequence both the Device Builder's install
 * dialog and web.esphome.io's dialog run. The engine loads on demand.
 */
import type { LocalizeFunc } from "../../../common/localize.js";
import { getErrorMessage } from "../../../util/error-message.js";
import { formatUsbId } from "../../../util/flash-log.js";
import type { HexSegment } from "../../../util/intel-hex.js";
import { connectFailureDetail } from "../../../util/serial-open-error.js";
import { isUsbAccessDenied, isUsbDeviceLost } from "../../../util/web-usb.js";
import type { CmsisDapFlashHooks } from "./engine.js";
import { loadCmsisDapEngine, requestCmsisDapProbe } from "./probe.js";

/** Why the write stopped; ``cmsisDapFailureCopy`` has the words. */
export type CmsisDapFailure =
  | "access-denied"
  | "no-dap"
  | "wrong-chip"
  | "image"
  | "device-lost"
  | "connect"
  | "flash";

export class CmsisDapFlashError extends Error {
  constructor(
    readonly kind: CmsisDapFailure,
    // Error.cause needs lib ES2022; the field is declared here instead.
    readonly cause?: unknown
  ) {
    super(`CMSIS-DAP flash failed (${kind})`);
    this.name = "CmsisDapFlashError";
  }
}

type Engine = Awaited<ReturnType<typeof loadCmsisDapEngine>>;

function failureKind(engine: Engine, err: unknown, opened: boolean): CmsisDapFailure {
  if (isUsbDeviceLost(err)) return "device-lost";
  if (err instanceof engine.NoDapInterfaceError) return "no-dap";
  if (err instanceof engine.WrongChipError) return "wrong-chip";
  if (err instanceof engine.ImageOutOfRangeError) return "image";
  if (!opened) return isUsbAccessDenied(err) ? "access-denied" : "connect";
  return "flash";
}

/**
 * Pick the debugger, write ``segments`` into the chip found behind it and start the
 * firmware. False when the chooser was dismissed or the caller moved on.
 * Throws ``CmsisDapFlashError``.
 */
export async function flashCmsisDap(
  segments: readonly HexSegment[],
  hooks: CmsisDapFlashHooks
): Promise<boolean> {
  const cancelled = hooks.cancelled ?? (() => false);
  let usb: USBDevice | null;
  try {
    usb = await requestCmsisDapProbe();
  } catch (err) {
    throw new CmsisDapFlashError("connect", err);
  }
  if (!usb || cancelled()) return false;
  const engine = await loadCmsisDapEngine().catch((err: unknown) => {
    throw new CmsisDapFlashError("connect", err);
  });
  hooks.onLog?.(`Picked the probe (${formatUsbId(usb.vendorId, usb.productId)})`);
  let opened = false;
  try {
    return await engine.flashOverCmsisDap(usb, segments, {
      ...hooks,
      cancelled,
      onDeviceOpened: () => {
        opened = true;
        hooks.onDeviceOpened?.();
      },
    });
  } catch (err) {
    throw new CmsisDapFlashError(failureKind(engine, err, opened), err);
  }
}

/**
 * The title and detail a dialog shows for a failed write; anything
 * ``flashCmsisDap`` did not name reads as a failed flash.
 */
export function cmsisDapFailureCopy(
  err: unknown,
  localize: LocalizeFunc
): { title: string; detail: string } {
  const failed = localize("firmware.cmsis_dap_flash_failed");
  if (!(err instanceof CmsisDapFlashError)) {
    return { title: failed, detail: getErrorMessage(err) };
  }
  const detail = getErrorMessage(err.cause);
  switch (err.kind) {
    case "access-denied":
      return { title: localize("firmware.cmsis_dap_access_denied"), detail };
    case "no-dap":
      return { title: localize("firmware.cmsis_dap_no_interface"), detail };
    case "wrong-chip":
      return { title: localize("firmware.cmsis_dap_wrong_chip"), detail };
    case "image":
      return { title: localize("firmware.cmsis_dap_bad_image"), detail };
    case "device-lost":
      return { title: failed, detail: localize("firmware.cmsis_dap_device_lost") };
    case "connect":
      return {
        title: localize("firmware.browser_flash_connect_failed"),
        detail: connectFailureDetail(err.cause, localize),
      };
    case "flash":
      return { title: failed, detail };
  }
}
