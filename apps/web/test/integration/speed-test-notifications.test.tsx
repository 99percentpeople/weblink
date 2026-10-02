// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import type {
  NotificationAction,
  NotificationCapabilities,
  SystemNotification,
} from "@weblink/platform";
import { SystemNotificationBridge } from "@/components/app/system-notifications";
import { createSpeedTestApproval } from "@/components/speed-test-approval";
import { useAppState } from "@/libs/state/app-state-context";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  requestPermission: vi.fn(),
  watch: vi.fn(),
  show: vi.fn(),
  dismiss: vi.fn(),
  close: vi.fn(),
  info: vi.fn(),
  toastDismiss: vi.fn(),
  showApp: vi.fn(),
  openDetails: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: { name?: string }) =>
    values?.name ? `${key}: ${values.name}` : key,
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    notifications: {
      capabilities: mocks.capabilities,
      requestPermission: mocks.requestPermission,
      watch: mocks.watch,
    },
    application: { show: mocks.showApp },
  },
}));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/libs/state/app-dialogs-context", () => ({
  useAppDialogs: () => ({ openTasks: vi.fn() }),
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  () => ({
    messageStores: {
      clients: [],
      conversations: [],
      onMessageStored: () => mocks.unsubscribe,
    },
  }),
);
vi.mock("@/libs/application/session-service", () => ({
  sessionService: { remoteControl: { status: () => ({}) } },
}));
vi.mock("solid-sonner", () => ({
  toast: {
    info: mocks.info,
    dismiss: mocks.toastDismiss,
    error: vi.fn(),
  },
}));
vi.mock(
  "@/components/dialogs/client-info-dialog-events",
  () => ({
    CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT:
      "weblink:client-info-dialog-tab-visible",
    requestClientInfoDialog: mocks.openDetails,
  }),
);

let controller: ReturnType<typeof createSpeedTestApproval>;
let receive: (action: NotificationAction) => void;
const granted: NotificationCapabilities = {
  permission: "granted",
  actions: true,
  reply: false,
};
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function begin() {
  const abort = new AbortController();
  const result = controller.request(
    "peer",
    "Alice",
    abort.signal,
  );
  return { abort, result, request: controller.pending()! };
}
function action(id: string, action: string) {
  receive({ id: `speed-test:${id}`, action });
}

beforeEach(() => {
  vi.resetAllMocks();
  setAppState(reconcile(createInitialAppState()));
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(
    document,
    "visibilityState",
    "get",
  ).mockReturnValue("visible");
  mocks.capabilities.mockResolvedValue(granted);
  mocks.show.mockResolvedValue(undefined);
  mocks.dismiss.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.showApp.mockResolvedValue(undefined);
  mocks.info.mockReturnValue("request-toast");
  mocks.watch.mockImplementation(async (listener) => {
    receive = listener;
    return {
      show: mocks.show,
      dismiss: mocks.dismiss,
      close: mocks.close,
    };
  });
  controller = createSpeedTestApproval();
  vi.mocked(useAppState).mockReturnValue({
    speedTestApproval: controller.pending,
    tasks: { tasks: () => [] },
  } as unknown as ReturnType<typeof useAppState>);
});
afterEach(() => {
  cleanup();
  controller.decline("peer");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["approve", "decline"])(
  "settles the original request once via %s and retracts both notices",
  async (choice) => {
    render(() => <SystemNotificationBridge />);
    const { result, request } = begin();
    await flush();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `speed-test:${request.id}`,
        expiresAt: request.expiresAt,
        body: "speed_test.request: Alice",
        silent: false,
        actions: [
          { id: "approve", title: "speed_test.accept" },
          { id: "decline", title: "speed_test.decline" },
        ],
      }),
    );
    action(request.id, choice);
    action(
      request.id,
      choice === "approve" ? "decline" : "approve",
    );
    await expect(result).resolves.toBe(
      choice === "approve",
    );
    await flush();
    expect(controller.pending()).toBeUndefined();
    expect(mocks.toastDismiss).toHaveBeenCalledWith(
      "request-toast",
    );
    expect(mocks.dismiss).toHaveBeenCalledWith(
      `speed-test:${request.id}`,
    );
    expect(mocks.openDetails).not.toHaveBeenCalled();
  },
);

it("opens the speed-test panel without approving when browser action buttons are unavailable", async () => {
  mocks.capabilities.mockResolvedValue({
    ...granted,
    actions: false,
  });
  render(() => <SystemNotificationBridge />);
  const { result, request } = begin();
  await flush();
  expect(
    mocks.show.mock.calls[0][0].actions,
  ).toBeUndefined();
  action(request.id, "open");
  expect(mocks.openDetails).toHaveBeenCalledWith(
    "peer",
    "speed",
  );
  expect(mocks.showApp).toHaveBeenCalledOnce();
  expect(controller.pending()?.id).toBe(request.id);
  controller.accept("peer");
  await expect(result).resolves.toBe(true);
});

it.each(["panel", "cancel", "timeout"])(
  "retracts the notification after %s and ignores late approval",
  async (reason) => {
    vi.useFakeTimers();
    render(() => <SystemNotificationBridge />);
    const { abort, result, request } = begin();
    await flush();
    if (reason === "panel") controller.decline("peer");
    else if (reason === "cancel") abort.abort();
    else
      vi.advanceTimersByTime(
        request.expiresAt - Date.now(),
      );
    await expect(result).resolves.toBe(false);
    await flush();
    expect(mocks.dismiss).toHaveBeenCalledWith(
      `speed-test:${request.id}`,
    );
    action(request.id, "approve");
    expect(controller.pending()).toBeUndefined();
  },
);

it("cannot use an older notification to approve a new request from the same peer", async () => {
  render(() => <SystemNotificationBridge />);
  const first = begin();
  await flush();
  const second = begin();
  await flush();
  await expect(first.result).resolves.toBe(false);
  action(first.request.id, "approve");
  expect(controller.pending()?.id).toBe(second.request.id);
  action(second.request.id, "decline");
  await expect(second.result).resolves.toBe(false);
});

it.each([
  "disabled",
  "category",
  "focused",
  "denied",
  "default",
  "unavailable",
])(
  "keeps in-app approval usable without system display when %s",
  async (mode) => {
    if (mode === "disabled")
      setAppState(
        "options",
        "notifications",
        "enabled",
        false,
      );
    else if (mode === "category")
      setAppState(
        "options",
        "notifications",
        "speedTestRequests",
        false,
      );
    else if (mode === "focused")
      vi.mocked(document.hasFocus).mockReturnValue(true);
    else
      mocks.capabilities.mockResolvedValue({
        ...granted,
        permission: mode,
      });
    render(() => <SystemNotificationBridge />);
    const { result } = begin();
    await flush();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledOnce();
    controller.accept("peer");
    await expect(result).resolves.toBe(true);
  },
);

it("uses the independent speed-test category and common privacy/sound settings", async () => {
  setAppState(
    "options",
    "notifications",
    "controlRequests",
    false,
  );
  setAppState("options", "notifications", "preview", false);
  setAppState("options", "notifications", "sound", false);
  render(() => <SystemNotificationBridge />);
  const { result, request } = begin();
  await flush();
  const notice = mocks.show.mock
    .calls[0][0] as SystemNotification;
  expect(notice.body).toBe(
    "speed_test.phases.approval_incoming",
  );
  expect(notice.body).not.toContain("Alice");
  expect(notice.silent).toBe(true);
  setAppState(
    "options",
    "notifications",
    "speedTestRequests",
    false,
  );
  await flush();
  expect(mocks.dismiss).toHaveBeenCalledWith(
    `speed-test:${request.id}`,
  );
  action(request.id, "approve");
  expect(controller.pending()).toBeDefined();
  controller.decline("peer");
  await expect(result).resolves.toBe(false);
});

it("does not display a cancelled request after an asynchronous permission query", async () => {
  let finish!: (value: NotificationCapabilities) => void;
  mocks.capabilities.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(() => <SystemNotificationBridge />);
  const { abort, result } = begin();
  abort.abort();
  finish(granted);
  await flush();
  expect(mocks.show).not.toHaveBeenCalled();
  await expect(result).resolves.toBe(false);
});

it("closes the watcher on unmount and prevents a late system action from settling in-app approval", async () => {
  const view = render(() => <SystemNotificationBridge />);
  const { result, request } = begin();
  await flush();
  view.unmount();
  await flush();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  action(request.id, "approve");
  expect(controller.pending()).toBeDefined();
  controller.decline("peer");
  await expect(result).resolves.toBe(false);
});
