// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createTaskService,
  isActiveTask,
  type TaskSources,
} from "@/libs/services/task-service";
import type {
  StoreMessage,
  FileTransferMessage,
} from "@/libs/core/message";
import type { FileTransferer } from "@/libs/core/file-transferer";
import type { FileMetaData } from "@/libs/cache";
import type { SpeedTestState } from "@/libs/services/speed-test-service";

const disposers: Array<() => void> = [];
afterEach(() =>
  disposers.splice(0).forEach((dispose) => dispose()),
);
const file = (
  overrides: Partial<FileTransferMessage> = {},
): FileTransferMessage => ({
  id: "message-1",
  type: "file",
  fid: "file-1",
  fileName: "sample.bin",
  fileSize: 1024,
  chunkSize: 512,
  createdAt: 100,
  client: "self",
  target: "peer",
  status: "received",
  transferStatus: "paused",
  ...overrides,
});
const run = (
  id = "run-1",
  overrides: Partial<SpeedTestState> = {},
): SpeedTestState => ({
  id,
  startedAt: 200,
  status: "running",
  peerId: "peer",
  progress: { phase: "upload", bytes: 512 },
  ...overrides,
});
const live = {} as FileTransferer;
function setup(initial: StoreMessage[] = []) {
  return createRoot((dispose) => {
    disposers.push(dispose);
    const [messages, setMessages] =
      createSignal<StoreMessage[]>(initial);
    const [caches, setCaches] = createSignal<
      Record<string, FileMetaData | undefined>
    >({});
    const [transfers, setTransfers] = createSignal<
      Record<string, FileTransferer | undefined>
    >({});
    const sources: TaskSources = {
      clientId: () => "self",
      messages,
      caches,
      transfers,
    };
    return {
      service: createTaskService(sources),
      setMessages,
      setCaches,
      setTransfers,
      messages,
    };
  });
}

describe("application task list", () => {
  it("unifies file sends, file receives and speed tests with active work first", () => {
    const { service, setTransfers } = setup([
      file(),
      file({
        id: "receive",
        fid: "other",
        client: "peer",
        target: "self",
        createdAt: 90,
      }),
    ]);
    setTransfers({ "file-1": live });
    service.recordSpeedTest(run());
    expect(
      service.tasks().map((task) => task.kind),
    ).toEqual(["speed-test", "file-send", "file-receive"]);
    expect(service.activeCount()).toBe(2);
  });
  it("ignores text messages and unrelated peers' messages", () => {
    const { service } = setup([
      {
        id: "chat",
        client: "self",
        target: "peer",
        createdAt: 1,
        type: "text",
        data: "hello",
      },
      file({ client: "other-a", target: "other-b" }),
    ]);
    expect(service.tasks()).toEqual([]);
  });
  it("uses cache metadata as the display file name instead of a stale message id", () => {
    const { service, setCaches } = setup([
      file({
        fileName: "8d3b7861-legacy-file-id",
      }),
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "report.pdf",
        fileSize: 1024,
      },
    });

    const task = service.tasks()[0];
    expect(task.kind).toBe("file-send");
    if (task.kind !== "file-send")
      throw new Error("expected file task");
    expect(task.fileName).toBe("report.pdf");
    expect(task.message.fileName).toBe(
      "8d3b7861-legacy-file-id",
    );
  });

  it("does not mistake a sender's local file cache for a completed send", () => {
    const { service, setCaches } = setup([file()]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        isComplete: true,
      },
    });
    expect(service.tasks()[0].status).toBe("paused");
  });
  it("shows receiver finalization and then completion", () => {
    const { service, setCaches } = setup([
      file({ client: "peer", target: "self" }),
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        isMerging: true,
      },
    });
    expect(service.tasks()[0].status).toBe("finalizing");
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        isComplete: true,
      },
    });
    expect(service.tasks()[0].status).toBe("completed");
  });
  it("shows a stale persisted transfer as paused instead of running forever", () => {
    const { service } = setup([
      file({ transferStatus: "transfering" }),
    ]);
    expect(service.tasks()[0].status).toBe("paused");
    expect(service.activeCount()).toBe(0);
  });
  it("keeps queued file handshakes visible", () => {
    const { service } = setup([
      file({ status: "sending", transferStatus: "init" }),
    ]);
    expect(service.tasks()[0].status).toBe("waiting");
  });
  it("does not attach one live transfer to every historical message for that file", () => {
    const { service, setTransfers } = setup([
      file({
        id: "old",
        createdAt: 10,
        transferStatus: "complete",
      }),
      file({ id: "new", createdAt: 20 }),
    ]);
    setTransfers({ "file-1": live });
    expect(
      service.tasks().filter(isActiveTask),
    ).toHaveLength(1);
    expect(
      service.tasks().find((task) => task.id === "file:old")
        ?.status,
    ).toBe("completed");
  });
  it("updates a speed run in place, preserving its identity and start time", () => {
    const { service } = setup();
    service.recordSpeedTest(run());
    service.recordSpeedTest(
      run("run-1", {
        progress: { phase: "download", bytes: 2048 },
      }),
    );
    service.recordSpeedTest(
      run("run-1", { status: "done" }),
    );
    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0]).toMatchObject({
      id: "speed:run-1",
      createdAt: 200,
      status: "completed",
    });
    expect(service.activeCount()).toBe(0);
  });
  it("retains each peer's result when another peer starts a test", () => {
    const { service } = setup();
    service.recordSpeedTest(
      run("a", { status: "done", peerId: "a" }),
    );
    service.recordSpeedTest(
      run("b", { peerId: "b", startedAt: 300 }),
    );
    expect(service.latestSpeedTest("a")?.status).toBe(
      "done",
    );
    expect(service.latestSpeedTest("b")?.status).toBe(
      "running",
    );
    expect(
      service.latestSpeedTest("unknown"),
    ).toBeUndefined();
  });
  it("gives repeated tests to the same peer separate history entries", () => {
    const { service } = setup();
    service.recordSpeedTest(run("a", { status: "done" }));
    service.recordSpeedTest(run("b", { startedAt: 300 }));
    expect(service.tasks()).toHaveLength(2);
    expect(service.latestSpeedTest("peer")?.id).toBe("b");
  });
  it("records incoming approval, decline, cancellation and disconnect failures", () => {
    const { service } = setup();
    service.recordSpeedTest(
      run("approval", {
        incoming: true,
        progress: { phase: "approval", bytes: 0 },
      }),
    );
    expect(service.tasks()[0].status).toBe("waiting");
    service.recordSpeedTest(
      run("approval", {
        status: "error",
        error: "declined",
      }),
    );
    service.recordSpeedTest(
      run("cancel", {
        status: "cancelled",
        error: "cancelled",
      }),
    );
    service.recordSpeedTest(
      run("closed", { status: "error", error: "closed" }),
    );
    expect(
      service.tasks().map((task) => task.status),
    ).toEqual(
      expect.arrayContaining(["failed", "cancelled"]),
    );
    expect(service.activeCount()).toBe(0);
  });
  it("clears finished history without deleting messages, active work or paused files", () => {
    const originals = [
      file({ transferStatus: "complete" }),
      file({ id: "paused", fid: "paused" }),
    ];
    const { service, messages } = setup(originals);
    service.recordSpeedTest(
      run("done", { status: "done" }),
    );
    service.recordSpeedTest(run("live"));
    service.clearFinished();
    expect(service.tasks().map((task) => task.id)).toEqual([
      "speed:live",
      "file:paused",
    ]);
    expect(messages()).toEqual(originals);
    expect(service.latestSpeedTest("peer")?.id).toBe(
      "live",
    );
  });
  it("a cleared file can reappear if it is retried", async () => {
    const { service, setMessages, setTransfers } = setup([
      file({ status: "error", transferStatus: "error" }),
    ]);
    service.clearFinished();
    expect(service.tasks()).toHaveLength(0);
    setMessages([
      file({
        status: "received",
        transferStatus: "transfering",
      }),
    ]);
    setTransfers({ "file-1": live });
    expect(service.tasks()).toHaveLength(1);
    expect(service.activeCount()).toBe(1);
    await Promise.resolve();
    setMessages([file({ transferStatus: "complete" })]);
    setTransfers({});
    expect(service.tasks()).toHaveLength(1);
    expect(service.tasks()[0].status).toBe("completed");
  });
  it("bounds speed-test history to 50 entries, keeping active work", () => {
    const { service } = setup();
    service.recordSpeedTest(
      run("active", { startedAt: 0 }),
    );
    for (let i = 1; i <= 60; i++)
      service.recordSpeedTest(
        run(String(i), { status: "done", startedAt: i }),
      );
    expect(service.tasks()).toHaveLength(51);
    expect(service.tasks()[0].id).toBe("speed:active");
    expect(service.latestSpeedTest("peer")?.id).toBe("60");
  });
});
