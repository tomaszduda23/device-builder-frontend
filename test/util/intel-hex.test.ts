import { describe, expect, it } from "vitest";

import { hexImageSize, IntelHexError, parseIntelHex } from "../../src/util/intel-hex.js";

/** One record with its checksum. */
function rec(type: number, address: number, data: number[]): string {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const sum = (0x100 - (bytes.reduce((s, b) => s + b, 0) & 0xff)) & 0xff;
  return `:${[...bytes, sum].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

const EOF_REC = ":00000001FF";

describe("parseIntelHex", () => {
  it("joins adjacent records into one segment at the extended linear address", () => {
    const text = [
      rec(4, 0, [0x00, 0x01]),
      rec(0, 0x0000, [1, 2, 3, 4]),
      rec(0, 0x0004, [5, 6]),
      rec(5, 0, [0, 0, 0, 0]),
      EOF_REC,
    ].join("\r\n");
    const segments = parseIntelHex(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].address).toBe(0x10000);
    expect([...segments[0].data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps gaps as separate segments, sorted, and honours segment addresses", () => {
    const text = [
      rec(0, 0x0100, [9]),
      rec(2, 0, [0x10, 0x00]),
      rec(0, 0x0000, [7, 8]),
      EOF_REC,
    ].join("\n");
    const segments = parseIntelHex(text);
    expect(segments.map((s) => s.address)).toEqual([0x100, 0x10000]);
    expect(hexImageSize(segments)).toBe(3);
  });

  it("merges several files, such as MCUboot and the signed app", () => {
    const mcuboot = [rec(0, 0x0000, [1, 2]), EOF_REC].join("\n");
    const app = [rec(0, 0x8000, [3, 4]), EOF_REC].join("\n");
    const segments = parseIntelHex(mcuboot, app);
    expect(segments.map((s) => [s.address, [...s.data]])).toEqual([
      [0x0000, [1, 2]],
      [0x8000, [3, 4]],
    ]);
  });

  it("accepts overlap that agrees and refuses overlap that does not", () => {
    const a = [rec(0, 0x10, [1, 2, 3]), EOF_REC].join("\n");
    expect(parseIntelHex(a, a)).toHaveLength(1);
    const b = [rec(0, 0x11, [9]), EOF_REC].join("\n");
    expect(() => parseIntelHex(a, b)).toThrow(/different data at 0x11/);
  });

  it.each([
    ["a bad checksum", ":0100000001FF\n:00000001FF"],
    ["a non-record line", "hello\n:00000001FF"],
    ["a missing end-of-file record", rec(0, 0, [1])],
    ["no data", EOF_REC],
    ["a wrong length", ":0200000001FD\n:00000001FF"],
    ["a record after the end", `${EOF_REC}\n${rec(0, 0, [1])}`],
    ["an unknown record type", `${rec(7, 0, [])}\n${EOF_REC}`],
  ])("refuses %s", (_what, text) => {
    expect(() => parseIntelHex(text)).toThrow(IntelHexError);
  });
});
