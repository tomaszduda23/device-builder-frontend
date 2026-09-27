import { describe, expect, it } from "vitest";

import {
  McubootImageError,
  parseMcubootImage,
  toHex,
} from "../../../src/util/smp/mcuboot-image.js";
import { makeMcubootImage } from "./_fake-smp-device.js";

describe("parseMcubootImage", () => {
  it("reads the version and the hash the TLV carries", async () => {
    const bytes = await makeMcubootImage(1000, [2, 1, 7, 42]);
    const image = await parseMcubootImage(bytes);
    expect(image.version).toBe("2.1.7+42");
    expect(image.bytes).toBe(bytes);
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.slice(0, 32 + 1000))
    );
    expect(toHex(image.hash)).toBe(toHex(expected));
  });

  it("parses an image that sits inside a larger buffer", async () => {
    const bytes = await makeMcubootImage(64);
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 8);
    const image = await parseMcubootImage(padded.subarray(8, 8 + bytes.length));
    expect(image.version).toBe("1.2.3+4");
  });

  it("rejects a file that is not an MCUboot image", async () => {
    const bytes = await makeMcubootImage();
    bytes[0] ^= 0xff;
    await expect(parseMcubootImage(bytes)).rejects.toThrow(/magic/);
    await expect(parseMcubootImage(new Uint8Array(8))).rejects.toThrow(McubootImageError);
  });

  it("rejects an image whose contents do not match its hash", async () => {
    const bytes = await makeMcubootImage();
    bytes[100] ^= 1;
    await expect(parseMcubootImage(bytes)).rejects.toThrow(/does not match/);
  });

  it("rejects an image cut short", async () => {
    const bytes = await makeMcubootImage();
    await expect(parseMcubootImage(bytes.slice(0, 500))).rejects.toThrow(
      McubootImageError
    );
    await expect(parseMcubootImage(bytes.slice(0, bytes.length - 10))).rejects.toThrow(
      /TLV/
    );
  });
});
