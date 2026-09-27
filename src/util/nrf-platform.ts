import { isWebBluetoothSupported } from "./web-bluetooth.js";

/**
 * Whether a target platform is an nRF52 device (Adafruit bootloader / Nordic
 * Legacy DFU). Fail-closed: empty / unknown returns false.
 */
export function isNrfPlatform(targetPlatform: string | null | undefined): boolean {
  return (targetPlatform ?? "").toLowerCase().startsWith("nrf52");
}

/**
 * Whether to offer the nRF52 Bluetooth update (MCUmgr / SMP): the build has
 * the MCUmgr OTA and a BLE server, and the browser has Web Bluetooth.
 */
export function smpOffered(integrations: readonly string[]): boolean {
  return (
    isWebBluetoothSupported() &&
    integrations.includes("zephyr_mcumgr") &&
    integrations.includes("zephyr_ble_server")
  );
}
