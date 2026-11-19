/**
 * Arm ADIv5 over SWD through a CMSIS-DAP probe: bringing the debug port up,
 * and reading and writing target memory and access-port registers. Part of
 * the on-demand engine chunk.
 */
import { sleep } from "../../../util/sleep.js";
import { Dap, DapError, DapTransferError, REQ_AP, type TransferOp } from "./dap.js";

// DP registers, as the A[3:2] bits of a transfer request.
const DP_IDR = 0x0; // read
const DP_ABORT = 0x0; // write
const DP_CTRL_STAT = 0x4;
const DP_SELECT = 0x8;

const ABORT_CLEAR_ALL = 0x1e;
const CSYSPWRUPREQ = 1 << 30;
const CDBGPWRUPREQ = 1 << 28;
const CSYSPWRUPACK = 1 << 31;
const CDBGPWRUPACK = 1 << 29;

// MEM-AP registers.
const AP_CSW = 0x00;
const AP_TAR = 0x04;
const AP_DRW = 0x0c;
export const AP_IDR = 0xfc;

/**
 * 32-bit accesses, TAR incremented after each, as a privileged secure debug
 * master (DAPLink's value).
 */
const CSW_WORD_INC = 0x23000052;
// TAR's auto-increment is only guaranteed inside a 1 KiB block.
const TAR_WRAP = 0x400;

const SWD_CLOCK_HZ = 2_000_000;
// WAITs a transfer retries: RRAM writes stall the bus while a line commits.
const WAIT_RETRY = 0xffff;
const POWER_UP_TIMEOUT_MS = 1000;

const ONES = (n: number) => Array<number>(n).fill(0xff);

/** Line reset, the JTAG-to-SWD switch, a second line reset, then idle. */
const JTAG_TO_SWD: [bits: number, data: number[]][] = [
  [56, ONES(7)],
  [16, [0x9e, 0xe7]],
  [56, ONES(7)],
  [8, [0x00]],
];

/** Wake a dormant SWJ-DP (ADIv5.2) into SWD, for a DP that ignores the switch. */
const DORMANT_TO_SWD: [bits: number, data: number[]][] = [
  [8, [0xff]],
  [
    128,
    [
      0x92, 0xf3, 0x09, 0x62, 0x95, 0x2d, 0x85, 0x86, 0xe9, 0xaf, 0xdd, 0xe3, 0xa2, 0x0e,
      0xbc, 0x19,
    ],
  ],
  [12, [0xa0, 0x01]],
  [56, ONES(7)],
  [8, [0x00]],
];

const dpRead = (reg: number): TransferOp => ({ request: reg, read: true });
const dpWrite = (reg: number, value: number): TransferOp => ({
  request: reg,
  write: value >>> 0,
});
const apRead = (reg: number): TransferOp => ({
  request: REQ_AP | (reg & 0x0c),
  read: true,
});
const apWrite = (reg: number, value: number): TransferOp => ({
  request: REQ_AP | (reg & 0x0c),
  write: value >>> 0,
});

/** The debug port of one target behind a probe. */
export class SwdTarget {
  private select = -1;
  private cswFor = -1;

  constructor(readonly dap: Dap) {}

  /** Start SWD, find the DP, clear its errors and power the debug domain up. */
  async connect(): Promise<number> {
    await this.dap.connectSwd();
    await this.dap.setClock(SWD_CLOCK_HZ);
    await this.dap.configureTransfers(WAIT_RETRY);
    await this.dap.configureSwd();
    this.select = -1;
    this.cswFor = -1;
    let idr: number;
    try {
      idr = await this.wake(JTAG_TO_SWD);
    } catch {
      idr = await this.wake(DORMANT_TO_SWD);
    }
    await this.powerUp();
    return idr;
  }

  private async wake(sequence: [number, number[]][]): Promise<number> {
    for (const [bits, data] of sequence) await this.dap.swjSequence(bits, data);
    const [idr] = await this.dap.transfer([dpRead(DP_IDR)]);
    return idr;
  }

  private async powerUp(): Promise<void> {
    await this.dap.transfer([
      dpWrite(DP_ABORT, ABORT_CLEAR_ALL),
      dpWrite(DP_SELECT, 0),
      dpWrite(DP_CTRL_STAT, CSYSPWRUPREQ | CDBGPWRUPREQ),
    ]);
    this.select = 0;
    const deadline = Date.now() + POWER_UP_TIMEOUT_MS;
    for (;;) {
      const [stat] = await this.dap.transfer([dpRead(DP_CTRL_STAT)]);
      const acked = CSYSPWRUPACK | CDBGPWRUPACK;
      if ((stat & acked) >>> 0 === acked >>> 0) return;
      if (Date.now() > deadline) throw new DapError("The debug port did not power up");
      await sleep(10);
    }
  }

  /** Clear the sticky errors a FAULT leaves, so the next access can run. */
  async clearErrors(): Promise<void> {
    await this.dap.transfer([dpWrite(DP_ABORT, ABORT_CLEAR_ALL)]);
  }

  private selectOps(ap: number, reg: number): TransferOp[] {
    const select = ((ap << 24) | (reg & 0xf0)) >>> 0;
    if (select === this.select) return [];
    this.select = select;
    return [dpWrite(DP_SELECT, select)];
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      // SELECT and CSW may or may not have landed; write them again next time.
      this.select = -1;
      this.cswFor = -1;
      if (err instanceof DapTransferError && err.isFault) {
        await this.clearErrors().catch(() => {});
      }
      throw err;
    }
  }

  private run(ops: TransferOp[]): Promise<number[]> {
    return this.guarded(() => this.dap.transfer(ops));
  }

  async readAp(ap: number, reg: number): Promise<number> {
    const [value] = await this.run([...this.selectOps(ap, reg), apRead(reg)]);
    return value;
  }

  async writeAp(ap: number, reg: number, value: number): Promise<void> {
    await this.run([...this.selectOps(ap, reg), apWrite(reg, value)]);
  }

  private memSetup(ap: number, address: number): TransferOp[] {
    const ops = this.selectOps(ap, AP_CSW);
    if (this.cswFor !== ap) {
      ops.push(apWrite(AP_CSW, CSW_WORD_INC));
      this.cswFor = ap;
    }
    ops.push(apWrite(AP_TAR, address));
    return ops;
  }

  async read32(ap: number, address: number): Promise<number> {
    const [value] = await this.run([...this.memSetup(ap, address), apRead(AP_DRW)]);
    return value;
  }

  async write32(ap: number, address: number, value: number): Promise<void> {
    await this.run([...this.memSetup(ap, address), apWrite(AP_DRW, value)]);
  }

  /** The runs of words a block access splits into: one TAR wrap and one packet each. */
  private *runs(address: number, words: number): Generator<[number, number, number]> {
    let done = 0;
    while (done < words) {
      const at = address + done * 4;
      const toWrap = (TAR_WRAP - (at % TAR_WRAP)) / 4;
      const n = Math.min(words - done, toWrap, this.dap.blockWords);
      yield [at, done, n];
      done += n;
    }
  }

  /** Write ``words`` from word-aligned ``address`` on; ``onWords`` after each packet. */
  async writeBlock(
    ap: number,
    address: number,
    words: Uint32Array,
    onWords?: (n: number) => void
  ): Promise<void> {
    for (const [at, from, n] of this.runs(address, words.length)) {
      await this.guarded(async () => {
        await this.dap.transfer(this.memSetup(ap, at));
        await this.dap.writeBlock(REQ_AP | AP_DRW, words.subarray(from, from + n));
      });
      onWords?.(n);
    }
  }

  /** Read ``count`` words from word-aligned ``address`` on. */
  async readBlock(
    ap: number,
    address: number,
    count: number,
    onWords?: (n: number) => void
  ): Promise<Uint32Array> {
    const out = new Uint32Array(count);
    for (const [at, from, n] of this.runs(address, count)) {
      const words = await this.guarded(async () => {
        await this.dap.transfer(this.memSetup(ap, at));
        return this.dap.readBlock(REQ_AP | AP_DRW, n);
      });
      out.set(words, from);
      onWords?.(n);
    }
    return out;
  }
}
