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
import { createSignal } from "solid-js";
import { toast, Toaster } from "solid-sonner";
import { RemoteControlStatus } from "@/components/app/remote-control-status";
import { MeetingSharingStatus } from "@/routes/home/components/meeting-sharing-status";
import type { NativeControlStatus } from "@weblink/platform";

const fixture = vi.hoisted(() => ({
  status: undefined as any,
  approve: vi.fn(),
  revoke: vi.fn(),
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
    session: {
      clientViewData: { peer: { name: "Alice" } },
    },
  },
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: { name: string }) =>
    values ? `${key}: ${values.name}` : key,
}));
let setStatus: (status: NativeControlStatus) => void;
const request = (
  consentId = "first",
): NativeControlStatus => ({
  closed: false,
  clientId: null,
  pending: {
    consentId,
    clientId: "peer",
    sourceId: "screen",
  },
});
beforeEach(() => {
  [fixture.status, setStatus] =
    createSignal<NativeControlStatus>({
      closed: false,
      pending: null,
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
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () =>
  render(() => (
    <>
      <Toaster theme="light" />
      <RemoteControlStatus />
    </>
  ));
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
    pending: null,
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

it("keeps host control actions in the sharing status and prevents duplicate revokes", async () => {
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
    <MeetingSharingStatus
      name="Host"
      count={1}
      onStop={stop}
      audioAvailable={false}
      audioOn={false}
      onAudioChange={() => {}}
      controller={controller()}
    />
  ));
  expect(
    screen.queryByRole("button", {
      name: "remote_control.revoke",
    }),
  ).toBeNull();
  setController({ name: "Alice", revoke });
  expect(
    screen.getByText("remote_control.host_active: Alice"),
  ).toBeVisible();
  const button = screen.getByRole("button", {
    name: "remote_control.revoke",
  });
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
