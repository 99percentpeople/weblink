// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { TaskList } from "@/components/task-list";
import { createTaskService } from "@/libs/application/task-service";
import { useAppState } from "@/libs/state/app-state-context";
import type { FileTransferMessage } from "@/libs/domain/message";
import type { SpeedTestState } from "@/libs/application/speed-test-service";
import type { FileTransferer } from "@/libs/domain/transfer/file-transferer";
import type { FileTransferStates } from "@/libs/application/transfer/file-transfer-state";
import type { PeerSession } from "@/libs/domain/session";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/components/icons", () => ({
  IconAddCircle: () => <span />,
  IconCheck: () => <span />,
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    message: {
      clients: [{ clientId: "peer", name: "Peer" }],
    },
    session: {
      clientViewData: { peer: { onlineStatus: "online" } },
    },
  },
}));
const pause = vi.fn();
const resume = vi.fn();
const request = vi.fn();
const retry = vi.fn();
const cancel = vi.fn();
const approve = vi.fn();
const decline = vi.fn();
const inspect = vi.fn();
let dispose: () => void;
let tasks: ReturnType<typeof createTaskService>;
let current: SpeedTestState;
let setMessages: (messages: FileTransferMessage[]) => void;
let setTransfers: (transfers: FileTransferStates) => void;
const message = (
  props: Partial<FileTransferMessage> = {},
): FileTransferMessage => ({
  type: "file",
  id: "filemsg",
  fid: "file",
  fileName: "example.bin",
  fileSize: 1024,
  chunkSize: 512,
  createdAt: 10,
  client: "self",
  target: "peer",
  status: "received",
  transferStatus: "paused",
  ...props,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(
    HTMLElement.prototype,
    "scrollIntoView",
    {
      value: vi.fn(),
      configurable: true,
    },
  );
  pause.mockResolvedValue(undefined);
  resume.mockResolvedValue(undefined);
  request.mockResolvedValue(undefined);
  retry.mockResolvedValue(undefined);
  current = {
    id: "run",
    startedAt: 20,
    peerId: "peer",
    status: "running",
    progress: { phase: "download", bytes: 1024 },
  };
  createRoot((end) => {
    dispose = end;
    const [messages, writeMessages] = createSignal<
      FileTransferMessage[]
    >([message()]);
    const [transfers, writeTransfers] =
      createSignal<FileTransferStates>({});
    setMessages = writeMessages;
    setTransfers = writeTransfers;
    tasks = createTaskService({
      clientId: () => "self",
      messages,
      transfers,
      caches: () => ({}),
    });
  });
  tasks.recordSpeedTest(current);
  vi.mocked(useAppState).mockReturnValue({
    tasks,
    speedTestState: () => current,
    pauseFile: pause,
    resumeFile: resume,
    requestFile: request,
    retryMessage: retry,
    cancelSpeedTest: cancel,
    approveSpeedTest: approve,
    declineSpeedTest: decline,
  } as any);
});
afterEach(() => {
  cleanup();
  dispose();
  vi.unstubAllGlobals();
});

describe("unified task list controls", () => {
  it("uses faceted type filters without changing the underlying tasks", () => {
    render(() => <TaskList onInspect={inspect} />);
    expect(
      screen.getByRole("table", { name: "tasks.title" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);

    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks.filters.type",
      }),
    );
    const speedLabels = screen.getAllByText(
      "tasks.kinds.speed-test",
    );
    fireEvent.click(speedLabels[speedLabels.length - 1]);

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByText("example.bin")).toBeNull();

    fireEvent.click(
      screen.getByText("tasks.kinds.file-send"),
    );
    fireEvent.click(
      screen.getAllByText("tasks.kinds.speed-test").at(-1)!,
    );

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(
      screen.getByText("example.bin"),
    ).toBeInTheDocument();
    expect(tasks.tasks()).toHaveLength(2);
  });
  it("filters tasks by status with the faceted status selector", () => {
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks.filters.status",
      }),
    );
    const runningLabels = screen.getAllByText(
      "tasks.status.running",
    );
    fireEvent.click(
      runningLabels[runningLabels.length - 1],
    );

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByText("example.bin")).toBeNull();
    expect(
      screen.getByText("speed_test.title"),
    ).toBeInTheDocument();
  });

  it("pauses exactly the selected file", async () => {
    setTransfers({
      run: {
        id: "run",
        fileId: "file",
        messageId: "filemsg",
        session: {
          clientId: "self",
          targetClientId: "peer",
        } as PeerSession,
        transferer: {} as FileTransferer,
      },
    });
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.pause" }),
    );
    await waitFor(() =>
      expect(pause).toHaveBeenCalledWith("file", "peer"),
    );
    expect(cancel).not.toHaveBeenCalled();
  });
  it("resumes an outgoing file using the existing transfer API", async () => {
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.resume" }),
    );
    await waitFor(() =>
      expect(resume).toHaveBeenCalledWith("file", "peer"),
    );
  });
  it("requests missing ranges for a paused incoming file", async () => {
    setMessages([
      message({ client: "peer", target: "self" }),
    ]);
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.resume" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "peer",
        expect.objectContaining({
          id: "file",
          chunkSize: 512,
        }),
        true,
      ),
    );
  });
  it("retries a failed handshake instead of invoking resume", async () => {
    setMessages([
      message({ status: "error", transferStatus: "error" }),
    ]);
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.resume" }),
    );
    await waitFor(() =>
      expect(retry).toHaveBeenCalledWith(
        expect.objectContaining({ id: "filemsg" }),
      ),
    );
    expect(resume).not.toHaveBeenCalled();
  });
  it("offers approval actions for an incoming speed test", () => {
    current = {
      ...current,
      incoming: true,
      progress: { phase: "approval", bytes: 0 },
    };
    tasks.recordSpeedTest(current);
    render(() => <TaskList onInspect={inspect} />);

    expect(
      screen.getByText(
        /speed_test\.phases\.approval_incoming/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "speed_test.cancel",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.accept",
      }),
    );
    expect(approve).toHaveBeenCalledWith("peer");

    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.decline",
      }),
    );
    expect(decline).toHaveBeenCalledWith("peer");
  });

  it("only stops the matching active speed-test run", () => {
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.cancel",
      }),
    );
    expect(cancel).toHaveBeenCalledWith("peer");
    cancel.mockClear();
    current = { ...current, id: "newer-run" };
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.cancel",
      }),
    );
    expect(cancel).not.toHaveBeenCalled();
  });
  it("unmounting the list leaves its running tasks intact", () => {
    const view = render(() => (
      <TaskList onInspect={inspect} />
    ));
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(tasks.activeCount()).toBe(1);
    render(() => <TaskList onInspect={inspect} />);
    expect(
      screen.getByText(/speed_test.phases.download/),
    ).toBeInTheDocument();
  });
  it("clearing history retains running work and paused files", () => {
    tasks.recordSpeedTest({
      id: "old",
      startedAt: 1,
      peerId: "peer",
      status: "done",
    });
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks.clear_finished",
      }),
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(cancel).not.toHaveBeenCalled();
    expect(tasks.activeCount()).toBe(1);
  });
  it("surfaces action failures without losing the task", async () => {
    resume.mockRejectedValue(new Error("offline"));
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.resume" }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByText("example.bin"),
    ).toBeInTheDocument();
  });
  it("opens the speed pane from a speed task", () => {
    render(() => <TaskList onInspect={inspect} />);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "tasks.inspect",
      })[0],
    );
    expect(inspect).toHaveBeenCalledWith("peer", true);
  });
});
