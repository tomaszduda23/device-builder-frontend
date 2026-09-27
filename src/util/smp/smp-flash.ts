/**
 * Update an MCUboot device over Bluetooth with SMP, the sequence ESPHome's
 * own ``nrf52/ota.py`` runs: read the slots, upload the image into the
 * secondary slot, mark it for a test boot, and reset. The firmware confirms
 * itself once it boots; MCUboot reverts to the old image if it does not.
 * Loaded on demand (``loadSmpEngine``) to keep it out of the main chunk.
 */
import { tenthLogger } from "../flash-log.js";
import { sleep } from "../sleep.js";
import type { CborMap, CborValue } from "./cbor.js";
import { encodeCbor } from "./cbor.js";
import {
  bytesEqual,
  type McubootImage,
  parseMcubootImage,
  toHex,
} from "./mcuboot-image.js";
import {
  IMG_ID_STATE,
  IMG_ID_UPLOAD,
  OS_ID_MCUMGR_PARAMS,
  OS_ID_RESET,
  SMP_GROUP_IMAGE,
  SMP_GROUP_OS,
  SMP_HEADER_SIZE,
  SMP_OP_READ,
  SMP_OP_WRITE,
  SmpBleClient,
  SmpDisconnectedError,
  SmpTimeoutError,
} from "./smp-client.js";
import { SmpServiceNotFoundError, SmpSlotError } from "./smp-errors.js";

export { parseMcubootImage };
export type { McubootImage };

export interface SmpFlashHooks {
  /** 0-100 across the upload. */
  onProgress: (percent: number) => void;
  /** One line per step, for the install dialog's details log. */
  onLog?: (line: string) => void;
  /** Disconnects between requests; the device keeps its running image. */
  signal?: AbortSignal;
}

interface SlotState {
  slot: number;
  hash?: Uint8Array;
  version?: string;
  active: boolean;
  confirmed: boolean;
  pending: boolean;
}

const CONNECT_ATTEMPTS = 3;
const UPLOAD_ATTEMPTS = 4;
// When the device does not report its buffer size (MCUMGR_GRP_OS_MCUMGR_PARAMS
// off): Zephyr's default CONFIG_MCUMGR_TRANSPORT_NETBUF_SIZE.
const DEFAULT_SMP_BUFFER = 384;
// The first chunk also opens the slot for writing; give it longer.
const FIRST_CHUNK_TIMEOUT_MS = 15_000;
const CHUNK_TIMEOUT_MS = 5_000;
// Let the test-mark response and the log line land before the link drops.
const RESET_DELAY_MS = 500;

class AbortedError extends Error {
  constructor() {
    super("Update aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError();
}

const num = (v: CborValue): number | undefined => (typeof v === "number" ? v : undefined);

function parseSlots(body: CborMap): SlotState[] {
  const images = Array.isArray(body.images) ? body.images : [];
  return images.flatMap((raw): SlotState[] => {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      raw instanceof Uint8Array
    )
      return [];
    return [
      {
        slot: num(raw.slot) ?? 0,
        hash: raw.hash instanceof Uint8Array ? raw.hash : undefined,
        version: typeof raw.version === "string" ? raw.version : undefined,
        active: raw.active === true,
        confirmed: raw.confirmed === true,
        pending: raw.pending === true,
      },
    ];
  });
}

/** Whether the image is already in the secondary slot; throws when the slots rule it out. */
function checkSlots(slots: SlotState[], image: McubootImage): boolean {
  let uploaded = false;
  for (const s of slots) {
    if (s.active && !s.confirmed) throw new SmpSlotError("test-pending");
    if (!s.hash || !bytesEqual(s.hash, image.hash)) continue;
    if (s.active) throw new SmpSlotError("already-running");
    uploaded = true;
  }
  return uploaded;
}

/** Image bytes per upload request so the packet fits the device's SMP buffer. */
export function uploadChunkSize(bufferSize: number, image: McubootImage): number {
  // The first request is the largest non-data part: it adds len and sha.
  const overhead = encodeCbor({
    image: 0,
    off: image.bytes.length,
    len: image.bytes.length,
    sha: new Uint8Array(32),
    data: new Uint8Array(0),
  }).length;
  // The data head grows from 1 to up to 3 bytes once it carries data.
  return Math.max(32, bufferSize - SMP_HEADER_SIZE - overhead - 2);
}

async function connectWithRetry(
  device: BluetoothDevice,
  log: (line: string) => void,
  signal: AbortSignal | undefined
): Promise<SmpBleClient> {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      log(`Connecting to ${device.name ?? "the device"} over Bluetooth`);
      return await SmpBleClient.connect(device, log);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        throw new SmpServiceNotFoundError();
      }
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      log(`Connect attempt ${attempt} of ${CONNECT_ATTEMPTS} failed: ${String(err)}`);
      await sleep(1000);
    }
  }
}

async function smpBufferSize(
  client: SmpBleClient,
  log: (line: string) => void
): Promise<number> {
  try {
    const params = await client.request(SMP_OP_READ, SMP_GROUP_OS, OS_ID_MCUMGR_PARAMS);
    const size = num(params.buf_size);
    if (size) {
      log(`Device SMP buffer: ${size} bytes`);
      return size;
    }
  } catch (err) {
    if (err instanceof SmpDisconnectedError) throw err;
  }
  return DEFAULT_SMP_BUFFER;
}

async function upload(
  client: SmpBleClient,
  image: McubootImage,
  chunkSize: number,
  hooks: SmpFlashHooks,
  log: (line: string) => void
): Promise<void> {
  const bytes = image.bytes;
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  const logTenth = tenthLogger(log, "Uploaded");
  let offset = 0;
  let failures = 0;
  log(`Uploading ${bytes.length} bytes in ${chunkSize}-byte chunks`);
  while (offset < bytes.length) {
    throwIfAborted(hooks.signal);
    const body: CborMap = {
      off: offset,
      data: bytes.subarray(offset, offset + chunkSize),
    };
    if (offset === 0) {
      body.image = 0;
      body.len = bytes.length;
      body.sha = sha;
    }
    let response: CborMap;
    try {
      response = await client.request(
        SMP_OP_WRITE,
        SMP_GROUP_IMAGE,
        IMG_ID_UPLOAD,
        body,
        offset === 0 ? FIRST_CHUNK_TIMEOUT_MS : CHUNK_TIMEOUT_MS
      );
    } catch (err) {
      // A lost write or response; the device answers a resend with the offset
      // it actually wants, so resending is safe.
      if (!(err instanceof SmpTimeoutError) || ++failures >= UPLOAD_ATTEMPTS) throw err;
      log(
        `No answer at offset ${offset}; resending (${failures} of ${UPLOAD_ATTEMPTS - 1})`
      );
      client.shrinkFragments();
      continue;
    }
    failures = 0;
    const next = num(response.off);
    if (next === undefined) throw new Error("The device's upload answer had no offset");
    offset = next;
    const percent = Math.min(100, Math.floor((offset / bytes.length) * 100));
    hooks.onProgress(percent);
    logTenth(percent);
  }
}

/**
 * Run the whole update against a device the user picked in the chooser.
 * Resolves once the device accepted the reset into its new image.
 */
export async function flashMcubootOverBle(
  device: BluetoothDevice,
  image: McubootImage,
  hooks: SmpFlashHooks
): Promise<void> {
  const log = hooks.onLog ?? (() => {});
  const client = await connectWithRetry(device, log, hooks.signal);
  const onAbort = () => client.close();
  hooks.signal?.addEventListener("abort", onAbort);
  try {
    log(`Image ${image.version}, hash ${toHex(image.hash)}`);
    const state = await client.request(SMP_OP_READ, SMP_GROUP_IMAGE, IMG_ID_STATE);
    const slots = parseSlots(state);
    for (const s of slots) {
      log(
        `Slot ${s.slot}: ${s.version ?? "?"}${s.active ? " active" : ""}` +
          `${s.confirmed ? " confirmed" : ""}${s.pending ? " pending" : ""}`
      );
    }
    const uploaded = checkSlots(slots, image);
    throwIfAborted(hooks.signal);
    if (uploaded) {
      log("The image is already in the update slot; skipping the upload");
      hooks.onProgress(100);
    } else {
      const buffer = await smpBufferSize(client, log);
      await upload(client, image, uploadChunkSize(buffer, image), hooks, log);
    }
    throwIfAborted(hooks.signal);
    log("Marking the new image for a test boot");
    await client.request(SMP_OP_WRITE, SMP_GROUP_IMAGE, IMG_ID_STATE, {
      hash: image.hash,
      confirm: false,
    });
    await sleep(RESET_DELAY_MS);
    throwIfAborted(hooks.signal);
    log("Resetting the device");
    try {
      await client.request(SMP_OP_WRITE, SMP_GROUP_OS, OS_ID_RESET);
    } catch (err) {
      // The device may drop the link before its answer goes out.
      if (!(err instanceof SmpDisconnectedError || err instanceof SmpTimeoutError)) {
        throw err;
      }
    }
    log("The device is restarting into the new firmware");
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
    client.close();
  }
}
