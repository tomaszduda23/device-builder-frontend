// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/util/sleep.js", () => ({ sleep: () => Promise.resolve() }));

import { identityLocalize } from "../../../_dom.js";
import {
  cmsisDapFailureCopy,
  CmsisDapFlashError,
  flashCmsisDap,
} from "../../../../src/platforms/nrf52/cmsis-dap/flash.js";
import { FakeDapTarget } from "./_fake-dap-target.js";

const SEGMENTS = [{ address: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }];

interface FakeUsbOptions {
  vendorOnly?: boolean;
  openError?: Error;
  /** The device drops off the bus at the first command of this id. */
  lostOn?: number;
}

/** A USBDevice with the CMSIS-DAP v2 interface, answering from ``target``. */
function fakeUsb(target: FakeDapTarget, opts: FakeUsbOptions = {}) {
  let pending: Promise<Uint8Array> | null = null;
  const bulk = (direction: "in" | "out", endpointNumber: number) => ({
    type: "bulk",
    direction,
    endpointNumber,
  });
  const dapAlt = {
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    endpoints: [bulk("out", 1), bulk("in", 2)],
  };
  const hidAlt = { interfaceClass: 0x03, interfaceName: "CMSIS-DAP v1", endpoints: [] };
  const device = {
    vendorId: 0x2886,
    productId: 0x0068,
    configuration: {
      interfaces: [
        { interfaceNumber: 0, alternates: [hidAlt] },
        ...(opts.vendorOnly === false
          ? []
          : [{ interfaceNumber: 3, alternates: [dapAlt] }]),
      ],
    },
    open: vi.fn(async () => {
      if (opts.openError) throw opts.openError;
    }),
    close: vi.fn(async () => {}),
    selectConfiguration: vi.fn(),
    claimInterface: vi.fn(async () => {}),
    releaseInterface: vi.fn(async () => {}),
    transferOut: vi.fn(async (_ep: number, data: Uint8Array) => {
      if (data[0] === opts.lostOn) throw new DOMException("gone", "NetworkError");
      pending = target.exchange(data);
      return { status: "ok", bytesWritten: data.length };
    }),
    transferIn: vi.fn(async () => {
      const bytes = await pending!;
      return { status: "ok", data: new DataView(bytes.buffer) };
    }),
  };
  return device;
}

const requestDevice = vi.fn();

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, usb: { requestDevice } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("flashCmsisDap", () => {
  it("writes through the picked probe's v2 interface and releases it", async () => {
    const target = new FakeDapTarget();
    const usb = fakeUsb(target);
    requestDevice.mockResolvedValue(usb);
    const opened = vi.fn();
    const lines: string[] = [];

    const flashed = await flashCmsisDap(SEGMENTS, {
      onProgress: () => {},
      onLog: (l) => lines.push(l),
      onDeviceOpened: opened,
    });

    expect(flashed).toBe(true);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ classCode: 0xff }],
    });
    expect(usb.claimInterface).toHaveBeenCalledWith(3);
    expect(opened).toHaveBeenCalledOnce();
    expect(target.bytes(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(usb.releaseInterface).toHaveBeenCalledWith(3);
    expect(usb.close).toHaveBeenCalled();
    expect(lines[0]).toBe("Picked the probe (2886:0068)");
  });

  it("is false, without opening anything, when the chooser is dismissed", async () => {
    requestDevice.mockRejectedValue(new DOMException("none", "NotFoundError"));
    expect(await flashCmsisDap(SEGMENTS, { onProgress: () => {} })).toBe(false);
  });

  it("is false, with the probe released, when the caller moved on before the write", async () => {
    const target = new FakeDapTarget();
    const usb = fakeUsb(target);
    requestDevice.mockResolvedValue(usb);
    let checks = 0;
    const flashed = await flashCmsisDap(SEGMENTS, {
      onProgress: () => {},
      cancelled: () => ++checks > 1,
    });
    expect(flashed).toBe(false);
    expect(target.bytes(0, 8)).toEqual(Array(8).fill(0xff));
    expect(usb.close).toHaveBeenCalled();
  });

  it.each([
    ["no-dap", { vendorOnly: false }, undefined],
    [
      "access-denied",
      { openError: new DOMException("Access denied.", "SecurityError") },
      undefined,
    ],
    ["wrong-chip", {}, (t: FakeDapTarget) => (t.part = 0x1234)],
    ["device-lost", { lostOn: 0x06 }, undefined],
  ] as const)("names a %s failure", async (kind, opts, tweak) => {
    const target = new FakeDapTarget();
    tweak?.(target);
    const usb = fakeUsb(target, opts);
    requestDevice.mockResolvedValue(usb);
    const err = await flashCmsisDap(SEGMENTS, { onProgress: () => {} }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CmsisDapFlashError);
    expect((err as CmsisDapFlashError).kind).toBe(kind);
  });
});

describe("cmsisDapFailureCopy", () => {
  it.each([
    ["access-denied", "firmware.cmsis_dap_access_denied"],
    ["no-dap", "firmware.cmsis_dap_no_interface"],
    ["wrong-chip", "firmware.cmsis_dap_wrong_chip"],
    ["image", "firmware.cmsis_dap_bad_image"],
    ["flash", "firmware.cmsis_dap_flash_failed"],
    ["connect", "firmware.browser_flash_connect_failed"],
  ] as const)("titles %s", (kind, title) => {
    expect(
      cmsisDapFailureCopy(new CmsisDapFlashError(kind, new Error("x")), identityLocalize)
        .title
    ).toBe(title);
  });

  it("says a lost device was lost", () => {
    expect(
      cmsisDapFailureCopy(new CmsisDapFlashError("device-lost"), identityLocalize)
    ).toEqual({
      title: "firmware.cmsis_dap_flash_failed",
      detail: "firmware.cmsis_dap_device_lost",
    });
  });
});
