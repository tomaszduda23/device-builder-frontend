import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/util/sleep.js", () => ({ sleep: () => Promise.resolve() }));

import { NRF54L_CHIPS } from "../../../../src/platforms/nrf52/cmsis-dap/chips.js";
import { Dap, DapTransferError } from "../../../../src/platforms/nrf52/cmsis-dap/dap.js";
import {
  alignSegments,
  ImageOutOfRangeError,
  prepareNrf54l,
  runNrf54l,
  writeNrf54l,
  WrongChipError,
} from "../../../../src/platforms/nrf52/cmsis-dap/nrf54l.js";
import { SwdTarget } from "../../../../src/platforms/nrf52/cmsis-dap/swd.js";
import type { HexSegment } from "../../../../src/util/intel-hex.js";
import { FakeDapTarget } from "./_fake-dap-target.js";

const CHIP = NRF54L_CHIPS.nrf54lm20a;

const seg = (address: number, bytes: number[]): HexSegment => ({
  address,
  data: new Uint8Array(bytes),
});

async function setUp(fake = new FakeDapTarget()) {
  const dap = new Dap(fake);
  await dap.readPacketSize();
  return { fake, target: new SwdTarget(dap) };
}

/** Bytes long enough to cross the 1 KiB TAR wrap and several packets. */
const image = (length: number, from = 0) =>
  Array.from({ length }, (_, i) => (i * 7 + from) & 0xff);

describe("nRF54LM20A through CMSIS-DAP", () => {
  it("halts, stops the watchdog, writes through the write buffer, verifies and runs", async () => {
    const { fake, target } = await setUp();
    const app = image(3000);
    const uicr = [0x11, 0x22, 0x33, 0x44];
    const progress: number[] = [];

    await prepareNrf54l(target, CHIP, () => {});
    await writeNrf54l(target, CHIP, [seg(0x1000, app), seg(0xffd000, uicr)], {
      onProgress: (p) => progress.push(p),
    });
    await runNrf54l(target);

    expect(fake.bytes(0x1000, app.length)).toEqual(app);
    expect(fake.bytes(0xffd000, 4)).toEqual(uicr);
    expect(fake.log.slice(0, 3)).toEqual(["halt", "reset", "wdt-stop"]);
    expect(fake.log.slice(-3)).toEqual(["commit", "run", "reset"]);
    expect(progress[progress.length - 1]).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("keeps the bytes around an unaligned segment", async () => {
    const { fake, target } = await setUp();
    fake.mem.set(0x2000, 0xaabbccdd);
    fake.mem.set(0x2004, 0x11223344);
    await prepareNrf54l(target, CHIP, () => {});
    await writeNrf54l(target, CHIP, [seg(0x2001, [1, 2, 3, 4])], {
      onProgress: () => {},
    });
    expect(fake.bytes(0x2000, 8)).toEqual([0xdd, 1, 2, 3, 4, 0x33, 0x22, 0x11]);
  });

  it("uses the probe's own packet size", async () => {
    const fake = new FakeDapTarget();
    fake.packetSize = 512;
    const { target } = await setUp(fake);
    expect(target.dap.blockWords).toBe(126);
    await prepareNrf54l(target, CHIP, () => {});
    const app = image(4100, 3);
    await writeNrf54l(target, CHIP, [seg(0, app)], { onProgress: () => {} });
    expect(fake.bytes(0, app.length)).toEqual(app);
  });

  it("erases a protected chip to unlock it, then flashes it", async () => {
    const fake = new FakeDapTarget();
    fake.locked = true;
    fake.mem.set(0x8000, 0x12345678);
    const { target } = await setUp(fake);
    const lines: string[] = [];
    await prepareNrf54l(target, CHIP, (l) => lines.push(l));
    expect(fake.erased).toBe(true);
    expect(fake.resets).toBe(1);
    expect(fake.mem.has(0x8000)).toBe(false);
    expect(lines.some((l) => l.includes("APPROTECT"))).toBe(true);
  });

  it("refuses a chip that is not an nRF54L", async () => {
    const fake = new FakeDapTarget();
    fake.ctrlApIdr = 0x02880000;
    const { target } = await setUp(fake);
    await expect(prepareNrf54l(target, CHIP, () => {})).rejects.toBeInstanceOf(
      WrongChipError
    );
  });

  it("refuses another nRF54L than the image is for", async () => {
    const fake = new FakeDapTarget();
    fake.part = 0x00054b15;
    const { target } = await setUp(fake);
    await expect(prepareNrf54l(target, CHIP, () => {})).rejects.toThrow(/part code/);
  });

  it("refuses an image outside RRAM and UICR before writing", async () => {
    const { fake, target } = await setUp();
    await prepareNrf54l(target, CHIP, () => {});
    await expect(
      writeNrf54l(target, CHIP, [seg(0x1fcffe, [1, 2, 3, 4])], { onProgress: () => {} })
    ).rejects.toBeInstanceOf(ImageOutOfRangeError);
    expect(fake.log).not.toContain("commit");
  });

  it("reports a faulted write", async () => {
    const fake = new FakeDapTarget();
    fake.failRramWriteAt = 20;
    const { target } = await setUp(fake);
    await prepareNrf54l(target, CHIP, () => {});
    await expect(
      writeNrf54l(target, CHIP, [seg(0, image(400))], { onProgress: () => {} })
    ).rejects.toBeInstanceOf(DapTransferError);
  });

  it("stops between packets once aborted", async () => {
    const { target } = await setUp();
    await prepareNrf54l(target, CHIP, () => {});
    const abort = new AbortController();
    const reason = new Error("stopped");
    await expect(
      writeNrf54l(target, CHIP, [seg(0, image(2000))], {
        signal: abort.signal,
        onProgress: (p) => {
          if (p > 10) abort.abort(reason);
        },
      })
    ).rejects.toBe(reason);
  });
});

describe("alignSegments", () => {
  it("pads a short segment inside one word from what is there", async () => {
    const current = vi.fn(async () => 0x44332211);
    const [run] = await alignSegments([seg(0x101, [0xaa])], current);
    expect(run.address).toBe(0x100);
    expect([...run.words]).toEqual([0x4433aa11]);
  });

  it("reads nothing for an aligned segment", async () => {
    const current = vi.fn(async () => 0);
    await alignSegments([seg(0x100, [1, 2, 3, 4, 5, 6, 7, 8])], current);
    expect(current).not.toHaveBeenCalled();
  });
});
