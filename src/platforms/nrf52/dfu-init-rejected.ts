/**
 * The bootloader dropped the link on the first data packet, right after it
 * ACKed the init packet. The Adafruit bootloader ACKs the init packet on
 * receipt and validates it afterwards; a package whose device type or
 * SoftDevice requirement does not match the board fails that check, and the
 * bootloader resets the chip. Retrying cannot help, so this is not treated
 * as a dropped device. Kept out of the engine chunk so the failure copy can
 * recognise it without loading the engine.
 */
export class DfuInitRejectedError extends Error {
  /**
   * @param softDevices The package's accepted SoftDevice IDs, as ``0x00CA``.
   * @param reason The transport error the reset surfaced as.
   */
  constructor(
    readonly softDevices: string[],
    readonly reason: string
  ) {
    super(`The bootloader rejected the init packet: ${reason}`);
    this.name = "DfuInitRejectedError";
  }
}
