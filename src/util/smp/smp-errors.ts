/**
 * The SMP update's failures the install dialog explains in its own words.
 * Kept apart from the engine so the dialog can tell them apart without
 * loading it.
 */

/** Why the device's slots rule the update out, for a localized explanation. */
export type SmpSlotProblem = "test-pending" | "already-running";

export class SmpSlotError extends Error {
  constructor(readonly problem: SmpSlotProblem) {
    super(
      problem === "test-pending"
        ? "The running image is still on a test boot and not confirmed"
        : "The device already runs this image"
    );
    this.name = "SmpSlotError";
  }
}

/** The picked device has no SMP service: the wrong device, or no BLE OTA in its build. */
export class SmpServiceNotFoundError extends Error {
  constructor() {
    super("SMP Bluetooth service not found");
    this.name = "SmpServiceNotFoundError";
  }
}
