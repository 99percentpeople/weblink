import { beforeEach, expect, it, vi } from "vitest";
import { RoomDataChannel } from "../src/room/channel";

const { write } = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: write }));

function channel(protocol = "transfer") {
  const end = vi.fn();
  const dc = new RoomDataChannel(
    "peer",
    3,
    "test",
    { protocol },
    end,
  );
  dc.state("open");
  return { dc, end };
}
function unpack(data: Uint8Array) {
  const packets: Uint8Array[] = [];
  const view = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
  for (let offset = 0; offset < data.length; ) {
    const size = view.getUint32(offset, true);
    offset += 4;
    packets.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return packets;
}
beforeEach(() => {
  write
    .mockReset()
    .mockImplementation(
      async (_command, data, { headers }) =>
        headers["x-weblink-payload"] === "binary-batch"
          ? unpack(data).reduce(
              (bytes, packet) => bytes + packet.length,
              0,
            )
          : null,
    );
});

it.each(["transfer", "weblink-speedtest-v1"])(
  "bounds the number and size of IPC writes on %s and flushes before closing",
  async (protocol) => {
    const { dc, end } = channel(protocol);
    const packet = new Uint8Array(32 * 1024);
    const low = vi.fn();
    dc.addEventListener("bufferedamountlow", low);
    for (let i = 0; i < 32; i++) {
      packet[0] = i;
      dc.send(packet);
    }
    packet.fill(255);
    dc.close();
    expect(end).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(end).toHaveBeenCalledOnce(),
    );
    expect(write).toHaveBeenCalledTimes(5);
    const received = write.mock.calls.flatMap(
      ([name, bytes, { headers }]) => {
        expect(name).toBe("room_write");
        expect(headers["x-weblink-payload"]).toBe(
          "binary-batch",
        );
        expect(bytes.byteLength).toBeLessThanOrEqual(
          256 * 1024,
        );
        return unpack(bytes).map((packet) => packet[0]);
      },
    );
    expect(received).toEqual(
      Array.from({ length: 32 }, (_, i) => i),
    );
    expect(dc.bufferedAmount).toBe(1024 * 1024);
    expect(low).not.toHaveBeenCalled();
    dc.drain(dc.bufferedAmount);
    expect(low).toHaveBeenCalledOnce();
  },
);

it("sends an isolated packet immediately and preserves text and binary boundaries behind it", async () => {
  const { dc, end } = channel();
  let release!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  dc.send(Uint8Array.of(1));
  await Promise.resolve();
  expect(write).toHaveBeenCalledOnce();
  dc.send(Uint8Array.of(2));
  dc.send(Uint8Array.of(3));
  dc.send("done");
  dc.send(Uint8Array.of(4));
  dc.close();
  release();
  await vi.waitFor(() =>
    expect(end).toHaveBeenCalledOnce(),
  );
  expect(
    write.mock.calls.map(
      (c) => c[2].headers["x-weblink-payload"],
    ),
  ).toEqual(["binary", "binary-batch", "text", "binary"]);
});

it("leaves latency-sensitive binary messages separate", async () => {
  const { dc, end } = channel("control");
  dc.send(Uint8Array.of(1));
  dc.send(Uint8Array.of(2));
  dc.close();
  await vi.waitFor(() =>
    expect(end).toHaveBeenCalledOnce(),
  );
  expect(
    write.mock.calls.map(
      (c) => c[2].headers["x-weblink-payload"],
    ),
  ).toEqual(["binary", "binary"]);
});

it("closes on a partial batch without retrying or double draining the accepted prefix", async () => {
  const { dc, end } = channel();
  const error = vi.fn();
  dc.addEventListener("error", error);
  write.mockResolvedValueOnce(2);
  dc.send(Uint8Array.of(1, 2));
  dc.send(Uint8Array.of(3));
  dc.send("later");
  await vi.waitFor(() =>
    expect(end).toHaveBeenCalledOnce(),
  );
  expect(write).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  expect(dc.bufferedAmount).toBe(2);
  dc.drain(2);
  expect(dc.bufferedAmount).toBe(0);
});
