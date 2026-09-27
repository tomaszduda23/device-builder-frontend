/**
 * The CBOR subset SMP (MCUmgr) payloads use: maps keyed by text, unsigned and
 * negative integers, byte and text strings, arrays, booleans and null.
 * Decoding also accepts indefinite lengths, which Zephyr's zcbor emits for
 * response maps, and floats, so an unexpected field cannot fail a response.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

export type CborMap = { [key: string]: CborValue };

const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;
const INDEFINITE = 31;
const BREAK = 0xff;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

// --- Encoding ---------------------------------------------------------------

export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
}

function head(out: number[], major: number, length: number): void {
  const m = major << 5;
  if (length < 24) {
    out.push(m | length);
  } else if (length < 0x100) {
    out.push(m | 24, length);
  } else if (length < 0x1_0000) {
    out.push(m | 25, length >> 8, length & 0xff);
  } else if (length < 0x1_0000_0000) {
    out.push(m | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff);
    out.push((length >>> 8) & 0xff, length & 0xff);
  } else {
    const hi = Math.floor(length / 0x1_0000_0000);
    out.push(m | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff);
    out.push(hi & 0xff, (length >>> 24) & 0xff, (length >>> 16) & 0xff);
    out.push((length >>> 8) & 0xff, length & 0xff);
  }
}

function encodeInto(out: number[], value: CborValue): void {
  if (value === null || value === undefined) {
    out.push(0xf6);
  } else if (value === false) {
    out.push(0xf4);
  } else if (value === true) {
    out.push(0xf5);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CborError(`Only safe integers are encoded, got ${value}`);
    }
    if (value >= 0) head(out, MAJOR_UINT, value);
    else head(out, MAJOR_NEGINT, -1 - value);
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    head(out, MAJOR_TEXT, bytes.length);
    for (const b of bytes) out.push(b);
  } else if (value instanceof Uint8Array) {
    head(out, MAJOR_BYTES, value.length);
    for (const b of value) out.push(b);
  } else if (Array.isArray(value)) {
    head(out, MAJOR_ARRAY, value.length);
    for (const item of value) encodeInto(out, item);
  } else {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    head(out, MAJOR_MAP, entries.length);
    for (const [k, v] of entries) {
      encodeInto(out, k);
      encodeInto(out, v);
    }
  }
}

// --- Decoding ---------------------------------------------------------------

/** Decode exactly one item; trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new Reader(bytes);
  const value = reader.item();
  if (reader.offset !== bytes.length) {
    throw new CborError(`${bytes.length - reader.offset} trailing bytes`);
  }
  return value;
}

class Reader {
  offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.length) throw new CborError("Truncated CBOR");
  }

  private u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  private peekBreak(): boolean {
    this.need(1);
    if (this.bytes[this.offset] !== BREAK) return false;
    this.offset++;
    return true;
  }

  /** The argument of a head whose additional info is ``info``. */
  private argument(info: number): number {
    if (info < 24) return info;
    let n: number;
    switch (info) {
      case 24:
        return this.u8();
      case 25:
        this.need(2);
        n = this.view.getUint16(this.offset);
        this.offset += 2;
        return n;
      case 26:
        this.need(4);
        n = this.view.getUint32(this.offset);
        this.offset += 4;
        return n;
      case 27: {
        this.need(8);
        const hi = this.view.getUint32(this.offset);
        const lo = this.view.getUint32(this.offset + 4);
        this.offset += 8;
        return hi * 0x1_0000_0000 + lo;
      }
      default:
        throw new CborError(`Bad additional info ${info}`);
    }
  }

  private raw(length: number): Uint8Array {
    this.need(length);
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** A byte or text string, definite or chunked. */
  private string(major: number, info: number): Uint8Array {
    if (info !== INDEFINITE) return this.raw(this.argument(info));
    const chunks: Uint8Array[] = [];
    while (!this.peekBreak()) {
      const initial = this.u8();
      if (initial >> 5 !== major || (initial & 0x1f) === INDEFINITE) {
        throw new CborError("Bad chunk in an indefinite-length string");
      }
      chunks.push(this.raw(this.argument(initial & 0x1f)));
    }
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  item(): CborValue {
    const initial = this.u8();
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case MAJOR_UINT:
        return this.argument(info);
      case MAJOR_NEGINT:
        return -1 - this.argument(info);
      case MAJOR_BYTES:
        return this.string(major, info);
      case MAJOR_TEXT:
        return new TextDecoder().decode(this.string(major, info));
      case MAJOR_ARRAY:
        return this.array(info);
      case MAJOR_MAP:
        return this.map(info);
      case MAJOR_TAG:
        this.argument(info);
        return this.item();
      case MAJOR_SIMPLE:
        return this.simple(info);
      default:
        throw new CborError(`Unknown major type ${major}`);
    }
  }

  private array(info: number): CborValue[] {
    const out: CborValue[] = [];
    if (info === INDEFINITE) {
      while (!this.peekBreak()) out.push(this.item());
    } else {
      for (let i = this.argument(info); i > 0; i--) out.push(this.item());
    }
    return out;
  }

  private map(info: number): CborMap {
    const out: CborMap = {};
    const entry = () => {
      const key = this.item();
      out[String(key)] = this.item();
    };
    if (info === INDEFINITE) {
      while (!this.peekBreak()) entry();
    } else {
      for (let i = this.argument(info); i > 0; i--) entry();
    }
    return out;
  }

  private simple(info: number): CborValue {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25: {
        this.need(2);
        const half = this.view.getUint16(this.offset);
        this.offset += 2;
        return decodeHalf(half);
      }
      case 26: {
        this.need(4);
        const f = this.view.getFloat32(this.offset);
        this.offset += 4;
        return f;
      }
      case 27: {
        this.need(8);
        const d = this.view.getFloat64(this.offset);
        this.offset += 8;
        return d;
      }
      default:
        if (info < 24) return info;
        if (info === 24) return this.u8();
        throw new CborError(`Unexpected simple value ${info}`);
    }
  }
}

function decodeHalf(half: number): number {
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}
