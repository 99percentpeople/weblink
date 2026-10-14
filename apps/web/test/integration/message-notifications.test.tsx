// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import type { JSX } from "solid-js";
import type { NotificationAction } from "@weblink/platform";
import type { StoreMessage } from "@/libs/domain/message";
import { SystemNotificationBridge } from "@/components/app/system-notifications";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const mocks = vi.hoisted(() => ({
  systemAvailable: true,
  capabilities: vi.fn(),
  requestPermission: vi.fn(),
  watch: vi.fn(),
  show: vi.fn(),
  dismiss: vi.fn(),
  close: vi.fn(),
  info: vi.fn(),
  toastDismiss: vi.fn(),
  showApp: vi.fn(),
  navigate: vi.fn(),
  stored: vi.fn(),
  unsubscribe: vi.fn(),
  watchVisibility: vi.fn(),
  unwatchVisibility: vi.fn(),
  avatar: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    get notifications() {
      return mocks.systemAvailable
        ? {
            capabilities: mocks.capabilities,
            requestPermission: mocks.requestPermission,
            watch: mocks.watch,
          }
        : undefined;
    },
    watchVisibility: mocks.watchVisibility,
    application: { show: mocks.showApp },
  },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    speedTestApproval: () => undefined,
    tasks: { tasks: () => [] },
  }),
}));
vi.mock("@/libs/state/app-dialogs-context", () => ({
  useAppDialogs: () => ({ openTasks: vi.fn() }),
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  () => ({
    messageStores: {
      get clients() {
        return appState.message.clients;
      },
      get conversations() {
        return appState.message.conversations;
      },
      onMessageStored: mocks.stored,
    },
  }),
);
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    remoteControl: { status: () => ({ pending: [] }) },
  },
}));
vi.mock(
  "@/libs/application/notifications/notification-avatar",
  () => ({
    renderNotificationAvatar: mocks.avatar,
  }),
);
vi.mock("solid-sonner", () => ({
  toast: {
    info: mocks.info,
    dismiss: mocks.toastDismiss,
    error: vi.fn(),
  },
}));

let hidden = false;
let receiveMessage: (message: StoreMessage) => void;
let receiveAction: (action: NotificationAction) => void;
let nativeVisibility: (visible: boolean) => void;
const granted = {
  permission: "granted",
  actions: true,
  reply: true,
} as const;
const incoming: StoreMessage = {
  id: "message-1",
  type: "text",
  client: "peer",
  target: "self",
  conversationId: "private",
  status: "received",
  createdAt: 1,
  data: "Hello",
};
async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
function visibility(value: boolean) {
  hidden = !value;
  document.dispatchEvent(new Event("visibilitychange"));
}
function toastOptions() {
  return mocks.info.mock.calls.at(-1)![1] as {
    description(): JSX.Element;
    action: { onClick(): void };
    onAutoClose(): void;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.systemAvailable = true;
  hidden = false;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockImplementation(
    () => hidden,
  );
  vi.spyOn(
    document,
    "visibilityState",
    "get",
  ).mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "self");
  setAppState("message", "clients", [
    { clientId: "peer", name: "Alice", avatar: null },
  ]);
  setAppState("message", "conversations", [
    {
      id: "private",
      kind: "direct",
      peerId: "peer",
      title: "Alice",
      labelIds: [],
      createdAt: 1,
    },
  ]);
  mocks.capabilities.mockResolvedValue(granted);
  mocks.avatar.mockResolvedValue(
    "data:image/png;base64,avatar",
  );
  mocks.show.mockResolvedValue(undefined);
  mocks.dismiss.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.showApp.mockResolvedValue(undefined);
  mocks.stored.mockImplementation((listener) => {
    receiveMessage = listener;
    return mocks.unsubscribe;
  });
  mocks.watch.mockImplementation(async (listener) => {
    receiveAction = listener;
    return {
      show: mocks.show,
      dismiss: mocks.dismiss,
      close: mocks.close,
    };
  });
  mocks.watchVisibility.mockImplementation((listener) => {
    nativeVisibility = listener;
    listener(true);
    return mocks.unwatchVisibility;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  [true, true],
  [false, true],
  [true, false],
  [false, false],
])(
  "uses one in-app toast for visible messages (focused=%s, backgroundOnly=%s)",
  async (focused, backgroundOnly) => {
    vi.mocked(document.hasFocus).mockReturnValue(focused);
    setAppState(
      "options",
      "notifications",
      "backgroundOnly",
      backgroundOnly,
    );
    render(() => <SystemNotificationBridge />);
    receiveMessage(incoming);
    receiveMessage(incoming);
    await flush();
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith(
      "Alice",
      expect.objectContaining({ id: "message:message-1" }),
    );
    expect(
      render(toastOptions().description).container
        .textContent,
    ).toBe("Hello");
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
    expect(mocks.avatar).not.toHaveBeenCalled();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
    toastOptions().action.onClick();
    toastOptions().action.onClick();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/?panel=chat&conversation=private",
    );
    expect(mocks.showApp).toHaveBeenCalledOnce();
  },
);

it.each(["document", "native"])(
  "uses system notifications when %s visibility is hidden, retaining click-to-open after restoring",
  async (source) => {
    render(() => <SystemNotificationBridge />);
    if (source === "document") visibility(false);
    else nativeVisibility(false);
    receiveMessage(incoming);
    await flush();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "message:message-1",
        title: "Alice",
        body: "Hello",
        silent: false,
      }),
    );
    visibility(true);
    nativeVisibility(true);
    receiveAction({
      id: "message:message-1",
      action: "open",
    });
    expect(mocks.navigate).toHaveBeenCalledOnce();
  },
);

it("shows visible messages even without a system notification adapter", async () => {
  mocks.systemAvailable = false;
  const view = render(() => <SystemNotificationBridge />);
  receiveMessage(incoming);
  await flush();
  expect(mocks.info).toHaveBeenCalledOnce();
  view.unmount();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.toastDismiss).toHaveBeenCalledWith(
    "message:message-1",
  );
  expect(mocks.unwatchVisibility).toHaveBeenCalledOnce();
});

it.each(["enabled", "messages"] as const)(
  "respects the %s preference for both channels",
  async (key) => {
    setAppState("options", "notifications", key, false);
    render(() => <SystemNotificationBridge />);
    receiveMessage(incoming);
    visibility(false);
    receiveMessage({ ...incoming, id: "message-2" });
    await flush();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  },
);

it("keeps room identities and respects preview privacy in the in-app toast", async () => {
  setAppState("message", "conversations", [
    {
      id: "room",
      kind: "room",
      roomId: "team",
      namespace: "test",
      title: "Team",
      createdAt: 1,
      labelIds: [],
    },
  ]);
  render(() => <SystemNotificationBridge />);
  const message = {
    ...incoming,
    conversationId: "room",
    room: {
      roomId: "team",
      senderName: "Bob",
      senderAvatar: null,
    },
  };
  receiveMessage(message);
  await flush();
  expect(mocks.info.mock.calls[0][0]).toBe("Bob · Team");
  setAppState("options", "notifications", "preview", false);
  expect(mocks.toastDismiss).toHaveBeenCalledWith(
    "message:message-1",
  );
  receiveMessage({ ...message, id: "private-preview" });
  await flush();
  expect(mocks.info.mock.calls.at(-1)![0]).toBe(
    "setting.notifications.new_message",
  );
  expect(
    render(toastOptions().description).container
      .textContent,
  ).toBe("setting.notifications.new_message");
});

it.each([
  "preferences",
  "identity",
  "conversation",
  "background",
  "unmount",
])(
  "dismisses stale in-app messages after %s and ignores their old actions",
  async (reason) => {
    const view = render(() => <SystemNotificationBridge />);
    receiveMessage(incoming);
    await flush();
    const action = toastOptions().action.onClick;
    if (reason === "preferences")
      setAppState(
        "options",
        "notifications",
        "messages",
        false,
      );
    if (reason === "identity")
      setAppState("profile", "clientId", "someone-else");
    if (reason === "conversation")
      setAppState("message", "conversations", []);
    if (reason === "background") visibility(false);
    if (reason === "unmount") view.unmount();
    await flush();
    expect(mocks.toastDismiss).toHaveBeenCalledWith(
      "message:message-1",
    );
    action();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  },
);

it.each(["permission", "avatar", "dispatch"])(
  "suppresses a late system notification when returning to the foreground during %s",
  async (stage) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (stage === "permission")
      mocks.capabilities.mockReturnValue(
        pending.then(() => granted),
      );
    if (stage === "avatar")
      mocks.avatar.mockReturnValue(
        pending.then(() => "data:image/png;base64,avatar"),
      );
    if (stage === "dispatch")
      mocks.show.mockReturnValue(pending);
    setAppState(
      "options",
      "notifications",
      "backgroundOnly",
      false,
    );
    render(() => <SystemNotificationBridge />);
    visibility(false);
    receiveMessage(incoming);
    await flush();
    visibility(true);
    finish();
    await flush();
    if (stage === "dispatch")
      expect(mocks.dismiss).toHaveBeenCalledWith(
        "message:message-1",
      );
    else expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  },
);

it("ignores locally sent and misdirected messages", async () => {
  render(() => <SystemNotificationBridge />);
  receiveMessage({
    ...incoming,
    client: "self",
    target: "peer",
  });
  receiveMessage({ ...incoming, target: "another-client" });
  await flush();
  expect(mocks.info).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
});
