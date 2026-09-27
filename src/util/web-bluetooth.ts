/** Web Bluetooth device chooser (Chromium only). */
import { isPortPickerCancel } from "./web-serial.js";

export const isWebBluetoothSupported = (): boolean => "bluetooth" in navigator;

/** No usable Bluetooth adapter: the radio is off or access was denied. */
export class BleUnavailableError extends Error {
  constructor() {
    super("Bluetooth adapter unavailable");
    this.name = "BleUnavailableError";
  }
}

async function bleAdapterAvailable(): Promise<boolean> {
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return false;
  }
}

/**
 * Chooser for a peripheral serving ``service``. ESPHome advertises the node
 * name, so the chooser matches on the given names; with no name known at all
 * it lists every device. The service is listed as optional so GATT access to
 * it is granted after the user picks a device. Returns null when the chooser
 * is dismissed; throws ``BleUnavailableError`` when the adapter is off.
 */
export async function requestBleDevice(
  names: string[],
  service: string
): Promise<BluetoothDevice | null> {
  const known = [...new Set(names.filter(Boolean))];
  const options: RequestDeviceOptions = known.length
    ? { filters: known.map((name) => ({ name })), optionalServices: [service] }
    : { acceptAllDevices: true, optionalServices: [service] };
  try {
    return await navigator.bluetooth.requestDevice(options);
  } catch (err) {
    if (!isPortPickerCancel(err)) throw err;
    // Chrome rejects with the same NotFoundError when the adapter is off.
    if (!(await bleAdapterAvailable())) throw new BleUnavailableError();
    // Also Chrome's answer when no device matched or policy blocked the
    // chooser, so leave a trace for "nothing happened" reports.
    console.debug("Bluetooth chooser closed", err);
    return null;
  }
}
