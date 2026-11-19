/** WebUSB checks the flash engines that talk to a USB device directly share. */

/** Chromium only; Firefox and Safari have no WebUSB, and it needs a secure context. */
export const isWebUsbSupported = (): boolean => "usb" in navigator;

/** The device dropped off the bus, or a transfer hit a device that already had. */
export function isUsbDeviceLost(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NetworkError" || err.name === "InvalidStateError")
  );
}

/** The OS refused the open (Linux without a udev rule, or another driver holds it). */
export function isUsbAccessDenied(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "SecurityError" || /access denied|permission/i.test(err.message))
  );
}
