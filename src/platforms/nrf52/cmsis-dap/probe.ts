/**
 * The CMSIS-DAP probes boards carry on board, and the WebUSB chooser for
 * them. Kept outside the lazy engine because ``requestDevice()`` must run
 * inside the click's user activation, before any engine chunk is awaited.
 */
import { pickerFailure } from "../../../util/picker-activation.js";
import { isPortPickerCancel } from "../../../util/web-serial.js";

const SEEED_USB_VID = 0x2886;

/** The on-board probes, as USB ids: their CMSIS-DAP and their serial bridge share them. */
export const CMSIS_DAP_PROBES: readonly USBDeviceFilter[] = [
  // Seeed XIAO nRF54LM20A: a SAMD11 running CMSIS-DAP, also the console's UART bridge.
  { vendorId: SEEED_USB_VID, productId: 0x0068 },
];

/** A Web Serial port that is the serial bridge of an on-board probe. */
export function isCmsisDapProbePort(port: SerialPort): boolean {
  const { usbVendorId, usbProductId } = port.getInfo();
  return CMSIS_DAP_PROBES.some(
    (p) => p.vendorId === usbVendorId && p.productId === usbProductId
  );
}

/** The chooser, limited to the known probes; null when dismissed. */
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
