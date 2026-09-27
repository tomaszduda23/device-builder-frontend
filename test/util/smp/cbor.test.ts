import { describe, expect, it } from "vitest";

import { CborError, decodeCbor, encodeCbor } from "../../../src/util/smp/cbor.js";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("encodeCbor", () => {
  it.each([
    [0, "00"],
    [23, "17"],
    [24, "1818"],
    [1000, "1903e8"],
    [1_000_000, "1a000f4240"],
    [2 ** 32, "1b0000000100000000"],
    [-1, "20"],
    [-1000, "3903e7"],
    [true, "f5"],
    [false, "f4"],
    [null, "f6"],
    ["off", "636f6666"],
  ])("encodes %s like RFC 8949", (value, expected) => {
    expect(encodeCbor(value)).toEqual(hex(expected));
  });

  it("encodes the SMP upload map and skips undefined fields", () => {
    const bytes = encodeCbor({
      off: 0,
      data: new Uint8Array([1, 2]),
      len: undefined,
    });
    expect(bytes).toEqual(hex("a2636f666600646461746142" + "0102"));
  });

  it("refuses a non-integer number", () => {
    expect(() => encodeCbor(1.5)).toThrow(CborError);
  });
});

describe("decodeCbor", () => {
  it("round-trips what it encodes", () => {
    const value = {
      images: [{ slot: 0, hash: new Uint8Array([9, 8]), active: true, version: "1.0" }],
      rc: 0,
      neg: -300,
    };
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it("reads zcbor's indefinite-length map and array", () => {
    // {_ "images": [_ {_ "slot": 1}]}
    const bytes = hex("bf66696d61676573" + "9f" + "bf64736c6f7401ff" + "ff" + "ff");
    expect(decodeCbor(bytes)).toEqual({ images: [{ slot: 1 }] });
  });

  it("joins a chunked text string", () => {
    expect(decodeCbor(hex("7f6261626163ff"))).toEqual("abc");
  });

  it("reads half, single and double floats", () => {
    expect(decodeCbor(hex("f93c00"))).toBe(1);
    expect(decodeCbor(hex("fa3fc00000"))).toBe(1.5);
    expect(decodeCbor(hex("fb400921fb54442d18"))).toBeCloseTo(Math.PI);
  });

  it("skips a tag", () => {
    expect(decodeCbor(hex("c11a514b67b0"))).toBe(1363896240);
  });

  it("rejects truncated and trailing bytes", () => {
    expect(() => decodeCbor(hex("1903"))).toThrow(CborError);
    expect(() => decodeCbor(hex("0000"))).toThrow(CborError);
  });
});
