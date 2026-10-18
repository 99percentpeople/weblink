// @vitest-environment jsdom
import { createRoot } from "solid-js";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { toast } from "solid-sonner";
import type {
  NotificationAction,
  NotificationPermissionState,
  StoredFile,
} from "@weblink/platform";
import type { SavedRecording } from "@/libs/state/create-recording";
import { createRecordingFeedback } from "@/libs/hooks/create-recording-feedback";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { fileOpenLabel } from "@/libs/utils/open-file";

const f = vi.hoisted(() => ({
  platform: {
    openFile: undefined as
      | ((file: StoredFile) => Promise<void>)
      | undefined,
  },
  dialog: vi.fn(),
  openDialog: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: f.platform,
}));
vi.mock("solid-sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/components/dialogs/dialog", () => ({
  createDialog: f.dialog,
}));
vi.mock("@/components/icons", () => ({
  IconDownload: () => null,
  IconShare: () => null,
}));
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  f.platform.openFile = undefined;
  f.openDialog.mockResolvedValue(undefined);
  f.dialog.mockReturnValue({
    open: f.openDialog,
    close: vi.fn(),
    submit: vi.fn(),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup({
  visible = true,
  native = false,
  enabled = true,
  recordings = true,
  preview = true,
  sound = true,
  permission = "granted" as NotificationPermissionState,
  actions = true,
} = {}) {
  const preferences = {
    ...defaultNotificationOptions,
    enabled,
    recordings,
    preview,
    sound,
  };
  const file = new File(["video"], "screen.mp4", {
    type: "video/mp4",
  });
  const readFile = vi
    .fn<() => Promise<StoredFile | null>>()
    .mockResolvedValue(file);
  const show = vi.fn().mockResolvedValue(undefined);
  const dismiss = vi.fn().mockResolvedValue(undefined);
  const showApplication = vi.fn(async () => {});
  const unsubscribe = vi.fn();
  let saved!: (value: SavedRecording) => void;
  let action!: (value: NotificationAction) => void;
  if (native) f.platform.openFile = vi.fn(async () => {});
  const service = new NotificationService(
    {
      capabilities: async () => ({
        permission,
        actions,
        reply: false,
      }),
      requestPermission: vi.fn(),
      watch: async (receive) => {
        action = receive;
        return { show, dismiss, close: vi.fn() };
      },
    },
    () => preferences,
    () => visible,
    vi.fn(),
  );
  createRoot((cleanup) => {
    dispose = () => {
      cleanup();
      service.close();
    };
    const dialog = createPreviewDialog();
    createRecordingFeedback({
      recording: {
        onSaved: (listener) => {
          saved = listener;
          return unsubscribe;
        },
      },
      notifications: service,
      preview: () => preferences.preview,
      openLabel: fileOpenLabel,
      readFile,
      openFile: dialog.open,
      showApplication,
    });
  });
  return {
    file,
    readFile,
    show,
    dismiss,
    showApplication,
    unsubscribe,
    preferences,
    service,
    saved: (id = "saved", fileName = "screen.mp4") =>
      saved({ id, fileName }),
    action: (id = "recording-saved:saved") =>
      action({ id, action: "open" }),
    visible: (value: boolean) => {
      visible = value;
      service.reconcile();
    },
  };
}
function openToast(index = 0) {
  const [, options] = vi.mocked(toast.success).mock.calls[
    index
  ];
  const action = options!.action as {
    label: string;
    onClick(): void;
  };
  action.onClick();
  return action;
}

it("shows one foreground completion with a browser preview action and reads the file only on click", async () => {
  const x = setup();
  x.saved();
  x.saved();
  expect(toast.success).toHaveBeenCalledOnce();
  expect(toast.success).toHaveBeenCalledWith(
    "recording.saved",
    expect.objectContaining({ description: "screen.mp4" }),
  );
  expect(x.show).not.toHaveBeenCalled();
  expect(x.readFile).not.toHaveBeenCalled();
  x.visible(false);
  x.visible(true);
  expect(toast.success).toHaveBeenCalledOnce();
  expect(openToast().label).toBe("common.action.preview");
  openToast();
  await waitFor(() =>
    expect(f.openDialog).toHaveBeenCalledOnce(),
  );
  expect(x.readFile).toHaveBeenCalledOnce();
  expect(x.readFile).toHaveBeenCalledWith("saved");
  expect(x.showApplication).toHaveBeenCalledOnce();
  expect(toast.error).not.toHaveBeenCalled();
});

it("delivers one background desktop notice and opens the current file through the system", async () => {
  const x = setup({ visible: false, native: true });
  x.saved();
  await waitFor(() =>
    expect(x.show).toHaveBeenCalledOnce(),
  );
  expect(x.show).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "recording.saved",
      body: "screen.mp4",
      actions: [
        { id: "open", title: "common.action.open" },
      ],
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
  x.visible(true);
  x.action();
  x.action();
  await waitFor(() =>
    expect(f.platform.openFile).toHaveBeenCalledWith(
      x.file,
    ),
  );
  expect(f.platform.openFile).toHaveBeenCalledOnce();
  expect(x.readFile).toHaveBeenCalledOnce();
  expect(x.readFile).toHaveBeenCalledWith("saved");
  expect(x.showApplication).toHaveBeenCalledOnce();
  expect(f.dialog).not.toHaveBeenCalled();
  expect(f.openDialog).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});

it("opens a browser preview from the notification body when action buttons are unavailable", async () => {
  const x = setup({ visible: false, actions: false });
  x.saved();
  await waitFor(() =>
    expect(x.show).toHaveBeenCalledOnce(),
  );
  expect(x.show.mock.calls[0][0].actions).toBeUndefined();
  x.action();
  await waitFor(() =>
    expect(f.openDialog).toHaveBeenCalledOnce(),
  );
});

it.each([
  { enabled: false },
  { recordings: false },
  { permission: "denied" as const },
])(
  "retains foreground feedback when background delivery is unavailable: %j",
  async (options) => {
    const x = setup({ visible: false, ...options });
    x.saved();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(x.show).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    x.visible(true);
    x.visible(false);
    x.visible(true);
    expect(toast.success).toHaveBeenCalledOnce();
  },
);

it("respects filename privacy and sound preferences", async () => {
  const x = setup({
    visible: false,
    preview: false,
    sound: false,
  });
  x.saved();
  await waitFor(() =>
    expect(x.show).toHaveBeenCalledOnce(),
  );
  expect(x.show).toHaveBeenCalledWith(
    expect.objectContaining({
      body: "recording.saved",
      silent: true,
    }),
  );
  x.visible(true);
  x.saved("next", "private.mp4");
  expect(toast.success).toHaveBeenCalledWith(
    "recording.saved",
    expect.objectContaining({ description: undefined }),
  );
});

it.each([
  null,
  new Error("Storage directory is unavailable"),
])(
  "reports unavailable files on click without reopening a stale saved snapshot: %s",
  async (failure) => {
    const x = setup({ native: true });
    x.saved();
    if (failure) x.readFile.mockRejectedValue(failure);
    else x.readFile.mockResolvedValue(null);
    openToast();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "common.notification.file_open_failed",
      ),
    );
    expect(f.platform.openFile).not.toHaveBeenCalled();
  },
);

it("keeps older completion actions tied to their own file when another recording is saved", async () => {
  const x = setup();
  x.saved("first", "first.mp4");
  x.saved("second", "second.mkv");
  expect(toast.success).toHaveBeenCalledTimes(2);
  openToast(0);
  await waitFor(() =>
    expect(x.readFile).toHaveBeenCalledWith("first"),
  );
});

it("unsubscribes and prevents late open actions after the notification scope is disposed", async () => {
  const x = setup({ native: true });
  let resolve!: (file: StoredFile) => void;
  x.readFile.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  x.saved();
  openToast();
  await waitFor(() =>
    expect(x.readFile).toHaveBeenCalledOnce(),
  );
  dispose?.();
  expect(x.unsubscribe).toHaveBeenCalledOnce();
  resolve(x.file);
  await Promise.resolve();
  expect(f.platform.openFile).not.toHaveBeenCalled();
  x.saved("late");
  expect(toast.success).toHaveBeenCalledOnce();
});
