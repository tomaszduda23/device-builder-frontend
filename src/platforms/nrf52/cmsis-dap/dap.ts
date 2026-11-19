/**
 * CMSIS-DAP commands (Arm's debug-probe protocol, v2 over USB bulk) and the
 * SWD transfers they carry. One command is in flight at a time; the probe
 * answers each with one packet. Part of the on-demand engine chunk.
 */

const CMD_INFO = 0x00;
const CMD_CONNECT = 0x02;
const CMD_DISCONNECT = 0x03;
const CMD_TRANSFER_CONFIGURE = 0x04;
const CMD_TRANSFER = 0x05;
const CMD_TRANSFER_BLOCK = 0x06;
const CMD_SWJ_CLOCK = 0x11;
const CMD_SWJ_SEQUENCE = 0x12;
const CMD_SWD_CONFIGURE = 0x13;

const INFO_PACKET_SIZE = 0xff;
const CONNECT_SWD = 1;
const DAP_OK = 0x00;

/** ``transfer request`` bits: AP (not DP), read (not write), and A[3:2]. */
export const REQ_AP = 0x01;
export const REQ_READ = 0x02;

const ACK_OK = 1;
const ACK_WAIT = 2;
const ACK_FAULT = 4;
const ACK_MASK = 0x07;
const PROTOCOL_ERROR = 0x08;

/** Moves one command packet to the probe and its response back. */
export interface DapTransport {
  exchange(command: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class DapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DapError";
  }
}

/** A transfer the target refused: WAIT that never ended, FAULT, or no answer. */
export class DapTransferError extends DapError {
  constructor(readonly ack: number) {
    super(`SWD transfer failed: ${ackName(ack)}`);
    this.name = "DapTransferError";
  }

  /** FAULT: the access reached the target and it said no (sticky error set). */
  get isFault(): boolean {
    return (this.ack & ACK_MASK) === ACK_FAULT;
  }
}

function ackName(ack: number): string {
  if (ack & PROTOCOL_ERROR) return "SWD protocol error";
  switch (ack & ACK_MASK) {
    case ACK_WAIT:
      return "WAIT";
    case ACK_FAULT:
      return "FAULT";
    case 7:
      return "no response from the target";
    default:
      return `ACK ${ack & ACK_MASK}`;
  }
}

/** One DP or AP register access inside a ``DAP_Transfer``. */
export type TransferOp =
  { request: number; write: number } | { request: number; read: true };

const putU32 = (buf: Uint8Array, at: number, v: number): void => {
  buf[at] = v & 0xff;
  buf[at + 1] = (v >>> 8) & 0xff;
  buf[at + 2] = (v >>> 16) & 0xff;
  buf[at + 3] = (v >>> 24) & 0xff;
};

const getU32 = (buf: Uint8Array, at: number): number =>
  (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;

/** The CMSIS-DAP command set on top of a transport. */
export class Dap {
  /** The probe's packet size, from ``DAP_Info``; 64 until asked. */
  packetSize = 64;

  constructor(private readonly transport: DapTransport) {}

  private async command(bytes: number[] | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const packet = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const response = await this.transport.exchange(packet);
    if (response[0] !== packet[0]) {
      throw new DapError(
        `The probe answered command 0x${packet[0].toString(16)} with 0x${(response[0] ?? 0).toString(16)}`
      );
    }
    return response;
  }

  private async commandOk(bytes: number[], what: string): Promise<void> {
    const response = await this.command(bytes);
    if (response[1] !== DAP_OK) throw new DapError(`The probe refused ${what}`);
  }

  /** Ask the probe for its packet size and use it from then on. */
  async readPacketSize(): Promise<number> {
    const response = await this.command([CMD_INFO, INFO_PACKET_SIZE]);
    if (response[1] === 2) {
      const size = response[2] | (response[3] << 8);
      if (size >= 16) this.packetSize = size;
    }
    return this.packetSize;
  }

  async connectSwd(): Promise<void> {
    const response = await this.command([CMD_CONNECT, CONNECT_SWD]);
    if (response[1] !== CONNECT_SWD) throw new DapError("The probe could not start SWD");
  }

  async disconnect(): Promise<void> {
    await this.command([CMD_DISCONNECT]);
  }

  async setClock(hz: number): Promise<void> {
    const packet = new Uint8Array(5);
    packet[0] = CMD_SWJ_CLOCK;
    putU32(packet, 1, hz);
    const response = await this.command(packet);
    if (response[1] !== DAP_OK) throw new DapError("The probe refused the SWD clock");
  }

  /** Idle cycles after a transfer, and how often a WAIT is retried. */
  async configureTransfers(waitRetry: number): Promise<void> {
    await this.commandOk(
      [CMD_TRANSFER_CONFIGURE, 0, waitRetry & 0xff, waitRetry >> 8, 0, 0],
      "the transfer settings"
    );
  }

  async configureSwd(): Promise<void> {
    await this.commandOk([CMD_SWD_CONFIGURE, 0], "the SWD settings");
  }

  /** Clock ``bits`` bits of ``data`` (LSB first) out on SWDIO. */
  async swjSequence(bits: number, data: readonly number[]): Promise<void> {
    await this.commandOk(
      [CMD_SWJ_SEQUENCE, bits === 256 ? 0 : bits, ...data],
      "an SWJ sequence"
    );
  }

  /** Run ``ops`` in one ``DAP_Transfer``; resolves to the words read, in order. */
  async transfer(ops: readonly TransferOp[]): Promise<number[]> {
    const packet = new Uint8Array(3 + ops.length * 5);
    packet[0] = CMD_TRANSFER;
    packet[2] = ops.length;
    let at = 3;
    for (const op of ops) {
      packet[at++] = op.request | ("read" in op ? REQ_READ : 0);
      if ("write" in op) {
        putU32(packet, at, op.write);
        at += 4;
      }
    }
    const response = await this.command(packet.slice(0, at));
    const done = response[1];
    const ack = response[2];
    if (done !== ops.length || ack !== ACK_OK) throw new DapTransferError(ack);
    const reads = ops.filter((op) => "read" in op).length;
    return Array.from({ length: reads }, (_, i) => getU32(response, 3 + i * 4));
  }

  /** Words one ``DAP_TransferBlock`` carries in one packet. */
  get blockWords(): number {
    return Math.floor((this.packetSize - 5) / 4);
  }

  /** Write ``words`` to one register, in one ``DAP_TransferBlock``. */
  async writeBlock(request: number, words: Uint32Array): Promise<void> {
    const packet = new Uint8Array(5 + words.length * 4);
    packet[0] = CMD_TRANSFER_BLOCK;
    packet[2] = words.length & 0xff;
    packet[3] = words.length >> 8;
    packet[4] = request;
    words.forEach((w, i) => putU32(packet, 5 + i * 4, w));
    const response = await this.command(packet);
    const done = response[1] | (response[2] << 8);
    if (done !== words.length || response[3] !== ACK_OK) {
      throw new DapTransferError(response[3]);
    }
  }

  /** Read ``count`` words from one register, in one ``DAP_TransferBlock``. */
  async readBlock(request: number, count: number): Promise<Uint32Array> {
    const response = await this.command([
      CMD_TRANSFER_BLOCK,
      0,
      count & 0xff,
      count >> 8,
      request | REQ_READ,
    ]);
    const done = response[1] | (response[2] << 8);
    if (done !== count || response[3] !== ACK_OK) throw new DapTransferError(response[3]);
    return Uint32Array.from({ length: count }, (_, i) => getU32(response, 4 + i * 4));
  }
}

interface BulkEndpoints {
  iface: number;
  epOut: number;
  epIn: number;
}

/**
 * The CMSIS-DAP v2 interface: vendor class with a bulk pair (a third, SWO,
 * endpoint may follow). One named "CMSIS-DAP" wins over another vendor one.
 */
export function findDapInterface(device: USBDevice): BulkEndpoints | null {
  const found: (BulkEndpoints & { named: boolean })[] = [];
  for (const iface of device.configuration?.interfaces ?? []) {
    const alt = iface.alternates[0];
    if (!alt || alt.interfaceClass !== 0xff) continue;
    const out = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
    const inp = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
    if (!out || !inp) continue;
    found.push({
      iface: iface.interfaceNumber,
      epOut: out.endpointNumber,
      epIn: inp.endpointNumber,
      named: /CMSIS-DAP/i.test(alt.interfaceName ?? ""),
    });
  }
  const pick = found.find((f) => f.named) ?? found[0];
  return pick ? { iface: pick.iface, epOut: pick.epOut, epIn: pick.epIn } : null;
}

/** The probe has no CMSIS-DAP v2 interface (an HID-only probe). */
export class NoDapInterfaceError extends DapError {
  constructor() {
    super("This probe has no CMSIS-DAP v2 (bulk) interface");
    this.name = "NoDapInterfaceError";
  }
}

// Large enough for any probe's packet; the read ends at the short packet.
const READ_LENGTH = 1024;

/** CMSIS-DAP v2: a command is one bulk OUT transfer, its response one bulk IN. */
export class UsbDapTransport implements DapTransport {
  private constructor(
    private readonly device: USBDevice,
    private readonly ep: BulkEndpoints
  ) {}

  static async open(device: USBDevice): Promise<UsbDapTransport> {
    await device.open();
    try {
      if (device.configuration === null) await device.selectConfiguration(1);
      const ep = findDapInterface(device);
      if (!ep) throw new NoDapInterfaceError();
      await device.claimInterface(ep.iface);
      return new UsbDapTransport(device, ep);
    } catch (err) {
      await device.close().catch(() => {});
      throw err;
    }
  }

  async exchange(command: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const out = await this.device.transferOut(this.ep.epOut, command);
    if (out.status !== "ok") throw new DapError(`USB write ${out.status}`);
    const res = await this.device.transferIn(this.ep.epIn, READ_LENGTH);
    if (res.status !== "ok" || !res.data) throw new DapError(`USB read ${res.status}`);
    return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  }

  async close(): Promise<void> {
    await this.device.releaseInterface(this.ep.iface).catch(() => {});
    await this.device.close();
  }
}
