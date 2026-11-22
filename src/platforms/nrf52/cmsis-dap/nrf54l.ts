/**
 * Writing an image into an nRF54L's RRAM through its debug port, the way
 * ESPHome's ``upload_using_cmsis_dap`` does with pyOCD: unlock a protected
 * chip by erasing it, halt the core at reset, stop the watchdog, write the
 * image through the RRAM controller's write buffer, read it back, and start
 * it. Part of the on-demand engine chunk.
 */
import { formatAddress } from "../../../util/flash-log.js";
import { hexImageSize, type HexSegment } from "../../../util/intel-hex.js";
import { sleep } from "../../../util/sleep.js";
import { type Nrf54lChip, nrf54lChipByPart, outOfRange } from "./chips.js";
import { AP_IDR, type SwdTarget } from "./swd.js";

const AHB_AP = 0;
const CTRL_AP = 2;
const CTRL_AP_IDR = 0x32880000;
const CTRL_AP_RESET = 0x000;
const CTRL_AP_ERASEALL = 0x004;
const CTRL_AP_ERASEALLSTATUS = 0x008;
const ERASEALL_READYTORESET = 0x1;
const ERASEALL_ERROR = 0x3;
const CSW_DEVICEEN = 0x40;
const ERASE_TIMEOUT_MS = 30_000;

const FICR_INFO_PART = 0x00ffc31c;

const DHCSR = 0xe000edf0;
const DEMCR = 0xe000edfc;
const AIRCR = 0xe000ed0c;
const DBGKEY = 0xa05f0000;
const C_DEBUGEN = 1 << 0;
const C_HALT = 1 << 1;
const S_HALT = 1 << 17;
const VC_CORERESET = 1 << 0;
const AIRCR_SYSRESETREQ = 0x05fa0004;
const HALT_TIMEOUT_MS = 1000;

// The watchdog keeps counting while the core is halted, unless the firmware
// paused it for the debugger, and would reset the chip mid-write. ESPHome's
// pyOCD script stops it the same way.
const WDT31 = 0x50109000;
const WDT_TASKS_STOP = 0x004;
const WDT_TSEN = 0x520;
const WDT_TSEN_KEY = 0x6e524635;

const RRAMC_TASKS_COMMITWRITEBUF = 0x008;
const RRAMC_READY = 0x400;
const RRAMC_CONFIG = 0x500;
// Writes enabled through the 32-line write buffer: unbuffered writes fault
// on the nRF54LM20A (pyocd/pyOCD#2016).
const RRAMC_CONFIG_WRITE = 0x2001;
const RRAMC_READY_TIMEOUT_MS = 1000;

export interface Nrf54lFlashHooks {
  onProgress: (percent: number) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/** Not an nRF54L, or one of the family the flasher does not know. */
export class WrongChipError extends Error {
  constructor(readonly found: string) {
    super(`The probe is connected to ${found}`);
    this.name = "WrongChipError";
  }
}

/** The image puts bytes outside the chip's RRAM and UICR. */
export class ImageOutOfRangeError extends Error {
  constructor(readonly address: number) {
    super(`The image writes outside the chip's memory, at ${formatAddress(address)}`);
    this.name = "ImageOutOfRangeError";
  }
}

/** What was read back is not what was written. */
export class VerifyError extends Error {
  constructor(readonly address: number) {
    super(`Verify failed at ${formatAddress(address)}`);
    this.name = "VerifyError";
  }
}

/**
 * Word-aligned copies of ``segments``: a segment that starts or ends inside a
 * word takes the bytes around it from ``current``, so only the image's bytes
 * change.
 */
export async function alignSegments(
  segments: readonly HexSegment[],
  current: (address: number) => Promise<number>
): Promise<{ address: number; words: Uint32Array }[]> {
  const out: { address: number; words: Uint32Array }[] = [];
  for (const seg of segments) {
    const start = seg.address & ~3;
    const end = (seg.address + seg.data.length + 3) & ~3;
    const bytes = new Uint8Array(end - start);
    const view = new DataView(bytes.buffer);
    if (start !== seg.address) view.setUint32(0, await current(start), true);
    if (end !== seg.address + seg.data.length) {
      view.setUint32(bytes.length - 4, await current(end - 4), true);
    }
    bytes.set(seg.data, seg.address - start);
    const words = new Uint32Array(bytes.length / 4);
    for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
    out.push({ address: start, words });
  }
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function poll(
  read: () => Promise<number>,
  done: (value: number) => boolean,
  timeoutMs: number,
  what: string
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The chip's CTRL-AP answers, so this is an nRF54L. */
async function checkCtrlAp(target: SwdTarget): Promise<void> {
  const idr = await target.readAp(CTRL_AP, AP_IDR);
  if (idr >>> 0 !== CTRL_AP_IDR) {
    throw new WrongChipError(
      `a chip that is not an nRF54L (CTRL-AP ${formatAddress(idr)})`
    );
  }
}

const isUnlocked = async (target: SwdTarget): Promise<boolean> =>
  ((await target.readAp(AHB_AP, 0x00)) & CSW_DEVICEEN) !== 0;

/** APPROTECT: erase everything through the CTRL-AP, which lifts it, then reconnect. */
async function unlock(target: SwdTarget, log: (line: string) => void): Promise<void> {
  log("The chip is protected (APPROTECT); erasing it to unlock it");
  await target.writeAp(CTRL_AP, CTRL_AP_ERASEALL, 1);
  const status = await poll(
    () => target.readAp(CTRL_AP, CTRL_AP_ERASEALLSTATUS),
    (s) => s === ERASEALL_READYTORESET || s === ERASEALL_ERROR,
    ERASE_TIMEOUT_MS,
    "the erase"
  );
  if (status === ERASEALL_ERROR) throw new Error("The chip refused the erase");
  await sleep(10);
  await target.writeAp(CTRL_AP, CTRL_AP_RESET, 2);
  await target.writeAp(CTRL_AP, CTRL_AP_RESET, 0);
  await sleep(200);
  // The reset faults the rest of this connection; a new one reaches the chip.
  await target.connect();
  if (!(await isUnlocked(target))) throw new Error("The chip is still protected");
}

/** Halt the core at its reset vector, so no firmware runs while RRAM is written. */
async function resetAndHalt(target: SwdTarget): Promise<void> {
  const halted = () =>
    poll(
      () => target.read32(AHB_AP, DHCSR),
      (v) => (v & S_HALT) !== 0,
      HALT_TIMEOUT_MS,
      "the core to halt"
    );
  await target.write32(AHB_AP, DHCSR, DBGKEY | C_HALT | C_DEBUGEN);
  await halted();
  const demcr = await target.read32(AHB_AP, DEMCR);
  await target.write32(AHB_AP, DEMCR, demcr | VC_CORERESET);
  // The reset lands before the write is acknowledged on some chips.
  await target.write32(AHB_AP, AIRCR, AIRCR_SYSRESETREQ).catch(() => {});
  await sleep(50);
  try {
    await halted();
  } catch {
    // The reset dropped the debug connection; bring it back and halt again.
    await target.connect();
    await target.write32(AHB_AP, DHCSR, DBGKEY | C_HALT | C_DEBUGEN);
    await halted();
  }
  await target.write32(AHB_AP, DEMCR, demcr & ~VC_CORERESET);
}

async function stopWatchdog(target: SwdTarget): Promise<void> {
  await target.write32(AHB_AP, WDT31 + WDT_TSEN, WDT_TSEN_KEY);
  await target.write32(AHB_AP, WDT31 + WDT_TASKS_STOP, 1);
  await target.write32(AHB_AP, WDT31 + WDT_TSEN, 0);
}

/** Which chip this is, from its part code. */
async function detectChip(target: SwdTarget): Promise<Nrf54lChip> {
  const part = await target.read32(AHB_AP, FICR_INFO_PART);
  const chip = nrf54lChipByPart(part);
  if (!chip) {
    throw new WrongChipError(`an nRF54L with part code ${formatAddress(part)}`);
  }
  return chip;
}

/**
 * Connect, unlock, halt and tell the chip apart: it is ready for its RRAM to
 * be written. Resolves to the chip found.
 */
export async function prepareNrf54l(
  target: SwdTarget,
  log: (line: string) => void
): Promise<Nrf54lChip> {
  const idr = await target.connect();
  log(`Debug port ${formatAddress(idr)} is up`);
  await checkCtrlAp(target);
  if (!(await isUnlocked(target))) await unlock(target, log);
  await resetAndHalt(target);
  const chip = await detectChip(target);
  log(`Halted the ${chip.name}`);
  await stopWatchdog(target);
  return chip;
}

/** Write ``segments`` into RRAM, read them back and start the new firmware. */
export async function writeNrf54l(
  target: SwdTarget,
  chip: Nrf54lChip,
  segments: readonly HexSegment[],
  hooks: Nrf54lFlashHooks
): Promise<void> {
  const log = hooks.onLog ?? (() => {});
  const outside = outOfRange(chip, segments);
  if (outside) throw new ImageOutOfRangeError(outside.address);

  const rramc = chip.rramcBase;
  const ready = () =>
    poll(
      () => target.read32(AHB_AP, rramc + RRAMC_READY),
      (v) => (v & 1) !== 0,
      RRAMC_READY_TIMEOUT_MS,
      "the RRAM controller"
    );
  const runs = await alignSegments(segments, (a) => target.read32(AHB_AP, a));
  const totalWords = runs.reduce((n, r) => n + r.words.length, 0) * 2;
  let doneWords = 0;
  let lastPercent = -1;
  const advance = (n: number) => {
    doneWords += n;
    const percent = Math.floor((doneWords * 100) / totalWords);
    if (percent !== lastPercent) hooks.onProgress((lastPercent = percent));
    throwIfAborted(hooks.signal);
  };

  log(`Writing ${hexImageSize(segments)} bytes`);
  await target.write32(AHB_AP, rramc + RRAMC_CONFIG, RRAMC_CONFIG_WRITE);
  try {
    await ready();
    for (const run of runs) {
      log(`Writing ${run.words.length * 4} bytes at ${formatAddress(run.address)}`);
      await target.writeBlock(AHB_AP, run.address, run.words, advance);
    }
    await target.write32(AHB_AP, rramc + RRAMC_TASKS_COMMITWRITEBUF, 1);
    await ready();
  } finally {
    await target.write32(AHB_AP, rramc + RRAMC_CONFIG, 0).catch(() => {});
  }

  log("Verifying");
  for (const run of runs) {
    const back = await target.readBlock(AHB_AP, run.address, run.words.length, advance);
    const bad = back.findIndex((w, i) => w !== run.words[i]);
    if (bad >= 0) throw new VerifyError(run.address + bad * 4);
  }
}

/** Let the core go and reset it into the new firmware. */
export async function runNrf54l(target: SwdTarget): Promise<void> {
  await target.write32(AHB_AP, DHCSR, DBGKEY);
  // The reset can cut the acknowledgement off; the chip restarts either way.
  await target.write32(AHB_AP, AIRCR, AIRCR_SYSRESETREQ).catch(() => {});
}
