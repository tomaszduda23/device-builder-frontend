/**
 * The boards with a CMSIS-DAP debugger on board, and the WebUSB chooser for
 * those debuggers. Kept outside the lazy engine because ``requestDevice()``
 * must run inside the click's user activation, before any engine chunk is
 * awaited.
 */
import { pickerFailure } from "../../../util/picker-activation.js";
import { isPortPickerCancel } from "../../../util/web-serial.js";
import { NRF54L_CHIPS, type Nrf54lChip } from "./chips.js";

const SEEED_USB_VID = 0x2886;

/** A board's on-board debugger and the chip it is wired to. */
export interface CmsisDapBoard {
  readonly chip: Nrf54lChip;
  /** The debugger's USB ids; its serial bridge to the console shares them. */
  readonly probe: { readonly vendorId: number; readonly productId: number };
}

/** By the board's ESPHome name, which is also its catalog ``board_id``. */
export const CMSIS_DAP_BOARDS: Readonly<Record<string, CmsisDapBoard>> = {
  // A SAMD11 running CMSIS-DAP, also the bridge to the console UART.
  xiao_nrf54lm20a: {
    chip: NRF54L_CHIPS.nrf54lm20a,
    probe: { vendorId: SEEED_USB_VID, productId: 0x0068 },
  },
};

export const cmsisDapBoardOf = (
  boardId: string | null | undefined
): CmsisDapBoard | undefined =>
  boardId && Object.prototype.hasOwnProperty.call(CMSIS_DAP_BOARDS, boardId)
    ? CMSIS_DAP_BOARDS[boardId]
    : undefined;

/** The chooser's filters: every known on-board debugger. */
export const CMSIS_DAP_PROBES: readonly USBDeviceFilter[] = Object.values(
  CMSIS_DAP_BOARDS
).map((b) => ({ ...b.probe }));

/** A Web Serial port that is the serial bridge of an on-board debugger. */
export function isCmsisDapProbePort(port: SerialPort): boolean {
  const { usbVendorId, usbProductId } = port.getInfo();
  return CMSIS_DAP_PROBES.some(
    (p) => p.vendorId === usbVendorId && p.productId === usbProductId
  );
}

/** The chooser, limited to the known debuggers; null when dismissed. */
export async function requestCmsisDapProbe(): Promise<USBDevice | null> {
  try {
    return await navigator.usb.requestDevice({ filters: [...CMSIS_DAP_PROBES] });
  } catch (err) {
    if (isPortPickerCancel(err)) return null;
    throw pickerFailure(err);
  }
}

/** The engine, kept in its own chunk. */
export const loadCmsisDapEngine = () => import("./engine.js");
