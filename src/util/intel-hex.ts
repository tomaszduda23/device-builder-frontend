/**
 * Intel HEX, the image format debug probes write: records of bytes at
 * absolute addresses. Parsed into contiguous segments, sorted by address.
 */

/** A run of bytes to write at ``address``. */
export interface HexSegment {
  address: number;
  data: Uint8Array<ArrayBuffer>;
}

export class IntelHexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelHexError";
  }
}

const REC_DATA = 0x00;
const REC_EOF = 0x01;
const REC_EXT_SEGMENT = 0x02;
const REC_START_SEGMENT = 0x03;
const REC_EXT_LINEAR = 0x04;
const REC_START_LINEAR = 0x05;

interface Chunk {
  address: number;
  data: Uint8Array;
}

function parseRecord(line: string, lineNo: number): Uint8Array {
  if (!/^:([0-9a-fA-F]{2})+$/.test(line)) {
    throw new IntelHexError(`Line ${lineNo} is not an Intel HEX record`);
  }
  const bytes = new Uint8Array((line.length - 1) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(line.slice(1 + i * 2, 3 + i * 2), 16);
  }
  if (bytes.length < 5 || bytes.length !== bytes[0] + 5) {
    throw new IntelHexError(`Line ${lineNo} has the wrong length`);
  }
  const sum = bytes.reduce((s, b) => s + b, 0);
  if ((sum & 0xff) !== 0) {
    throw new IntelHexError(`Line ${lineNo} fails its checksum`);
  }
  return bytes;
}

function readChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let base = 0;
  let ended = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (ended) throw new IntelHexError(`Line ${i + 1} follows the end-of-file record`);
    const rec = parseRecord(line, i + 1);
    const length = rec[0];
    const offset = (rec[1] << 8) | rec[2];
    const payload = rec.subarray(4, 4 + length);
    switch (rec[3]) {
      case REC_DATA:
        if (length > 0) chunks.push({ address: base + offset, data: payload });
        break;
      case REC_EOF:
        ended = true;
        break;
      case REC_EXT_SEGMENT:
        base = ((payload[0] << 8) | payload[1]) * 16;
        break;
      case REC_EXT_LINEAR:
        base = ((payload[0] << 24) | (payload[1] << 16)) >>> 0;
        break;
      case REC_START_SEGMENT:
      case REC_START_LINEAR:
        // The entry point; the core takes it from the vector table instead.
        break;
      default:
        throw new IntelHexError(`Line ${i + 1} has unknown record type ${rec[3]}`);
    }
  }
  if (!ended) throw new IntelHexError("The file has no end-of-file record");
  return chunks;
}

function sameBytes(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number, n: number) {
  for (let i = 0; i < n; i++) if (a[aOff + i] !== b[bOff + i]) return false;
  return true;
}

/**
 * Coalesce chunks into sorted, non-overlapping segments. Overlapping bytes
 * that agree are fine (one file listed twice); bytes that disagree are two
 * images for the same place, which is refused.
 */
function coalesce(chunks: Chunk[]): HexSegment[] {
  const sorted = [...chunks].sort((a, b) => a.address - b.address);
  const runs: Chunk[][] = [];
  let runEnd = -1;
  for (const chunk of sorted) {
    const run = runs[runs.length - 1];
    if (run && chunk.address <= runEnd) {
      run.push(chunk);
      runEnd = Math.max(runEnd, chunk.address + chunk.data.length);
    } else {
      runs.push([chunk]);
      runEnd = chunk.address + chunk.data.length;
    }
  }
  return runs.map((run) => {
    const start = run[0].address;
    const end = Math.max(...run.map((c) => c.address + c.data.length));
    const data = new Uint8Array(end - start);
    let filled = 0;
    for (const chunk of run) {
      const at = chunk.address - start;
      const overlap = Math.min(filled, at + chunk.data.length) - at;
      if (overlap > 0 && !sameBytes(data, at, chunk.data, 0, overlap)) {
        throw new IntelHexError(
          `Two images write different data at 0x${chunk.address.toString(16).toUpperCase()}`
        );
      }
      data.set(chunk.data, at);
      filled = Math.max(filled, at + chunk.data.length);
    }
    return { address: start, data };
  });
}

/** Parse one or more Intel HEX files into one image; throws ``IntelHexError``. */
export function parseIntelHex(...texts: string[]): HexSegment[] {
  const segments = coalesce(texts.flatMap(readChunks));
  if (segments.length === 0) throw new IntelHexError("The file has no data");
  return segments;
}

/** Bytes in an image. */
export const hexImageSize = (segments: readonly HexSegment[]): number =>
  segments.reduce((n, s) => n + s.data.length, 0);
