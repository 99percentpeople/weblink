// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createTaskService,
  isActiveTask,
  type TaskSources,
} from "@/libs/application/task-service";
import type {
  StoreMessage,
  FileTransferMessage,
} from "@/libs/domain/message";
import {
  TransferMode,
  type FileTransferer,
} from "@/libs/domain/transfer/file-transferer";
import type {
  ActiveFileTransfer,
  FileTransferStates,
} from "@/libs/application/transfer/file-transfer-state";
import type { PeerSession } from "@/libs/domain/session";
import type { FileMetaData } from "@/libs/domain/file";
import type { SpeedTestState } from "@/libs/application/speed-test-service";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
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
const live = (
  messageId = "message-1",
  peerId = "peer",
): ActiveFileTransfer => ({
  id: `run:${messageId}`,
  messageId,
  fileId: "file-1",
  session: {
    clientId: "self",
    targetClientId: peerId,
  } as PeerSession,
  transferer: {} as FileTransferer,
});
function setup(initial: StoreMessage[] = []) {
  return createRoot((dispose) => {
    disposers.push(dispose);
    const [messages, setMessages] =
      createSignal<StoreMessage[]>(initial);
    const [caches, setCaches] = createSignal<
      Record<string, FileMetaData | undefined>
    >({});
    const [transfers, setTransfers] =
      createSignal<FileTransferStates>({});
    const [preparations, setPreparations] = createSignal<
      ReturnType<NonNullable<TaskSources["preparations"]>>
    >([]);
    const sources: TaskSources = {
      clientId: () => "self",
      messages,
      caches,
      transfers,
      preparations,
    };
    return {
      service: createTaskService(sources),
      setMessages,
      setCaches,
      setTransfers,
      setPreparations,
      messages,
    };
  });
}

describe("application task list", () => {
  it("unifies file sends, file receives and speed tests with the latest status change first", () => {
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
    setTransfers({ active: live() });
    service.recordSpeedTest(run());
    expect(
      service.tasks().map((task) => task.kind),
    ).toEqual(["speed-test", "file-send", "file-receive"]);
    expect(service.activeCount()).toBe(2);
  });
  it("sorts pause, resume and completion by status change time without progress updates moving rows", () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(1000);
    const { service, setTransfers, setMessages } = setup([
      file({ progress: { total: 1024, received: 256 } }),
    ]);
    setTransfers({ active: live() });
    clock.mockReturnValue(2000);
    service.recordSpeedTest(run());
    expect(service.tasks().map((task) => task.id)).toEqual([
      "speed:run-1",
      "file:message-1",
    ]);
    clock.mockReturnValue(3000);
    setMessages([
      file({ progress: { total: 1024, received: 512 } }),
    ]);
    expect(
      service.tasks().map((task) => task.statusChangedAt),
    ).toEqual([2000, 1000]);
    setTransfers({});
    expect(service.tasks()[0]).toMatchObject({
      id: "file:message-1",
      status: "paused",
      statusChangedAt: 3000,
    });
    clock.mockReturnValue(4000);
    service.recordSpeedTest(
      run("run-1", {
        progress: { phase: "download", bytes: 2048 },
      }),
    );
    expect(service.tasks()[0].id).toBe("file:message-1");
    setTransfers({ active: live() });
    expect(service.tasks()[0]).toMatchObject({
      status: "running",
      statusChangedAt: 4000,
    });
    clock.mockReturnValue(5000);
    setMessages([file({ transferStatus: "complete" })]);
    setTransfers({});
    expect(service.tasks()[0]).toMatchObject({
      status: "completed",
      statusChangedAt: 5000,
    });
    expect(service.tasks()[1].status).toBe("running");
  });

  it("keeps equal-time ordering deterministic when source arrays are rebuilt or reordered", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = file({ id: "a" });
    const b = file({ id: "b" });
    const { service, setMessages } = setup([b, a]);
    expect(service.tasks().map((task) => task.id)).toEqual([
      "file:a",
      "file:b",
    ]);
    const failedA = {
      ...a,
      transferStatus: "error" as const,
    };
    const failedB = {
      ...b,
      transferStatus: "error" as const,
    };
    setMessages([failedA, b]);
    setMessages([failedA, failedB]);
    expect(service.tasks().map((task) => task.id)).toEqual([
      "file:b",
      "file:a",
    ]);
    setMessages([{ ...failedB }, { ...failedA }]);
    expect(service.tasks().map((task) => task.id)).toEqual([
      "file:b",
      "file:a",
    ]);
  });

  it("uses the same status ordering for file preparation and retains it when other history is cleared", () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(1000);
    const { service, setPreparations, setMessages } = setup(
      [file()],
    );
    const preparation = {
      id: "hash",
      kind: "file-prepare" as const,
      peerId: "",
      fileName: "sample.bin",
      createdAt: 50,
      status: "running" as const,
      bytes: 0,
      total: 1024,
      cancel: () => {},
    };
    setPreparations([preparation]);
    clock.mockReturnValue(2000);
    setMessages([file({ transferStatus: "error" })]);
    expect(service.tasks()[0].id).toBe("file:message-1");
    clock.mockReturnValue(3000);
    setPreparations([{ ...preparation, bytes: 512 }]);
    expect(service.tasks()[1].statusChangedAt).toBe(1000);
    service.clearFinished();
    expect(service.tasks()[0]).toMatchObject({
      id: "hash",
      statusChangedAt: 1000,
    });
    setPreparations([
      { ...preparation, status: "completed", bytes: 1024 },
    ]);
    expect(service.tasks()[0].statusChangedAt).toBe(3000);
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
  it("retains progress after a run pauses and uses exact cached bytes for restored downloads", () => {
    const {
      service,
      setCaches,
      setTransfers,
      setMessages,
    } = setup([
      file({
        client: "peer",
        target: "self",
        progress: { total: 1024, received: 512 },
      }),
    ]);
    setTransfers({ active: live() });
    expect(service.tasks()[0]).toMatchObject({
      status: "running",
      bytes: 512,
    });
    setTransfers({});
    expect(service.tasks()[0]).toMatchObject({
      status: "paused",
      bytes: 512,
    });
    setMessages([
      file({
        client: "peer",
        target: "self",
        status: "sending",
      }),
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        cachedBytes: 700,
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "paused",
      bytes: 700,
    });
    expect(service.activeCount()).toBe(0);
    // A complete local source says nothing about the peer's upload progress.
    setMessages([
      file({ progress: { total: 1024, received: 256 } }),
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        cachedBytes: 1024,
        isComplete: true,
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "paused",
      bytes: 256,
    });
  });

  it("freezes a detached shared download while its source continues for another message", () => {
    const message = file({
      client: "peer",
      target: "self",
      localContentDetached: true,
      progress: { total: 1024, received: 256 },
    });
    const { service, setTransfers, setCaches } = setup([
      message,
    ]);
    setTransfers({ active: live() });
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        cachedBytes: 1024,
        isComplete: true,
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "paused",
      bytes: 256,
    });
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
    setTransfers({ active: live("new") });
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
    setTransfers({ active: live() });
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
    expect(
      service
        .tasks()
        .some((task) => task.id === "speed:active"),
    ).toBe(true);
    expect(service.latestSpeedTest("peer")?.id).toBe("60");
  });
});

it("tracks the same cache independently for different recipients", () => {
  const { service, setTransfers } = setup([
    file({ id: "a", target: "a" }),
    file({ id: "b", target: "b" }),
  ]);
  setTransfers({ a: live("a", "a"), b: live("b", "b") });
  expect(service.activeCount()).toBe(2);
  setTransfers({ b: live("b", "b") });
  expect(service.activeCount()).toBe(1);
  expect(
    service.tasks().find((task) => task.id === "file:a")
      ?.status,
  ).toBe("paused");
  expect(
    service.tasks().find((task) => task.id === "file:b")
      ?.status,
  ).toBe("waiting");
});

it("uses the registered message identity even when newer history has the same file", () => {
  const { service, setTransfers } = setup([
    file({ id: "older", createdAt: 1 }),
    file({ id: "newer", createdAt: 2 }),
  ]);
  setTransfers({ active: live("older") });
  expect(
    service.tasks().find((task) => task.id === "file:older")
      ?.status,
  ).toBe("waiting");
  expect(
    service.tasks().find((task) => task.id === "file:newer")
      ?.status,
  ).toBe("paused");
});

describe("room attachment tasks", () => {
  const room = {
    roomId: "room",
    senderName: "Sender",
    senderAvatar: null,
  };

  it("does not use another room offer's cache as a completed download or display name", () => {
    const message = file({
      room,
      client: "peer",
      target: "self",
    });
    const { service, setCaches } = setup([message]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "private.bin",
        fileSize: 1024,
        isComplete: true,
        roomAttachment: true,
        roomOfferId: "another-offer",
        from: "peer",
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "paused",
      fileName: "sample.bin",
    });
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: message.fileName,
        fileSize: message.fileSize,
        chunkSize: message.chunkSize,
        isComplete: true,
        roomAttachment: true,
        roomOfferId: message.id,
        from: message.client,
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "completed",
      fileName: "sample.bin",
    });
  });

  it("does not create transfer tasks for announced but unclaimed room offers", () => {
    const { service, setCaches } = setup([
      file({
        room,
        target: "room:demo",
        transferStatus: undefined,
        deliveries: { peer: "delivered" },
      }),
      file({
        id: "received-offer",
        room,
        client: "peer",
        target: "self",
        transferStatus: undefined,
      }),
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        isComplete: true,
        roomAttachment: true,
      },
    });
    expect(service.tasks()).toEqual([]);
    expect(service.activeCount()).toBe(0);
  });

  it("projects one room offer into independent uploads using actual peer identities", () => {
    const message = file({
      room,
      target: "room:demo",
      status: "error",
      transferStatus: undefined,
      deliveries: { a: "failed", b: "delivered" },
      roomTransfers: {
        a: {
          status: "transfering",
          progress: { total: 1024, received: 512 },
        },
        b: { status: "complete" },
      },
    });
    const { service, setCaches, setTransfers } = setup([
      message,
    ]);
    setCaches({
      "file-1": {
        id: "file-1",
        fileName: "sample.bin",
        fileSize: 1024,
        isComplete: true,
        roomAttachment: true,
      },
    });
    setTransfers({
      a: {
        ...live(message.id, "a"),
        transferer: {
          mode: TransferMode.Send,
        } as FileTransferer,
      },
    });
    expect(service.tasks()).toMatchObject([
      {
        kind: "file-send",
        peerId: "a",
        status: "running",
        bytes: 512,
        canPause: true,
        canResume: false,
      },
      {
        kind: "file-send",
        peerId: "b",
        status: "completed",
        bytes: 1024,
        canPause: false,
        canResume: false,
      },
    ]);
    expect(
      new Set(service.tasks().map((task) => task.id)).size,
    ).toBe(2);
    expect(service.activeCount()).toBe(1);
    service.clearFinished();
    expect(service.tasks()).toHaveLength(1);
    setTransfers({});
    expect(service.tasks()[0]).toMatchObject({
      peerId: "a",
      status: "paused",
    });
    expect(message.deliveries).toEqual({
      a: "failed",
      b: "delivered",
    });
  });

  it("binds room download progress to its original offer and sender after restart", () => {
    const message = file({
      room,
      client: "peer",
      target: "self",
      status: "error",
      transferStatus: "transfering",
      progress: { total: 1024, received: 256 },
    });
    const { service, setTransfers } = setup([message]);
    expect(service.tasks()[0]).toMatchObject({
      peerId: "peer",
      kind: "file-receive",
      status: "paused",
      bytes: 256,
      canResume: true,
    });
    setTransfers({
      wrong: {
        ...live(message.id, "other"),
        transferer: {
          mode: TransferMode.Receive,
        } as FileTransferer,
      },
    });
    expect(service.activeCount()).toBe(0);
    setTransfers({
      receive: {
        ...live(message.id),
        transferer: {
          mode: TransferMode.Receive,
        } as FileTransferer,
      },
    });
    expect(service.tasks()[0]).toMatchObject({
      status: "running",
      canPause: true,
    });
    expect(service.activeCount()).toBe(1);
  });
});
