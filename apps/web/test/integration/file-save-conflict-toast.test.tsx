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
  within,
} from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { toast, Toaster } from "solid-sonner";
import type {
  FileConflictResolver,
  NotificationAction,
  SystemNotification,
} from "@weblink/platform";
import { createFileSaveConflictResolver } from "@/components/files/file-save-conflict-toast";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";

vi.mock("@/i18n", () => ({
  t: (key: string, params?: { fileName: string }) =>
    params ? `${key}: ${params.fileName}` : key,
}));
beforeEach(() => vi.stubGlobal("scrollTo", vi.fn()));
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

function setup({
  visible = true,
  enabled = true,
  transfers = true,
  preview = true,
  permission = "granted" as "granted" | "denied",
} = {}) {
  const show = vi.fn(
    async (_notification: SystemNotification) => {},
  );
  const dismiss = vi.fn(async () => {});
  const showApplication = vi.fn(async () => {});
  const onWaiting = vi.fn();
  let receive!: (action: NotificationAction) => void;
  const notifications = new NotificationService(
    {
      capabilities: async () => ({
        permission,
        actions: true,
        reply: false,
      }),
      requestPermission: vi.fn(),
      watch: async (listener) => {
        receive = listener;
        return { show, dismiss, close: vi.fn() };
      },
    },
    () => ({
      ...defaultNotificationOptions,
      enabled,
      transfers,
      preview,
    }),
    () => visible,
    vi.fn(),
  );
  let forBatch!: (
    controller?: AbortController,
  ) => FileConflictResolver;
  const view = render(() => {
    const batches: ReturnType<
      typeof createFileSaveConflictResolver
    >[] = [];
    forBatch = (controller = new AbortController()) => {
      const batch = createFileSaveConflictResolver({
        controller,
        notifications,
        preview: () => preview,
        onWaiting,
        showApplication,
      });
      batches.push(batch);
      return batch.resolve;
    };
    onCleanup(() => {
      batches.forEach((batch) => batch.dismiss());
      notifications.close();
    });
    return <Toaster theme="light" />;
  });
  return {
    ...view,
    forBatch,
    show,
    dismiss,
    showApplication,
    onWaiting,
    setVisible(value: boolean) {
      visible = value;
      notifications.reconcile();
    },
    open(id: string) {
      receive({ id, action: "open" });
    },
  };
}
const conflict = (
  fileName = "report.txt",
  canOverwrite = true,
) => ({ fileName, canOverwrite });
const notices = () =>
  toast
    .getToasts()
    .filter((item) =>
      String(item.id).startsWith("file-save-conflict:"),
    );
const prompt = () =>
  screen.getByRole("region", {
    name: "file_save_conflict.title",
  });
const choose = async (action: string) => {
  const notice = prompt();
  fireEvent.click(
    within(notice).getByRole("button", {
      name: `file_save_conflict.${action}`,
    }),
  );
  await waitFor(() =>
    expect(notice).not.toBeInTheDocument(),
  );
};
const applyToAll = () =>
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "file_save_conflict.apply_to_all",
    }),
  );

it.each(["overwrite", "skip", "keep_both"] as const)(
  "asks again for the next conflict when %s is chosen without apply-to-all",
  async (action) => {
    const view = setup();
    const resolver = view.forBatch();
    const first = resolver(conflict());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText(
        "file_save_conflict.description: report.txt",
      ),
    ).toBeInTheDocument();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      duration: Infinity,
      dismissible: false,
    });
    await choose(action);
    expect(await first).toBe(action);
    expect(view.onWaiting.mock.calls).toEqual([
      [true],
      [false],
    ]);
    const second = resolver(conflict("next.txt"));
    expect(
      screen.getByText(
        "file_save_conflict.description: next.txt",
      ),
    ).toBeInTheDocument();
    await choose("skip");
    expect(await second).toBe("skip");
    expect(view.show).not.toHaveBeenCalled();
  },
);

it.each(["overwrite", "skip", "keep_both"] as const)(
  "applies %s to remaining conflicts in this batch and resets for a new batch",
  async (action) => {
    const { forBatch } = setup();
    const resolver = forBatch();
    const first = resolver(conflict());
    applyToAll();
    await choose(action);
    expect(await first).toBe(action);
    expect(await resolver(conflict("next.txt"))).toBe(
      action,
    );
    expect(notices()).toHaveLength(0);
    const controller = new AbortController();
    const another = forBatch(controller)(
      conflict("new-batch.txt"),
    );
    expect(
      screen.getByRole("checkbox", {
        name: "file_save_conflict.apply_to_all",
      }),
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    expect(await another).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  },
);

it("asks again instead of applying overwrite-all to a directory", async () => {
  const resolver = setup().forBatch();
  const first = resolver(conflict());
  applyToAll();
  await choose("overwrite");
  expect(await first).toBe("overwrite");
  const directory = resolver(conflict("folder", false));
  expect(
    screen.getByText(
      "file_save_conflict.cannot_overwrite: folder",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "file_save_conflict.overwrite",
    }),
  ).toBeDisabled();
  await choose("skip");
  expect(await directory).toBe("skip");
  expect(await resolver(conflict("later.txt"))).toBe(
    "overwrite",
  );
});

it("cancels a pending conflict and future prompts when its owner is disposed", async () => {
  const view = setup();
  const resolver = view.forBatch();
  const pending = resolver(conflict());
  expect(prompt()).toBeInTheDocument();
  view.unmount();
  expect(await pending).toBeNull();
  expect(await resolver(conflict())).toBeNull();
  expect(notices()).toHaveLength(0);
});

it("closes a pending conflict when its batch is cancelled and permits a new batch", async () => {
  const view = setup();
  const controller = new AbortController();
  const resolver = view.forBatch(controller);
  const pending = resolver(conflict());
  const oldPrompt = prompt();
  controller.abort();
  expect(await pending).toBeNull();
  expect(await resolver(conflict("later.txt"))).toBeNull();
  await waitFor(() =>
    expect(oldPrompt).not.toBeInTheDocument(),
  );
  const next = view.forBatch()(conflict("retry.txt"));
  expect(
    screen.getByText(
      "file_save_conflict.description: retry.txt",
    ),
  ).toBeInTheDocument();
  await choose("keep_both");
  expect(await next).toBe("keep_both");
});

it("uses the background notification service to open the existing confirmation without choosing an operation", async () => {
  const view = setup({ visible: false });
  const answered = vi.fn();
  const pending = view
    .forBatch()(conflict())
    .then(answered);
  const original = prompt();
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  const notice = view.show.mock.calls[0][0];
  expect(notice).toMatchObject({
    title: "file_save_conflict.title",
    body: "file_save_conflict.description: report.txt",
  });
  expect(notices().map((item) => item.id)).toEqual([
    notice.id,
  ]);
  view.setVisible(true);
  view.open(notice.id);
  await waitFor(() => expect(original).toHaveFocus());
  expect(view.showApplication).toHaveBeenCalledOnce();
  expect(answered).not.toHaveBeenCalled();
  expect(prompt()).toBe(original);
  expect(notices()).toHaveLength(1);
  await choose("keep_both");
  await pending;
  expect(answered).toHaveBeenCalledWith("keep_both");
  expect(view.dismiss).toHaveBeenCalledWith(notice.id);
  view.open(notice.id);
  expect(view.showApplication).toHaveBeenCalledOnce();
});

it.each([
  { enabled: false },
  { transfers: false },
  { permission: "denied" as const },
])(
  "keeps the confirmation usable when background notifications are unavailable: %j",
  async (options) => {
    const view = setup({ visible: false, ...options });
    const pending = view.forBatch()(conflict());
    await choose("skip");
    expect(await pending).toBe("skip");
    expect(view.show).not.toHaveBeenCalled();
  },
);

it("hides the filename in private background notifications and retracts them on cancellation", async () => {
  const view = setup({ visible: false, preview: false });
  const controller = new AbortController();
  const pending = view.forBatch(controller)(
    conflict("private.txt"),
  );
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  const notice = view.show.mock.calls[0][0];
  expect(notice.body).toBe("file_save_conflict.title");
  controller.abort();
  expect(await pending).toBeNull();
  await waitFor(() =>
    expect(view.dismiss).toHaveBeenCalledWith(notice.id),
  );
  view.open(notice.id);
  expect(view.showApplication).not.toHaveBeenCalled();
  expect(notices()).toHaveLength(0);
});
