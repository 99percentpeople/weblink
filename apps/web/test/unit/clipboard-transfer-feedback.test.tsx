// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeEach,
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
import { createSignal } from "solid-js";
import { toast, Toaster } from "solid-sonner";
import type {
  NotificationAction,
  SystemNotifications,
} from "@weblink/platform";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";
import type {
  SharedFileTask,
  TaskListItem,
} from "@/libs/application/task-service";
import { createRemoteTransferFeedback } from "@/libs/hooks/create-remote-transfer-feedback";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
let focused = true;
let sequence = 0;
beforeEach(() => {
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(
    () => focused,
  );
  vi.spyOn(
    document,
    "visibilityState",
    "get",
  ).mockReturnValue("visible");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(native = true) {
  const [tasks, setTasks] = createSignal<TaskListItem[]>(
    [],
  );
  const id = `clipboard-${++sequence}`;
  const toastId = `clipboard-transfer:${id}`;
  const activeNotification = `${toastId}:active`;
  const session = {
    show: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  let respond!: (action: NotificationAction) => void;
  const platform: SystemNotifications = {
    capabilities: vi.fn(async () => ({
      permission: "granted" as const,
      actions: true,
      reply: false,
    })),
    requestPermission: vi.fn(),
    watch: vi.fn(async (receive) => {
      respond = receive;
      return session;
    }),
  };
  const preferences = { ...defaultNotificationOptions };
  const service = native
    ? new NotificationService(
        platform,
        () => preferences,
        () => focused,
        vi.fn(),
      )
    : undefined;
  const openTasks = vi.fn();
  const loading = vi.spyOn(toast, "loading");
  const success = vi.spyOn(toast, "success");
  const error = vi.spyOn(toast, "error");
  const dismiss = vi.spyOn(toast, "dismiss");
  const update = (change: Partial<SharedFileTask>) =>
    setTasks((items) =>
      items.map((task) =>
        task.id === id
          ? ({ ...task, ...change } as TaskListItem)
          : task,
      ),
    );
  const cancel = vi.fn(async () => {
    update({ status: "cancelled" });
  });
  const task: TaskListItem & SharedFileTask = {
    id,
    peerId: "peer",
    createdAt: Date.now(),
    statusChangedAt: Date.now(),
    kind: "file-send",
    status: "waiting",
    shared: true,
    origin: "clipboard",
    fileId: "file",
    fileName: "Clipboard",
    bytes: 0,
    total: 1048576,
    canPause: false,
    pause() {},
    resume: async () => {},
    cancel,
  };
  const view = render(() => {
    createRemoteTransferFeedback({
      tasks,
      notifications: service,
      openTasks,
    });
    return <Toaster theme="light" />;
  });
  const focus = (next: boolean) => {
    focused = next;
    window.dispatchEvent(
      new Event(next ? "focus" : "blur"),
    );
  };
  return {
    id,
    toastId,
    activeNotification,
    task,
    setTasks,
    update,
    cancel,
    session,
    platform,
    preferences,
    openTasks,
    loading,
    success,
    error,
    dismiss,
    focus,
    respond: (
      action: string,
      notification = activeNotification,
    ) => respond({ id: notification, action }),
    close: () => {
      view.unmount();
      service?.close();
    },
  };
}
it("uses the shared feedback for file drop tasks and reports native acceptance", async () => {
  const s = setup(false);
  s.setTasks([{ ...s.task, origin: "drop" }]);
  expect(s.loading).toHaveBeenLastCalledWith(
    "remote_control.file_drop.sending",
    expect.anything(),
  );
  s.update({ status: "finalizing" });
  expect(s.loading).toHaveBeenLastCalledWith(
    "remote_control.file_drop.finalizing",
    expect.anything(),
  );
  s.update({ status: "completed" });
  expect(s.success).toHaveBeenLastCalledWith(
    "remote_control.file_drop.completed",
    expect.anything(),
  );
  s.close();
});
it("shows progress in one cancellable loading toast without native notifications", async () => {
  const s = setup(false);
  s.setTasks([s.task]);
  const button = await screen.findByRole("button", {
    name: "common.action.cancel",
  });
  expect(s.loading).toHaveBeenLastCalledWith(
    "remote_control.clipboard_transfer.sending",
    expect.objectContaining({
      id: s.toastId,
      duration: Infinity,
    }),
  );
  s.update({ status: "running", bytes: 524288 });
  expect(s.loading).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      id: s.toastId,
      description: "512.00 KB / 1.00 MB",
    }),
  );
  fireEvent.click(button);
  expect(s.cancel).toHaveBeenCalledOnce();
  expect(s.dismiss).toHaveBeenCalledWith(s.toastId);
  expect(s.success).not.toHaveBeenCalled();
  expect(s.error).not.toHaveBeenCalled();
  s.close();
});
it("keeps finalization visible and replaces loading with one terminal result", async () => {
  const s = setup();
  s.setTasks([s.task]);
  s.update({ status: "finalizing", bytes: s.task.total });
  expect(s.loading).toHaveBeenLastCalledWith(
    "remote_control.clipboard_transfer.finalizing",
    expect.objectContaining({ id: s.toastId }),
  );
  s.update({ status: "completed" });
  expect(s.success).toHaveBeenCalledOnce();
  expect(s.success).toHaveBeenCalledWith(
    "remote_control.clipboard_transfer.completed",
    expect.objectContaining({
      id: s.toastId,
      action: undefined,
      duration: 4000,
    }),
  );
  s.update({ status: "completed" });
  expect(s.success).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "common.action.cancel",
      }),
    ).toBeNull(),
  );
  expect(s.session.show).not.toHaveBeenCalled();
  s.close();
});
it("does not replay finished history or handle unrelated file tasks", () => {
  const s = setup();
  s.setTasks([{ ...s.task, status: "completed" }]);
  s.setTasks([{ ...s.task, origin: undefined }]);
  expect(s.loading).not.toHaveBeenCalled();
  expect(s.success).not.toHaveBeenCalled();
  expect(s.session.show).not.toHaveBeenCalled();
  s.close();
});
it("shows one background start notification, supports cancellation, and ignores stale callbacks", async () => {
  const s = setup();
  s.focus(false);
  s.setTasks([s.task]);
  await waitFor(() =>
    expect(s.session.show).toHaveBeenCalledOnce(),
  );
  expect(s.session.show).toHaveBeenCalledWith(
    expect.objectContaining({
      id: s.activeNotification,
      actions: [
        { id: "cancel", title: "common.action.cancel" },
      ],
    }),
  );
  s.update({ status: "running", bytes: 524288 });
  s.update({ status: "finalizing", bytes: s.task.total });
  expect(s.session.show).toHaveBeenCalledOnce();
  s.respond("cancel");
  s.respond("cancel");
  expect(s.cancel).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(s.session.dismiss).toHaveBeenCalledWith(
      s.activeNotification,
    ),
  );
  expect(s.loading).not.toHaveBeenCalled();
  expect(s.error).not.toHaveBeenCalled();
  s.close();
});
it.each(["completed", "failed"] as const)(
  "replaces a background loading notification with %s and opens the task list",
  async (status) => {
    const s = setup();
    s.focus(false);
    s.setTasks([s.task]);
    await waitFor(() =>
      expect(s.session.show).toHaveBeenCalledOnce(),
    );
    s.update({ status });
    await waitFor(() =>
      expect(s.session.show).toHaveBeenCalledTimes(2),
    );
    expect(s.session.dismiss).toHaveBeenCalledWith(
      s.activeNotification,
    );
    expect(s.session.show).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: `${s.toastId}:${status}`,
        title: `remote_control.clipboard_transfer.${status}`,
        actions: undefined,
      }),
    );
    s.respond("open", `${s.toastId}:${status}`);
    expect(s.openTasks).toHaveBeenCalledOnce();
    expect(s.loading).not.toHaveBeenCalled();
    s.close();
  },
);
it("switches between foreground and background and cleans up without cancelling the transfer", async () => {
  const s = setup();
  s.setTasks([s.task]);
  expect(s.loading).toHaveBeenCalledOnce();
  s.focus(false);
  await waitFor(() =>
    expect(s.session.show).toHaveBeenCalledOnce(),
  );
  expect(s.dismiss).toHaveBeenCalledWith(s.toastId);
  s.focus(true);
  expect(s.loading).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(s.session.dismiss).toHaveBeenCalledWith(
      s.activeNotification,
    ),
  );
  s.update({ status: "failed" });
  expect(s.error).toHaveBeenCalledWith(
    "remote_control.clipboard_transfer.failed",
    expect.objectContaining({ id: s.toastId }),
  );
  s.close();
  s.respond("cancel");
  expect(s.cancel).not.toHaveBeenCalled();
  const calls = s.loading.mock.calls.length;
  s.focus(false);
  s.focus(true);
  expect(s.loading).toHaveBeenCalledTimes(calls);
});
it("respects transfer notification settings and never prompts for permission", async () => {
  const s = setup();
  s.preferences.transfers = false;
  s.focus(false);
  s.setTasks([s.task]);
  await Promise.resolve();
  expect(s.session.show).not.toHaveBeenCalled();
  expect(
    s.platform.requestPermission,
  ).not.toHaveBeenCalled();
  s.focus(true);
  expect(s.loading).toHaveBeenCalledOnce();
  s.close();
});
