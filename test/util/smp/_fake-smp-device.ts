import { type CborMap, decodeCbor, encodeCbor } from "../../../src/util/smp/cbor.js";
import { SMP_HEADER_SIZE } from "../../../src/util/smp/smp-client.js";

export interface SmpRequest {
  op: number;
  group: number;
  id: number;
  seq: number;
  body: CborMap;
}

/** What the fake answers a request with; ``undefined`` stays silent (a lost response). */
export type SmpHandler = (req: SmpRequest) => CborMap | undefined;

/**
 * A Web Bluetooth device serving the SMP characteristic: writes are
 * reassembled into SMP packets (as ESPHome's reassembly does), handed to
 * ``handler``, and its answer is notified back in ``notifySize`` pieces.
 */
export function fakeSmpDevice(
  handler: SmpHandler,
  opts: { notifySize?: number; maxWrite?: number; name?: string } = {}
) {
  const charListeners = new Set<() => void>();
  const deviceListeners = new Set<() => void>();
  const writes: Uint8Array[] = [];
  const requests: SmpRequest[] = [];
  let rx = new Uint8Array(0);
  let connected = false;

  const char = {
    value: null as DataView | null,
    addEventListener: (_: string, fn: () => void) => charListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => charListeners.delete(fn),
    startNotifications: async () => char,
    async writeValueWithoutResponse(chunk: Uint8Array) {
      if (opts.maxWrite !== undefined && chunk.length > opts.maxWrite) {
        throw new DOMException("Value too long", "NotSupportedError");
      }
      writes.push(chunk);
      const merged = new Uint8Array(rx.length + chunk.length);
      merged.set(rx);
      merged.set(chunk, rx.length);
      rx = merged;
      const total = SMP_HEADER_SIZE + ((rx[2] << 8) | rx[3]);
      if (rx.length < total) return;
      const packet = rx.slice(0, total);
      rx = rx.slice(total);
      const req: SmpRequest = {
        op: packet[0],
        group: (packet[4] << 8) | packet[5],
        seq: packet[6],
        id: packet[7],
        body:
          packet.length > SMP_HEADER_SIZE
            ? (decodeCbor(packet.subarray(SMP_HEADER_SIZE)) as CborMap)
            : {},
      };
      requests.push(req);
      const answer = handler(req);
      if (answer) queueMicrotask(() => respond(req, answer));
    },
  };

  function respond(req: SmpRequest, body: CborMap) {
    const payload = encodeCbor(body);
    const packet = new Uint8Array(SMP_HEADER_SIZE + payload.length);
    packet.set([req.op + 1, 0, payload.length >> 8, payload.length & 0xff]);
    packet.set([req.group >> 8, req.group & 0xff, req.seq, req.id], 4);
    packet.set(payload, SMP_HEADER_SIZE);
    const size = opts.notifySize ?? packet.length;
    for (let at = 0; at < packet.length; at += size) {
      const piece = packet.slice(at, at + size);
      char.value = new DataView(piece.buffer);
      for (const fn of charListeners) fn();
    }
  }

  const device = {
    name: opts.name ?? "node",
    addEventListener: (_: string, fn: () => void) => deviceListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => deviceListeners.delete(fn),
    gatt: {
      get connected() {
        return connected;
      },
      async connect() {
        connected = true;
        return {
          getPrimaryService: async () => ({ getCharacteristic: async () => char }),
        };
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        for (const fn of [...deviceListeners]) fn();
      },
    },
  };

  return {
    device: device as unknown as BluetoothDevice,
    char,
    writes,
    requests,
    /** The link drops, as when the device resets. */
    drop: () => device.gatt.disconnect(),
    charListenerCount: () => charListeners.size,
  };
}

/** A minimal signed-looking MCUboot image: header, body and a SHA-256 TLV. */
export async function makeMcubootImage(
  bodySize = 1000,
  version: [number, number, number, number] = [1, 2, 3, 4]
): Promise<Uint8Array> {
  const headerSize = 32;
  const out = new Uint8Array(headerSize + bodySize + 4 + 4 + 32);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x96f3b83d, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, 0, true);
  view.setUint32(12, bodySize, true);
  view.setUint8(20, version[0]);
  view.setUint8(21, version[1]);
  view.setUint16(22, version[2], true);
  view.setUint32(24, version[3], true);
  for (let i = 0; i < bodySize; i++) out[headerSize + i] = (i * 7) & 0xff;
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", out.slice(0, headerSize + bodySize))
  );
  const tlv = headerSize + bodySize;
  view.setUint16(tlv, 0x6907, true);
  view.setUint16(tlv + 2, 4 + 4 + 32, true);
  view.setUint16(tlv + 4, 0x10, true);
  view.setUint16(tlv + 6, 32, true);
  out.set(hash, tlv + 8);
  return out;
}
