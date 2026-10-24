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
import userEvent from "@testing-library/user-event";
import {
  createSignal,
  onCleanup,
  type Accessor,
  type Setter,
} from "solid-js";
import { toast, Toaster } from "solid-sonner";
import type { Approval } from "@weblink/automation";
import type {
  NotificationAction,
  SystemNotification,
} from "@weblink/platform";
import { AutomationApprovalToasts } from "@/components/app/automation-approval-toasts";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";
import { ModalProvider } from "@/components/dialogs/base";

const fixture = vi.hoisted(() => ({
  pending: undefined as Accessor<Approval[]> | undefined,
  decide: vi.fn(),
  canReceive: vi.fn(),
  enabled: true,
  ready: true,
  preview: true,
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key}: ${Object.values(values).join(", ")}`
      : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    automation: {
      desktop: true,
      enabled: () => fixture.enabled,
      ready: () => fixture.ready,
      decide: fixture.decide,
      snapshot: () => ({
        pending: fixture.pending?.() ?? [],
      }),
    },
  }),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: { canReceive: fixture.canReceive },
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    options: {
      notifications: {
        get preview() {
          return fixture.preview;
        },
      },
      remoteKeyboard: { emergencyShortcut: "ctrl-alt-f8" },
    },
  },
}));

let setPending: Setter<Approval[]>;
let sequence = 0;
const request = (
  kind: "peer" | "mcp" = "peer",
): Approval => ({
  id: `request-${++sequence}`,
  principal: {
    id: "paired-device",
    kind,
    label: "Device",
    generation: "connection-1",
  },
  scope: "shell.execute",
  tool: "commands.start",
  source: { kind: "mcp", label: "Reported caller" },
  arguments: {
    target: "local",
    script: "echo private-detail",
  },
  expiresAt: Date.now() + 120000,
});
const allowLabel = () => "common.action.allow_session";
beforeEach(() => {
  [fixture.pending, setPending] = createSignal<Approval[]>(
    [],
  );
  fixture.decide.mockReset().mockResolvedValue(undefined);
  fixture.canReceive.mockReset().mockReturnValue(true);
  fixture.enabled = fixture.ready = fixture.preview = true;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
function mount({
  visible = true,
  native = false,
  enabled = true,
} = {}) {
  const show = vi.fn(
    async (_notification: SystemNotification) => {},
  );
  const dismiss = vi.fn(async () => {});
  let receive!: (action: NotificationAction) => void;
  const service = new NotificationService(
    native
      ? {
          capabilities: async () => ({
            permission: "granted",
            actions: true,
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
  const showApplication = vi.fn(() => {
    visible = true;
    service.reconcile();
  });
  const view = render(() => {
    onCleanup(() => service.close());
    return (
      <ModalProvider>
        <Toaster theme="light" />
        <AutomationApprovalToasts
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
    service,
    respond(action: string) {
      receive({
        id: show.mock.calls.at(-1)![0].id,
        action,
      });
    },
    setVisible(value: boolean) {
      visible = value;
      service.reconcile();
    },
  };
}

it.each([false, true])(
  "responds through the in-app notification with session consent %s",
  async (accepted) => {
    mount();
    const pending = request();
    setPending([pending]);
    const allow = await screen.findByRole("button", {
      name: allowLabel(),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText(
        /Device · automation.permissions.terminal.title/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "automation.permissions.terminal.description",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/remote_control.revoke_hint.*F8/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByText("automation.arguments"),
    );
    expect(
      screen.getByText(/echo private-detail/),
    ).toBeVisible();
    expect(
      screen.getByText(/Reported caller/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "automation.duration",
      }),
    ).toBeNull();
    if (accepted) fireEvent.click(allow);
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: "common.action.deny",
        }),
      );
    await waitFor(() =>
      expect(fixture.decide).toHaveBeenCalledWith(
        pending.id,
        accepted,
      ),
    );
    expect(fixture.decide).toHaveBeenCalledOnce();
  },
);

it("explains the read permission group before approving accessibility inspection", async () => {
  mount();
  const pending = {
    ...request(),
    scope: "accessibility.read" as const,
    tool: "accessibility.snapshot",
    arguments: { target: "local", elementId: "window" },
  };
  setPending([pending]);
  const allow = await screen.findByRole("button", {
    name: allowLabel(),
  });
  expect(
    screen.getByText(
      "automation.permissions.read.description",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      /Device · automation.permissions.read.title/,
    ),
  ).toBeVisible();
  fireEvent.click(allow);
  expect(fixture.decide).toHaveBeenCalledWith(
    pending.id,
    true,
  );
});

it("keeps one notification across snapshot refreshes and dismisses resolved requests and unmounts", async () => {
  const view = mount();
  const pending = request();
  setPending([pending]);
  const allow = await screen.findByRole("button", {
    name: allowLabel(),
  });
  setPending([{ ...pending }]);
  expect(
    screen.getByRole("button", { name: allowLabel() }),
  ).toBe(allow);
  setPending([]);
  fireEvent.click(allow);
  expect(fixture.decide).not.toHaveBeenCalled();
  expect(
    toast
      .getToasts()
      .some(
        (t) => t.id === `automation-approval:${pending.id}`,
      ),
  ).toBe(false);
  const next = request();
  setPending([next]);
  view.unmount();
  expect(
    toast
      .getToasts()
      .some(
        (t) => t.id === `automation-approval:${next.id}`,
      ),
  ).toBe(false);
});

it("retries a failed decision and prevents duplicate or conflicting answers while pending", async () => {
  fixture.decide.mockRejectedValueOnce(
    new Error("native unavailable"),
  );
  mount();
  const pending = request();
  setPending([pending]);
  const allow = await screen.findByRole("button", {
    name: allowLabel(),
  });
  fireEvent.click(allow);
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent(
    "common.notification.approval_failed",
  );
  let finish!: () => void;
  fixture.decide.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(allow);
  expect(allow).toBeDisabled();
  const deny = screen.getByRole("button", {
    name: "common.action.deny",
  });
  expect(deny).toBeDisabled();
  fireEvent.click(allow);
  fireEvent.click(deny);
  expect(fixture.decide).toHaveBeenCalledTimes(2);
  finish();
  await waitFor(() =>
    expect(
      toast
        .getToasts()
        .some(
          (t) =>
            t.id === `automation-approval:${pending.id}`,
        ),
    ).toBe(false),
  );
});

it.each(["approve", "decline"])(
  "handles the native %s action once with the request deadline",
  async (action) => {
    const view = mount({ visible: false, native: true });
    const pending = request();
    setPending([pending]);
    await waitFor(() =>
      expect(view.show).toHaveBeenCalledOnce(),
    );
    expect(
      screen.queryByRole("button", { name: allowLabel() }),
    ).toBeNull();
    expect(view.show.mock.calls[0][0]).toMatchObject({
      expiresAt: pending.expiresAt,
      body: "Device · automation.permissions.terminal.title",
      actions: [
        { id: "approve", title: allowLabel() },
        { id: "decline", title: "common.action.deny" },
      ],
    });
    expect(
      JSON.stringify(view.show.mock.calls[0][0]),
    ).not.toContain("private-detail");
    view.respond(action);
    view.respond(action);
    await waitFor(() =>
      expect(fixture.decide).toHaveBeenCalledWith(
        pending.id,
        action === "approve",
      ),
    );
    expect(fixture.decide).toHaveBeenCalledOnce();
  },
);

it("opens a private native notice into the existing in-app approval without granting access", async () => {
  fixture.preview = false;
  const view = mount({ visible: false, native: true });
  setPending([request()]);
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  expect(view.show.mock.calls[0][0].body).toBe(
    "automation.requests",
  );
  view.respond("open");
  view.respond("open");
  expect(view.showApplication).toHaveBeenCalledOnce();
  await screen.findByRole("button", { name: allowLabel() });
  expect(fixture.decide).not.toHaveBeenCalled();
  expect(view.show).toHaveBeenCalledOnce();
});

it("allows a failed native decision to be retried in-app without replaying native callbacks", async () => {
  fixture.decide.mockRejectedValueOnce(
    new Error("native unavailable"),
  );
  const view = mount({ visible: false, native: true });
  const pending = request();
  setPending([pending]);
  await waitFor(() =>
    expect(view.show).toHaveBeenCalledOnce(),
  );
  view.respond("approve");
  view.respond("approve");
  await waitFor(() =>
    expect(
      screen.getByText(
        "common.notification.approval_failed",
      ),
    ).toBeInTheDocument(),
  );
  expect(fixture.decide).toHaveBeenCalledOnce();
  view.setVisible(true);
  const allow = await screen.findByRole("button", {
    name: allowLabel(),
  });
  view.respond("approve");
  expect(fixture.decide).toHaveBeenCalledOnce();
  fireEvent.click(allow);
  await waitFor(() =>
    expect(fixture.decide).toHaveBeenCalledTimes(2),
  );
  expect(fixture.decide).toHaveBeenLastCalledWith(
    pending.id,
    true,
  );
});

it("keeps foreground approval available when system notifications are disabled", async () => {
  const view = mount({
    visible: false,
    native: true,
    enabled: false,
  });
  setPending([request()]);
  expect(view.show).not.toHaveBeenCalled();
  view.setVisible(true);
  await screen.findByRole("button", { name: allowLabel() });
});

it.each([
  "expired",
  "resolved",
  "untrusted",
  "disabled",
  "closed",
  "reconnected",
])(
  "ignores stale native answers after the request is %s",
  async (reason) => {
    const view = mount({ visible: false, native: true });
    const pending = request();
    setPending([pending]);
    await waitFor(() =>
      expect(view.show).toHaveBeenCalledOnce(),
    );
    if (reason === "expired")
      vi.spyOn(Date, "now").mockReturnValue(
        pending.expiresAt + 1,
      );
    if (reason === "resolved") setPending([]);
    if (reason === "untrusted")
      fixture.canReceive.mockReturnValue(false);
    if (reason === "disabled") fixture.enabled = false;
    if (reason === "closed") fixture.ready = false;
    if (reason === "reconnected")
      setPending([
        {
          ...pending,
          principal: {
            ...pending.principal,
            generation: "connection-2",
          },
        },
      ]);
    view.respond("approve");
    expect(fixture.decide).not.toHaveBeenCalled();
    view.service.reconcile();
    await waitFor(() =>
      expect(view.dismiss).toHaveBeenCalled(),
    );
  },
);

it("does not prompt for local tokens, unverified peers or already expired requests", () => {
  const view = mount({ visible: false, native: true });
  setPending([request("mcp")]);
  fixture.canReceive.mockReturnValue(false);
  setPending([request()]);
  fixture.canReceive.mockReturnValue(true);
  setPending([{ ...request(), expiresAt: Date.now() - 1 }]);
  expect(view.show).not.toHaveBeenCalled();
  expect(fixture.decide).not.toHaveBeenCalled();
});
