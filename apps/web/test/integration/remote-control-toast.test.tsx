// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
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
import { createSignal, onCleanup, Show } from "solid-js";
import { toast, Toaster } from "solid-sonner";
import { RemoteControlStatus } from "@/components/app/remote-control-status";
import { MeetingSharingStatus } from "@/routes/home/components/meeting-sharing-status";
import { MeetingControlStatus } from "@/routes/home/components/meeting-control-status";
import type { NativeControlStatus } from "@weblink/platform";
import type {
  NotificationAction,
  SystemNotification,
} from "@weblink/platform";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";
import { ModalProvider } from "@/components/dialogs/base";

const fixture = vi.hoisted(() => ({
  status: undefined as any,
  approve: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/components/icons", () => ({
  IconStop: () => <svg />,
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    remoteControl: {
      status: () => fixture.status(),
      approve: fixture.approve,
      revoke: fixture.revoke,
    },
  },
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    options: {
      notifications: { preview: true },
      remoteKeyboard: { emergencyShortcut: "ctrl-alt-f8" },
    },
    session: {
      clientViewData: { peer: { name: "Alice" } },
    },
  },
}));
vi.mock("@/i18n", () => ({
  t: (
    key: string,
    values?: { name?: string; shortcut?: string },
  ) =>
    values
      ? `${key}: ${values.name ?? values.shortcut}`
      : key,
}));
let setStatus: (status: NativeControlStatus) => void;
const request = (
  consentId = "first",
): NativeControlStatus => ({
  closed: false,
  clientId: null,
  pending: [
    {
      consentId,
      clientId: "peer",
      sourceId: "screen",
    },
  ],
});
let animationStyle: HTMLStyleElement;
beforeEach(() => {
  // jsdom has no exit animation events; keep modal lifecycle checks synchronous.
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  [fixture.status, setStatus] =
    createSignal<NativeControlStatus>({
      closed: false,
      pending: [],
      clientId: null,
    });
  fixture.approve.mockReset().mockResolvedValue(undefined);
  fixture.revoke.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount({
  visible = true,
  native = false,
  enabled = true,
} = {}) {
  const show = vi.fn(
    async (_notification: SystemNotification) => {},
  );
  const dismiss = vi.fn(async () => {});
  const showApplication = vi.fn(() => {
    visible = true;
    service.reconcile();
  });
  let receive!: (action: NotificationAction) => void;
  const service = new NotificationService(
    native
      ? {
          capabilities: async () => ({
            permission: "granted",
            actions: false,
            reply: false,
          }),
          requestPermission: vi.fn(),
          watch: async (listener) => {
            receive = listener;
            return { show, dismiss, close: vi.fn() };
          },
        }
      : undefined,
    () => ({ ...defaultNotificationOptions, enabled }),
    () => visible,
    vi.fn(),
  );
  const view = render(() => {
    onCleanup(() => service.close());
    return (
      <ModalProvider>
        <Toaster theme="light" />
        <RemoteControlStatus
          notifications={service}
          showApplication={showApplication}
        />
      </ModalProvider>
    );
  });
  return {
    ...view,
    show,
    dismiss,
    showApplication,
    setVisible(value: boolean) {
      visible = value;
      service.reconcile();
    },
    open(id: string) {
      receive({ id: `control:${id}`, action: "open" });
    },
  };
}
it("shows a non-modal actionable request once across status polls and expires it without answering", async () => {
  const view = mount();
  setStatus(request("expire-first"));
  const allow = await screen.findByRole("button", {
    name: "remote_control.allow",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByText(
      "remote_control.request_description: Alice",
    ),
  ).toBeVisible();
  setStatus(request("expire-first"));
  setStatus(request("expire-first"));
  expect(
    screen.getByRole("button", {
      name: "remote_control.allow",
    }),
  ).toBe(allow);
  expect(
    toast
      .getToasts()
      .filter(
        (t) => t.id === "remote-control:expire-first",
      ),
  ).toHaveLength(1);
  setStatus({
    closed: false,
    pending: [],
    clientId: null,
  });
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .some(
          (t) => t.id === "remote-control:expire-first",
        ),
    ).toBe(false),
  );
  fireEvent.click(allow); // A stale animation node cannot answer a later request.
  expect(fixture.approve).not.toHaveBeenCalled();
  setStatus(request("expire-second"));
  await screen.findByRole("button", {
    name: "remote_control.allow",
  });
  view.unmount();
  expect(
    toast
      .getToasts()
      .filter((t) =>
        String(t.id).startsWith("remote-control:"),
      ),
  ).toHaveLength(0);
});
it("locks both actions while approval is pending and cannot dismiss a replacement request", async () => {
  let finish!: () => void;
  fixture.approve.mockImplementation(
    () =>
      new Promise<void>((resolve) => (finish = resolve)),
  );
  mount();
  setStatus(request());
  const allow = await screen.findByRole("button", {
    name: "remote_control.allow",
  });
  fireEvent.click(allow);
  fireEvent.click(allow);
  expect(fixture.approve).toHaveBeenCalledTimes(1);
  expect(fixture.approve).toHaveBeenCalledWith(
    "first",
    true,
  );
  expect(allow).toBeDisabled();
  expect(
    screen.getByRole("button", {
      name: "remote_control.decline",
    }),
  ).toBeDisabled();
  setStatus(request("second"));
  finish();
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .some((t) => t.id === "remote-control:second"),
    ).toBe(true),
  );
  expect(fixture.approve).toHaveBeenCalledTimes(1);
});
it("retains a failed request for retry and declines only that consent ID", async () => {
  fixture.approve.mockRejectedValueOnce(
    new Error("unavailable"),
  );
  mount();
  setStatus(request("retry"));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "remote_control.allow",
    }),
  );
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("remote_control.approval_failed");
  const decline = screen.getByRole("button", {
    name: "remote_control.decline",
  });
  expect(decline).not.toBeDisabled();
  fireEvent.click(decline);
  await waitFor(() =>
    expect(fixture.approve).toHaveBeenLastCalledWith(
      "retry",
      false,
    ),
  );
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .some((t) => t.id === "remote-control:retry"),
    ).toBe(false),
  );
});

it("keeps host control actions independent of sharing and prevents duplicate revokes", async () => {
  let finish: () => void;
  const revoke = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const [controller, setController] = createSignal<{
    name: string;
    revoke(): Promise<void>;
  }>();
  const stop = vi.fn();
  render(() => (
    <>
      <MeetingSharingStatus
        name="Host"
        count={1}
        onStop={stop}
        audioAvailable={false}
        audioOn={false}
        onAudioChange={() => {}}
      />
      <Show when={controller()}>
        {(active) => (
          <MeetingControlStatus
            name={active().name}
            emergencyShortcut="ctrl-alt-f8"
            revoke={active().revoke}
          />
        )}
      </Show>
    </>
  ));
  expect(
    screen.queryByRole("button", {
      name: "remote_control.revoke",
    }),
  ).toBeNull();
  setController({ name: "Alice", revoke });
  expect(
    screen.getByRole("status", {
      name: "remote_control.host_active: Alice",
    }),
  ).toHaveTextContent("Alice");
  const button = screen.getByRole("button", {
    name: "remote_control.revoke",
  });
  expect(button).toHaveAttribute(
    "title",
    "remote_control.revoke · Ctrl + Alt + F8",
  );
  fireEvent.click(button);
  fireEvent.click(button);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(stop).not.toHaveBeenCalled();
  finish!();
  await waitFor(() => expect(button).not.toBeDisabled());
  setController(undefined);
  expect(
    screen.queryByRole("button", {
      name: "remote_control.revoke",
    }),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "meeting.stop_sharing",
    }),
  ).toBeVisible();
});

it("toggles shared audio from the status icon and preserves availability and busy guards", async () => {
  const [audio, setAudio] = createSignal(false);
  const [available, setAvailable] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const changed = vi.fn((enabled: boolean) =>
    setAudio(enabled),
  );
  const stop = vi.fn();
  render(() => (
    <MeetingSharingStatus
      name="Host"
      count={1}
      audioOn={audio()}
      audioAvailable={available()}
      busy={busy()}
      onAudioChange={changed}
      onStop={stop}
    />
  ));
  const user = userEvent.setup();
  const toggle = screen.getByRole("switch", {
    name: "meeting.sharing_audio",
  });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toHaveAttribute(
    "title",
    "meeting.enable_sharing_audio",
  );
  await user.click(toggle);
  expect(changed).toHaveBeenLastCalledWith(true);
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toHaveAttribute(
    "title",
    "meeting.mute_sharing_audio",
  );
  // A native button keeps the icon-only switch keyboard accessible.
  await user.keyboard(" ");
  expect(changed).toHaveBeenLastCalledWith(false);
  setAvailable(false);
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute(
    "title",
    "meeting.sharing_audio_unavailable",
  );
  await user.click(toggle);
  expect(changed).toHaveBeenCalledTimes(2);
  setAvailable(true);
  setBusy(true);
  const stopping = screen.getByRole("button", {
    name: "meeting.stop_sharing",
  });
  expect(toggle).toBeDisabled();
  expect(stopping).toBeDisabled();
  await user.click(stopping);
  expect(stop).not.toHaveBeenCalled();
  setBusy(false);
  await user.click(stopping);
  expect(stop).toHaveBeenCalledOnce();
});

it.each([
  ["remote_control.allow_remember", true],
  ["remote_control.deny_remember", false],
] as const)(
  "uses the approval dropdown for %s",
  async (label, accepted) => {
    mount();
    const id = `remember-${accepted}`;
    setStatus(request(id));
    const menu = await screen.findByRole("button", {
      name: "remote_control.more_choices",
    });
    const user = userEvent.setup();
    await user.click(menu);
    const item = await screen.findByRole("menuitem", {
      name: label,
    });
    await user.click(item);
    await waitFor(() =>
      expect(fixture.approve).toHaveBeenCalledWith(
        id,
        accepted,
        true,
      ),
    );
    expect(fixture.approve).toHaveBeenCalledTimes(1);
  },
);

it("shows each concurrent request and lets the host choose the second without answering stale notices", async () => {
  mount();
  const alice = request("alice").pending[0];
  const bob = {
    ...request("bob").pending[0],
    clientId: "bob",
  };
  setStatus({
    closed: false,
    clientId: null,
    pending: [alice, bob],
  });
  const buttons = await screen.findAllByRole("button", {
    name: "remote_control.allow",
  });
  expect(buttons).toHaveLength(2);
  fixture.approve.mockImplementation(async () => {
    setStatus({
      closed: false,
      clientId: "bob",
      pending: [],
    });
  });
  const second = screen
    .getByText("remote_control.request_description: bob")
    .closest("[data-sonner-toast]")!;
  fireEvent.click(
    second.querySelector("button[data-action]")!,
  );
  expect(fixture.approve).toHaveBeenCalledWith("bob", true);
  fireEvent.click(
    buttons.find((button) => !second.contains(button))!,
  );
  expect(fixture.approve).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .filter((t) =>
          String(t.id).startsWith("remote-control:"),
        ),
    ).toHaveLength(0),
  );
});

it("does not send a background notice after the same request already appeared as a toast", async () => {
  const view = mount({ native: true });
  setStatus(request("toast-first"));
  const allow = await screen.findByRole("button", {
    name: "remote_control.allow",
  });
  view.setVisible(false);
  setStatus(request("toast-first"));
  await Promise.resolve();
  view.setVisible(true);
  expect(view.show).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", {
      name: "remote_control.allow",
    }),
  ).toBe(allow);
});

it.each([true, false])(
  "opens the existing request toast from a system notification without buttons (accepted=%s)",
  async (accepted) => {
    const view = mount({ native: true, visible: false });
    const id = `browser-${accepted}`;
    setStatus(request(id));
    await waitFor(() =>
      expect(view.show).toHaveBeenCalledOnce(),
    );
    expect(
      view.show.mock.calls[0][0].actions,
    ).toBeUndefined();
    view.setVisible(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      toast
        .getToasts()
        .some((item) => item.id === `remote-control:${id}`),
    ).toBe(false);
    view.open(id);
    expect(
      await screen.findByRole("button", {
        name: "remote_control.more_choices",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.showApplication).toHaveBeenCalledOnce();
    expect(fixture.approve).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: accepted
          ? "remote_control.allow"
          : "remote_control.decline",
      }),
    );
    expect(fixture.approve).toHaveBeenCalledOnce();
    expect(fixture.approve).toHaveBeenCalledWith(
      id,
      accepted,
    );
    await waitFor(() =>
      expect(
        toast
          .getToasts()
          .some(
            (item) => item.id === `remote-control:${id}`,
          ),
      ).toBe(false),
    );
    view.setVisible(false);
    view.setVisible(true);
    view.open(id);
    expect(view.show).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      toast
        .getToasts()
        .some((item) => item.id === `remote-control:${id}`),
    ).toBe(false);
  },
);

it("closes a notification-opened confirmation when its exact request expires", async () => {
  const view = mount({ native: true, visible: false });
  setStatus(request("browser-expired"));
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  view.open("browser-expired");
  const allow = await screen.findByRole("button", {
    name: "remote_control.allow",
  });
  setStatus({ closed: false, clientId: null, pending: [] });
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .some(
          (item) =>
            item.id === "remote-control:browser-expired",
        ),
    ).toBe(false),
  );
  fireEvent.click(allow);
  expect(fixture.approve).not.toHaveBeenCalled();
});

it("retains remembered decisions in the request toast opened from the system notification", async () => {
  const view = mount({ native: true, visible: false });
  setStatus(request("remember-from-system"));
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  view.open("remember-from-system");
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "remote_control.more_choices",
    }),
  );
  await user.click(
    await screen.findByRole("menuitem", {
      name: "remote_control.allow_remember",
    }),
  );
  expect(fixture.approve).toHaveBeenCalledWith(
    "remember-from-system",
    true,
    true,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
