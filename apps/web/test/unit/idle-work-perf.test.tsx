// @vitest-environment jsdom
import {
  renderHook,
  cleanup,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, it, vi } from "vitest";
import createTransferSpeed from "@/libs/hooks/transfer-speed";
import { FileReceiver } from "@/libs/domain/transfer/file-receiver";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import {
  fakeCache,
  fakeChannel,
  fileSession,
  registryFixture,
} from "../support/file-transfer";

vi.mock(
  "@/libs/domain/transfer/uncompress-worker?worker",
  () => ({
    default: class {
      terminate() {}
    },
  }),
);
vi.mock("@/libs/platform/runtime", () => ({
  platform: {},
}));
let wakeups = 0;
beforeEach(() => {
  vi.useFakeTimers();
  wakeups = 0;
  for (const name of [
    "setTimeout",
    "setInterval",
  ] as const) {
    const original = window[name].bind(window);
    vi.spyOn(window, name).mockImplementation(((
      callback: () => void,
      ms?: number,
    ) =>
      original(() => {
        wakeups++;
        callback();
      }, ms)) as (typeof window)[typeof name]);
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const measure = it.runIf(process.env.WEBLINK_PERF === "1");
measure(
  "measures idle receive flushes over 30 seconds",
  async () => {
    const fixture = registryFixture();
    const cache = fakeCache();
    const run = fixture.register(
      fileSession(),
      cache,
      "message",
      TransferMode.Receive,
    );
    await fixture.registry.initialize(run);
    fixture.registry.setChannel(run, fakeChannel());
    await vi.advanceTimersByTimeAsync(30_000);
    console.log(
      "PERF",
      JSON.stringify({
        scenario: "idle-flush-30-seconds",
        flushes: cache.flush.mock.calls.length,
        wakeups,
      }),
    );
    fixture.registry.clear();
  },
);
measure(
  "measures idle speed sampling over 30 seconds",
  async () => {
    renderHook(() => createTransferSpeed(() => 0));
    await vi.advanceTimersByTimeAsync(30_000);
    console.log(
      "PERF",
      JSON.stringify({
        scenario: "idle-speed-30-seconds",
        wakeups,
      }),
    );
  },
);
measure(
  "measures stalled receive checks over 30 seconds",
  async () => {
    const receiver = new FileReceiver({
      cache: fakeCache(),
    });
    await receiver.initialize();
    const channel = fakeChannel();
    Object.defineProperty(channel, "bufferedAmount", {
      value: 0,
    });
    receiver.setChannel(channel);
    channel.onmessage?.call(
      channel,
      new MessageEvent("message", {
        data: JSON.stringify({ type: "complete" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    console.log(
      "PERF",
      JSON.stringify({
        scenario: "stalled-receive-30-seconds",
        wakeups,
        retries: vi.mocked(channel.send).mock.calls.length,
      }),
    );
    receiver.close();
  },
);
