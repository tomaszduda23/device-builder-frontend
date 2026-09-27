/**
 * SMP (MCUmgr's Simple Management Protocol) over Web Bluetooth: framing,
 * fragmentation, reassembly and request / response matching by sequence
 * number. The wire format follows mcumgr-web
 * (https://github.com/boogie/mcumgr-web, MIT, Copyright (c) 2022 Andras
 * Barthazi); requests here are awaited one at a time and each resolves to its
 * own response.
 */
import { type CborMap, type CborValue, decodeCbor, encodeCbor } from "./cbor.js";
import { SMP_CHARACTERISTIC_UUID, SMP_SERVICE_UUID } from "./smp-uuids.js";

export const SMP_OP_READ = 0;
export const SMP_OP_WRITE = 2;

export const SMP_GROUP_OS = 0;
export const SMP_GROUP_IMAGE = 1;

export const OS_ID_RESET = 5;
export const OS_ID_MCUMGR_PARAMS = 6;
export const IMG_ID_STATE = 0;
export const IMG_ID_UPLOAD = 1;

export const SMP_HEADER_SIZE = 8;

/**
 * Bytes per characteristic write. ESPHome enables SMP reassembly, so a
 * packet may span several writes; each must still fit the ATT MTU, which
 * Web Bluetooth does not expose. The first size suits the MTU every current
 * desktop stack negotiates; the last is the ATT minimum every link allows.
 */
const FRAGMENT_SIZES = [244, 20] as const;

const DEFAULT_TIMEOUT_MS = 5000;

/** An SMP error response (``rc`` other than 0). */
export class SmpError extends Error {
  constructor(
    readonly rc: number,
    readonly group: number,
    readonly id: number
  ) {
    super(`SMP request ${group}/${id} failed: ${SMP_RC_NAMES[rc] ?? `error ${rc}`}`);
    this.name = "SmpError";
  }
}

export class SmpTimeoutError extends Error {
  constructor(group: number, id: number) {
    super(`SMP request ${group}/${id} timed out`);
    this.name = "SmpTimeoutError";
  }
}

export class SmpDisconnectedError extends Error {
  constructor() {
    super("The Bluetooth link dropped");
    this.name = "SmpDisconnectedError";
  }
}

// MGMT_ERR_* from Zephyr's mgmt/mcumgr/mgmt/mgmt_defines.h.
const SMP_RC_NAMES: Record<number, string> = {
  1: "unknown error",
  2: "out of memory",
  3: "invalid value",
  4: "timeout",
  5: "no such entry",
  6: "bad state",
  7: "response too large",
  8: "not supported",
  9: "corrupt payload",
  10: "busy",
  11: "access denied",
  12: "unsupported protocol version",
};

interface Pending {
  group: number;
  id: number;
  resolve: (body: CborMap) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function encodeSmpPacket(
  op: number,
  group: number,
  id: number,
  seq: number,
  body: CborMap
): Uint8Array {
  const payload = encodeCbor(body);
  const packet = new Uint8Array(SMP_HEADER_SIZE + payload.length);
  packet[0] = op;
  packet[1] = 0;
  packet[2] = payload.length >> 8;
  packet[3] = payload.length & 0xff;
  packet[4] = group >> 8;
  packet[5] = group & 0xff;
  packet[6] = seq;
  packet[7] = id;
  packet.set(payload, SMP_HEADER_SIZE);
  return packet;
}

const isMap = (value: CborValue): value is CborMap =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

/** ``rc`` of a response, in either the SMP v1 or the v2 (``err``) form. */
function responseRc(body: CborMap): number {
  if (typeof body.rc === "number") return body.rc;
  const err = body.err;
  if (err !== undefined && isMap(err) && typeof err.rc === "number") return err.rc;
  return 0;
}

export class SmpBleClient {
  private _seq = 0;
  private _fragment = 0;
  private _rx = new Uint8Array(0);
  private readonly _pending = new Map<number, Pending>();
  private _closed = false;

  private constructor(
    private readonly _device: BluetoothDevice,
    private readonly _char: BluetoothRemoteGATTCharacteristic,
    private readonly _log: (line: string) => void
  ) {
    _char.addEventListener("characteristicvaluechanged", this._onValue);
    _device.addEventListener("gattserverdisconnected", this._onDisconnected);
  }

  /** Connect to ``device``'s SMP characteristic and subscribe to responses. */
  static async connect(
    device: BluetoothDevice,
    log: (line: string) => void = () => {}
  ): Promise<SmpBleClient> {
    if (!device.gatt) throw new Error("This Bluetooth device has no GATT server");
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SMP_SERVICE_UUID);
      const char = await service.getCharacteristic(SMP_CHARACTERISTIC_UUID);
      await char.startNotifications();
      // Nothing is sent before a request, so no response can predate the listener.
      return new SmpBleClient(device, char, log);
    } catch (err) {
      device.gatt.disconnect();
      throw err;
    }
  }

  get connected(): boolean {
    return !this._closed && this._device.gatt?.connected === true;
  }

  /**
   * Send one request and resolve to its response body. Rejects with an
   * ``SmpError`` for an error response, ``SmpTimeoutError`` when nothing came
   * back in time, and ``SmpDisconnectedError`` when the link dropped.
   */
  async request(
    op: number,
    group: number,
    id: number,
    body: CborMap = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<CborMap> {
    if (!this.connected) throw new SmpDisconnectedError();
    const seq = this._seq;
    this._seq = (this._seq + 1) & 0xff;
    const packet = encodeSmpPacket(op, group, id, seq, body);
    const response = new Promise<CborMap>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        reject(new SmpTimeoutError(group, id));
      }, timeoutMs);
      this._pending.set(seq, { group, id, resolve, reject, timer });
    });
    try {
      await this._write(packet);
    } catch (err) {
      this._settle(seq)?.reject(err);
    }
    return response;
  }

  /** After a timeout, try the smallest writes: the link's MTU may be the minimum. */
  shrinkFragments(): boolean {
    if (this._fragment >= FRAGMENT_SIZES.length - 1) return false;
    this._fragment = FRAGMENT_SIZES.length - 1;
    this._log(`Falling back to ${FRAGMENT_SIZES[this._fragment]}-byte Bluetooth writes`);
    return true;
  }

  /** Disconnect and fail anything still waiting. Idempotent. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._char.removeEventListener("characteristicvaluechanged", this._onValue);
    this._device.removeEventListener("gattserverdisconnected", this._onDisconnected);
    this._failAll(new SmpDisconnectedError());
    this._device.gatt?.disconnect();
  }

  private async _write(packet: Uint8Array): Promise<void> {
    for (;;) {
      const size = FRAGMENT_SIZES[this._fragment];
      try {
        for (let at = 0; at < packet.length; at += size) {
          await this._char.writeValueWithoutResponse(packet.slice(at, at + size));
        }
        return;
      } catch (err) {
        // A write longer than the link's MTU is refused outright; resend the
        // whole packet in smaller writes (the device drops a partial one).
        if (!this.connected || !this.shrinkFragments()) throw err;
      }
    }
  }

  private _settle(seq: number): Pending | undefined {
    const pending = this._pending.get(seq);
    if (!pending) return undefined;
    this._pending.delete(seq);
    clearTimeout(pending.timer);
    return pending;
  }

  private _failAll(err: unknown): void {
    for (const seq of [...this._pending.keys()]) this._settle(seq)?.reject(err);
  }

  private readonly _onDisconnected = (): void => {
    this._failAll(new SmpDisconnectedError());
  };

  private readonly _onValue = (): void => {
    const dv = this._char.value;
    if (!dv) return;
    const chunk = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const rx = new Uint8Array(this._rx.length + chunk.length);
    rx.set(this._rx);
    rx.set(chunk, this._rx.length);
    this._rx = rx;
    while (this._rx.length >= SMP_HEADER_SIZE) {
      const total = SMP_HEADER_SIZE + ((this._rx[2] << 8) | this._rx[3]);
      if (this._rx.length < total) return;
      const packet = this._rx.slice(0, total);
      this._rx = this._rx.slice(total);
      this._dispatch(packet);
    }
  };

  private _dispatch(packet: Uint8Array): void {
    const group = (packet[4] << 8) | packet[5];
    const seq = packet[6];
    const id = packet[7];
    const pending = this._pending.get(seq);
    // A late answer to a request that already timed out.
    if (!pending || pending.group !== group || pending.id !== id) return;
    this._settle(seq);
    let body: CborMap = {};
    try {
      if (packet.length > SMP_HEADER_SIZE) {
        const decoded = decodeCbor(packet.subarray(SMP_HEADER_SIZE));
        if (isMap(decoded)) body = decoded;
      }
    } catch (err) {
      pending.reject(err);
      return;
    }
    const rc = responseRc(body);
    if (rc !== 0) pending.reject(new SmpError(rc, group, id));
    else pending.resolve(body);
  }
}
