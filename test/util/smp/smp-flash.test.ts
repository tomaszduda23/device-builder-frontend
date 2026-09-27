import { describe, expect, it, vi } from "vitest";

import { type CborMap, encodeCbor } from "../../../src/util/smp/cbor.js";
import { SMP_HEADER_SIZE } from "../../../src/util/smp/smp-client.js";
import { SmpSlotError } from "../../../src/util/smp/smp-errors.js";
import {
  flashMcubootOverBle,
  parseMcubootImage,
  uploadChunkSize,
} from "../../../src/util/smp/smp-flash.js";
import { fakeSmpDevice, makeMcubootImage, type SmpRequest } from "./_fake-smp-device.js";

vi.mock("../../../../src/util/sleep.js", () => ({ sleep: async () => {} }));

interface Slot {
  slot: number;
  hash: Uint8Array;
  active: boolean;
  confirmed: boolean;
}

/** An MCUboot device with MCUmgr: two slots, uploads land in slot 1. */
function mcumgrDevice(slots: Slot[], bufSize = 512) {
  let received = new Uint8Array(0);
  let resets = 0;
  let testHash: Uint8Array | null = null;
  const handler = (req: SmpRequest): CborMap | undefined => {
    const key = `${req.group}/${req.id}/${req.op}`;
    switch (key) {
      case "1/0/0":
        return { images: slots.map((s) => ({ ...s, version: "1.0.0" })) };
      case "0/6/0":
        return { buf_size: bufSize, buf_count: 4 };
      case "1/1/2": {
        const off = req.body.off as number;
        const data = req.body.data as Uint8Array;
        if (off === 0) received = new Uint8Array(req.body.len as number);
        received.set(data, off);
        return { rc: 0, off: off + data.length };
      }
      case "1/0/2":
        testHash = req.body.hash as Uint8Array;
        return { images: [] };
      case "0/5/2":
        resets++;
        return {};
      default:
        return { rc: 8 };
    }
  };
  const fake = fakeSmpDevice(handler);
  return {
    ...fake,
    received: () => received,
    resets: () => resets,
    testHash: () => testHash,
  };
}

const running = (hash: Uint8Array = new Uint8Array(32)): Slot => ({
  slot: 0,
  hash,
  active: true,
  confirmed: true,
});

describe("flashMcubootOverBle", () => {
  it("uploads the image, marks it for a test boot and resets", async () => {
    const image = await parseMcubootImage(await makeMcubootImage(5000));
    const dev = mcumgrDevice([running()]);
    const progress: number[] = [];
    const lines: string[] = [];
    await flashMcubootOverBle(dev.device, image, {
      onProgress: (p) => progress.push(p),
      onLog: (l) => lines.push(l),
    });
    expect(dev.received()).toEqual(image.bytes);
    expect(dev.testHash()).toEqual(image.hash);
    expect(dev.resets()).toBe(1);
    expect(progress[progress.length - 1]).toBe(100);
    expect(lines).toContain("Device SMP buffer: 512 bytes");
    expect(lines).toContain("Resetting the device");
    // Every upload packet fits the device's buffer.
    const uploads = dev.requests.filter((r) => r.group === 1 && r.id === 1);
    expect(uploads.length).toBeGreaterThan(5);
    expect(uploads[0].body.len).toBe(image.bytes.length);
    expect(uploads[0].body.sha).toBeInstanceOf(Uint8Array);
    expect(uploads[1].body.sha).toBeUndefined();
    expect(dev.device.gatt!.connected).toBe(false);
  });

  it("skips the upload when the image already sits in the update slot", async () => {
    const image = await parseMcubootImage(await makeMcubootImage());
    const dev = mcumgrDevice([
      running(),
      { slot: 1, hash: image.hash, active: false, confirmed: false },
    ]);
    await flashMcubootOverBle(dev.device, image, { onProgress: () => {} });
    expect(dev.requests.some((r) => r.group === 1 && r.id === 1)).toBe(false);
    expect(dev.testHash()).toEqual(image.hash);
  });

  it("refuses while the running image is an unconfirmed test boot", async () => {
    const image = await parseMcubootImage(await makeMcubootImage());
    const dev = mcumgrDevice([{ ...running(), confirmed: false }]);
    const err = await flashMcubootOverBle(dev.device, image, {
      onProgress: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmpSlotError);
    expect((err as SmpSlotError).problem).toBe("test-pending");
    expect(dev.resets()).toBe(0);
  });

  it("reports a device already running the image", async () => {
    const image = await parseMcubootImage(await makeMcubootImage());
    const dev = mcumgrDevice([running(image.hash)]);
    await expect(
      flashMcubootOverBle(dev.device, image, { onProgress: () => {} })
    ).rejects.toMatchObject({ problem: "already-running" });
  });

  it("stops and disconnects on abort", async () => {
    const image = await parseMcubootImage(await makeMcubootImage(5000));
    const dev = mcumgrDevice([running()]);
    const abort = new AbortController();
    await expect(
      flashMcubootOverBle(dev.device, image, {
        signal: abort.signal,
        onProgress: (p) => {
          if (p > 20) abort.abort();
        },
      })
    ).rejects.toThrow();
    expect(dev.resets()).toBe(0);
    expect(dev.device.gatt!.connected).toBe(false);
  });
});

describe("uploadChunkSize", () => {
  it("keeps the first, largest packet within the buffer", async () => {
    const image = await parseMcubootImage(await makeMcubootImage(100_000));
    const chunk = uploadChunkSize(512, image);
    expect(chunk).toBeGreaterThan(400);
    const first = encodeCbor({
      image: 0,
      off: 0,
      len: image.bytes.length,
      sha: new Uint8Array(32),
      data: image.bytes.subarray(0, chunk),
    });
    const later = encodeCbor({
      off: image.bytes.length - chunk,
      data: image.bytes.subarray(0, chunk),
    });
    expect(SMP_HEADER_SIZE + first.length).toBeLessThanOrEqual(512);
    expect(SMP_HEADER_SIZE + later.length).toBeLessThanOrEqual(512);
  });
});
