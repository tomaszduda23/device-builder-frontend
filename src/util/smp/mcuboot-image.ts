/**
 * MCUboot image parsing: the header, and the TLV trailer's SHA-256, which is
 * the hash SMP's image-state commands name an image by. Adapted from
 * mcumgr-web's ``imageInfo`` (https://github.com/boogie/mcumgr-web,
 * MIT, Copyright (c) 2022 Andras Barthazi).
 */

const IMAGE_MAGIC = 0x96f3b83d;
const TLV_INFO_MAGIC = 0x6907;
const TLV_PROT_INFO_MAGIC = 0x6908;
const HEADER_MIN_SIZE = 32;
const TLV_SHA256 = 0x10;

export interface McubootImage {
  /** The whole file, as uploaded. */
  bytes: Uint8Array;
  /** ``major.minor.revision+build``. */
  version: string;
  /** SHA-256 over header, body and protected TLVs; the slot's image hash. */
  hash: Uint8Array;
}

export class McubootImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McubootImageError";
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // A copy so the digest never sees a view into a larger shared buffer.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice()));
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The TLVs of the area starting at ``offset`` with ``magic``, and where it ends. */
function readTlvArea(
  view: DataView,
  offset: number,
  magic: number
): { end: number; tlvs: Map<number, Uint8Array> } {
  if (offset + 4 > view.byteLength || view.getUint16(offset, true) !== magic) {
    throw new McubootImageError(
      `Missing TLV area (magic 0x${magic.toString(16)}) at 0x${offset.toString(16)}`
    );
  }
  const end = offset + view.getUint16(offset + 2, true);
  if (end > view.byteLength) throw new McubootImageError("TLV area runs past the file");
  const tlvs = new Map<number, Uint8Array>();
  let at = offset + 4;
  while (at + 4 <= end) {
    const tag = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    at += 4;
    if (at + len > end) throw new McubootImageError("TLV entry runs past its area");
    tlvs.set(tag, new Uint8Array(view.buffer, view.byteOffset + at, len).slice());
    at += len;
  }
  return { end, tlvs };
}

/**
 * Parse and check a signed MCUboot image (``app_update.bin``). Throws a
 * ``McubootImageError`` for anything MCUboot would refuse to boot, so a bad
 * build fails before the device's slot is erased.
 */
export async function parseMcubootImage(bytes: Uint8Array): Promise<McubootImage> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < HEADER_MIN_SIZE) throw new McubootImageError("File too short");
  if (view.getUint32(0, true) !== IMAGE_MAGIC) {
    throw new McubootImageError("Wrong magic bytes; not an MCUboot image");
  }
  const headerSize = view.getUint16(8, true);
  const protectedTlvSize = view.getUint16(10, true);
  const imageSize = view.getUint32(12, true);
  const bodyEnd = headerSize + imageSize;
  if (bodyEnd + protectedTlvSize > view.byteLength) {
    throw new McubootImageError("Image size runs past the file");
  }
  const version =
    `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}` +
    `+${view.getUint32(24, true)}`;

  let offset = bodyEnd;
  if (protectedTlvSize > 0) {
    offset = readTlvArea(view, offset, TLV_PROT_INFO_MAGIC).end;
  }
  const hash = await sha256(bytes.subarray(0, bodyEnd + protectedTlvSize));
  const { tlvs } = readTlvArea(view, offset, TLV_INFO_MAGIC);
  const stored = tlvs.get(TLV_SHA256);
  if (!stored) throw new McubootImageError("The image carries no SHA-256 TLV");
  if (!bytesEqual(stored, hash)) {
    throw new McubootImageError("The image's SHA-256 does not match its contents");
  }
  return { bytes, version, hash };
}
