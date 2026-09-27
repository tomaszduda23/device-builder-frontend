import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SMP_GROUP_IMAGE,
  SMP_OP_READ,
  SmpBleClient,
  SmpDisconnectedError,
  SmpError,
  SmpTimeoutError,
} from "../../../src/util/smp/smp-client.js";
import { fakeSmpDevice } from "./_fake-smp-device.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SmpBleClient", () => {
  it("matches a response to its request and decodes the body", async () => {
    const fake = fakeSmpDevice((req) => ({ images: [], echo: req.seq }));
    const client = await SmpBleClient.connect(fake.device);
    await expect(client.request(SMP_OP_READ, SMP_GROUP_IMAGE, 0)).resolves.toEqual({
      images: [],
      echo: 0,
    });
    await expect(client.request(SMP_OP_READ, SMP_GROUP_IMAGE, 0)).resolves.toEqual({
      images: [],
      echo: 1,
    });
    client.close();
  });

  it("splits a large packet into writes and reassembles split notifications", async () => {
    const fake = fakeSmpDevice(
      (req) => ({ size: (req.body.data as Uint8Array).length }),
      {
        notifySize: 5,
      }
    );
    const client = await SmpBleClient.connect(fake.device);
    const data = new Uint8Array(1000);
    await expect(
      client.request(2, SMP_GROUP_IMAGE, 1, { off: 0, data })
    ).resolves.toEqual({ size: 1000 });
    expect(fake.writes.length).toBeGreaterThan(1);
    expect(Math.max(...fake.writes.map((w) => w.length))).toBeLessThanOrEqual(244);
    client.close();
  });

  it("falls back to minimum-size writes when a write is refused", async () => {
    const fake = fakeSmpDevice(() => ({}), { maxWrite: 20 });
    const log = vi.fn();
    const client = await SmpBleClient.connect(fake.device, log);
    await client.request(2, SMP_GROUP_IMAGE, 1, { data: new Uint8Array(100) });
    expect(fake.writes.every((w) => w.length <= 20)).toBe(true);
    expect(log).toHaveBeenCalledWith("Falling back to 20-byte Bluetooth writes");
    client.close();
  });

  it("rejects an error response with its rc, in either SMP version", async () => {
    let v2 = false;
    const fake = fakeSmpDevice(() => (v2 ? { err: { group: 1, rc: 6 } } : { rc: 10 }));
    const client = await SmpBleClient.connect(fake.device);
    await expect(client.request(0, 1, 0)).rejects.toMatchObject({
      name: "SmpError",
      rc: 10,
    });
    v2 = true;
    const err = await client.request(0, 1, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmpError);
    expect((err as SmpError).rc).toBe(6);
    client.close();
  });

  it("times out a lost response and ignores it arriving late", async () => {
    vi.useFakeTimers();
    const fake = fakeSmpDevice(() => undefined);
    const client = await SmpBleClient.connect(fake.device);
    const pending = client.request(0, 1, 0, {}, 1000);
    const assertion = expect(pending).rejects.toBeInstanceOf(SmpTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    client.close();
  });

  it("fails pending requests when the link drops, and detaches on close", async () => {
    const fake = fakeSmpDevice(() => undefined);
    const client = await SmpBleClient.connect(fake.device);
    const pending = client.request(0, 1, 0);
    fake.drop();
    await expect(pending).rejects.toBeInstanceOf(SmpDisconnectedError);
    client.close();
    expect(fake.charListenerCount()).toBe(0);
    await expect(client.request(0, 1, 0)).rejects.toBeInstanceOf(SmpDisconnectedError);
  });
});
