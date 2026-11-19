/** The CMSIS-DAP flash engine, loaded on demand (``loadCmsisDapEngine``). */
import type { HexSegment } from "../../../util/intel-hex.js";
import type { Nrf54lChip } from "./chips.js";
import { Dap, UsbDapTransport } from "./dap.js";
import {
  type Nrf54lFlashHooks,
  prepareNrf54l,
  runNrf54l,
  writeNrf54l,
} from "./nrf54l.js";
import { SwdTarget } from "./swd.js";

export { NoDapInterfaceError } from "./dap.js";
export { ImageOutOfRangeError, VerifyError, WrongChipError } from "./nrf54l.js";

export interface CmsisDapFlashHooks extends Nrf54lFlashHooks {
  /** The probe is claimed and the chip halted; the write is about to start. */
  onDeviceOpened?: () => void;
  /** The caller moved on: stop before writing anything. */
  cancelled?: () => boolean;
}

/**
 * Open the probe, write ``segments`` into the chip behind it and start the
 * new firmware. False when the caller moved on before the write; the probe
 * is released either way.
 */
export async function flashOverCmsisDap(
  usb: USBDevice,
  chip: Nrf54lChip,
  segments: readonly HexSegment[],
  hooks: CmsisDapFlashHooks
): Promise<boolean> {
  const log = hooks.onLog ?? (() => {});
  const transport = await UsbDapTransport.open(usb);
  const dap = new Dap(transport);
  try {
    const packet = await dap.readPacketSize();
    log(`Opened the CMSIS-DAP probe (${packet}-byte packets)`);
    const target = new SwdTarget(dap);
    await prepareNrf54l(target, chip, log);
    if (hooks.cancelled?.()) return false;
    hooks.onDeviceOpened?.();
    await writeNrf54l(target, chip, segments, hooks);
    await runNrf54l(target);
    log("Started the new firmware");
    return true;
  } finally {
    await dap.disconnect().catch(() => {});
    await transport.close().catch(() => {});
  }
}
