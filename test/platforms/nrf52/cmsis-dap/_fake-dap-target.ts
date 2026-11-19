/**
 * A CMSIS-DAP probe wired to a simulated nRF54LM20A: enough of the debug
 * port, the AHB-AP, the CTRL-AP, the core's debug registers and the RRAM
 * controller to run the engine against.
 */
import type { DapTransport } from "../../../../src/platforms/nrf52/cmsis-dap/dap.js";

const ACK_OK = 1;
const ACK_FAULT = 4;
const RRAMC = 0x5004e000;
const RRAM_SIZE = 0x1fd000;
const DHCSR = 0xe000edf0;
const AIRCR = 0xe000ed0c;

const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const putU32 = (out: number[], v: number) =>
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

class Fault extends Error {}

export class FakeDapTarget implements DapTransport {
  /** Words of target memory. */
  readonly mem = new Map<number, number>();
  locked = false;
  halted = false;
  part = 0x054bc20a;
  ctrlApIdr = 0x32880000;
  packetSize = 64;
  /** Fail the nth RRAM write (1-based), as a lost device would. */
  failRramWriteAt = 0;
  readonly log: string[] = [];
  closed = false;
  resets = 0;
  erased = false;

  private select = 0;
  private tar = 0;
  private csw = 0;
  private rramWrites = 0;
  private rramConfig = 0;
  private uncommitted = 0;

  async exchange(cmd: Uint8Array): Promise<Uint8Array> {
    const out: number[] = [cmd[0]];
    switch (cmd[0]) {
      case 0x00: // DAP_Info
        out.push(2, this.packetSize & 0xff, this.packetSize >> 8);
        break;
      case 0x02: // DAP_Connect
        out.push(cmd[1]);
        break;
      case 0x05:
        this.transfer(cmd, out);
        break;
      case 0x06:
        this.transferBlock(cmd, out);
        break;
      default: // Disconnect, TransferConfigure, SWJ_Clock, SWJ_Sequence, SWD_Configure
        out.push(0);
    }
    return new Uint8Array(out);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private transfer(cmd: Uint8Array, out: number[]): void {
    const count = cmd[2];
    let at = 3;
    const reads: number[] = [];
    let done = 0;
    let ack = ACK_OK;
    for (let i = 0; i < count; i++) {
      const req = cmd[at++];
      let value = 0;
      if (!(req & 2)) {
        value = u32(cmd, at);
        at += 4;
      }
      try {
        const result = this.access(req, value);
        if (req & 2) reads.push(result);
        done++;
      } catch (err) {
        if (!(err instanceof Fault)) throw err;
        ack = ACK_FAULT;
        break;
      }
    }
    out.push(done, ack);
    for (const r of reads) putU32(out, r);
  }

  private transferBlock(cmd: Uint8Array, out: number[]): void {
    const count = cmd[2] | (cmd[3] << 8);
    const req = cmd[4];
    const reads: number[] = [];
    let done = 0;
    let ack = ACK_OK;
    for (let i = 0; i < count; i++) {
      try {
        if (req & 2) reads.push(this.access(req, 0));
        else this.access(req, u32(cmd, 5 + i * 4));
        done++;
      } catch (err) {
        if (!(err instanceof Fault)) throw err;
        ack = ACK_FAULT;
        break;
      }
    }
    out.push(done & 0xff, done >> 8, ack);
    for (const r of reads) putU32(out, r);
  }

  private access(req: number, value: number): number {
    const read = (req & 2) !== 0;
    const reg = req & 0x0c;
    if (!(req & 1)) {
      // DP
      if (reg === 0x0) return read ? 0x6ba02477 : 0;
      if (reg === 0x4) return read ? 0xf0000000 : 0;
      if (reg === 0x8 && !read) this.select = value;
      return 0;
    }
    const ap = this.select >>> 24;
    const addr = (this.select & 0xf0) | reg;
    if (ap === 2) return this.ctrlAp(addr, read, value);
    if (ap !== 0) throw new Fault();
    switch (addr) {
      case 0x00:
        if (!read) this.csw = value;
        return (this.csw & ~0x40) | (this.locked ? 0 : 0x40);
      case 0x04:
        if (!read) this.tar = value >>> 0;
        return this.tar;
      case 0x0c: {
        if (this.locked) throw new Fault();
        const address = this.tar;
        this.tar = (this.tar + 4) >>> 0;
        return read ? this.read(address) : (this.write(address, value), 0);
      }
      default:
        return 0;
    }
  }

  private ctrlAp(addr: number, read: boolean, value: number): number {
    switch (addr) {
      case 0xfc:
        return this.ctrlApIdr;
      case 0x04: // ERASEALL
        if (!read && value === 1) {
          this.mem.clear();
          this.erased = true;
          this.locked = false;
        }
        return 0;
      case 0x08: // ERASEALLSTATUS
        return this.erased ? 1 : 0;
      case 0x00:
        if (!read && value === 2) this.resets++;
        return 0;
      default:
        return 0;
    }
  }

  private read(address: number): number {
    if (address === DHCSR) return this.halted ? 1 << 17 : 0;
    if (address === RRAMC + 0x400) return 1;
    if (address === 0x00ffc31c) return this.part;
    return this.mem.get(address) ?? 0xffffffff;
  }

  private write(address: number, value: number): void {
    if (address === DHCSR) {
      this.halted = (value & 3) === 3;
      this.log.push(this.halted ? "halt" : "run");
      return;
    }
    if (address === AIRCR) {
      this.log.push("reset");
      return;
    }
    if (address === RRAMC + 0x500) {
      if (value === 0 && this.uncommitted > 0)
        throw new Error("write buffer not committed");
      this.rramConfig = value;
      return;
    }
    if (address === RRAMC + 0x008) {
      this.uncommitted = 0;
      this.log.push("commit");
      return;
    }
    if (address === 0x50109004) {
      this.log.push("wdt-stop");
      return;
    }
    if (address < RRAM_SIZE) {
      // Unbuffered writes fault on this chip, as do writes left disabled.
      if (this.rramConfig !== 0x2001 || !this.halted) throw new Fault();
      if (++this.rramWrites === this.failRramWriteAt) throw new Fault();
      this.uncommitted++;
    }
    this.mem.set(address, value >>> 0);
  }

  /** ``length`` bytes from ``address``, as written. */
  bytes(address: number, length: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < length; i++) {
      const word = this.mem.get((address + i) & ~3) ?? 0xffffffff;
      out.push((word >>> (((address + i) & 3) * 8)) & 0xff);
    }
    return out;
  }
}
