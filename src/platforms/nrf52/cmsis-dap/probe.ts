/**
 * The WebUSB chooser for a CMSIS-DAP debugger. Kept outside the lazy engine
 * because ``requestDevice()`` must run inside the click's user activation,
 * before any engine chunk is awaited.
 */
import { pickerFailure } from "../../../util/picker-activation.js";
import { isPortPickerCancel } from "../../../util/web-serial.js";

/**
 * Devices with a vendor-specific interface, which every CMSIS-DAP v2 debugger
 * has (a filter cannot match its "CMSIS-DAP" name). The engine finds the
 * interface after the pick and names a device without one.
 */
const VENDOR_INTERFACE: USBDeviceFilter = { classCode: 0xff };

/** The chooser; null when dismissed. */
export async function requestCmsisDapProbe(): Promise<USBDevice | null> {
  try {
    return await navigator.usb.requestDevice({ filters: [VENDOR_INTERFACE] });
  } catch (err) {
    if (isPortPickerCancel(err)) return null;
    throw pickerFailure(err);
  }
}

/** The engine, kept in its own chunk. */
export const loadCmsisDapEngine = () => import("./engine.js");
