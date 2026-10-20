// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { DevicePairingToasts } from "@/components/app/device-pairing-toasts";
import { setAppState } from "@/libs/state/app-state";
import type { PairingRequest } from "@/libs/domain/device-identity/manual-pairing";

const fixture = vi.hoisted(() => ({
  request: undefined as
    | undefined
    | (() => PairingRequest | undefined),
  respond: vi.fn(),
  toast: vi.fn(
    (
      _title: string,
      options: {
        id: string;
        action: { onClick(): void };
        cancel: { onClick(): void };
      },
    ) => options.id,
  ),
  dismiss: vi.fn(),
}));
vi.mock("solid-sonner", () => ({
  toast: Object.assign(fixture.toast, {
    dismiss: fixture.dismiss,
  }),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    trust: {
      pairing: () => fixture.request?.(),
      respondPairing: (...args: unknown[]) =>
        fixture.respond(...args),
    },
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.request = undefined;
  setAppState("session", "clientViewData", "peer", {
    clientId: "peer",
    name: "Other device",
    avatar: "",
    createdAt: 0,
    onlineStatus: "online",
    messageChannel: true,
    trust: "untrusted",
  });
});
afterEach(() => {
  cleanup();
  setAppState(
    "session",
    "clientViewData",
    "peer",
    undefined!,
  );
});
const options = () => fixture.toast.mock.calls.at(-1)![1];

it.each([true, false])(
  "supports an explicit %s decision on the current incoming request",
  (accept) => {
    const [request, setRequest] =
      createSignal<PairingRequest>({
        id: "one",
        state: "incoming",
      });
    fixture.request = request;
    render(() => <DevicePairingToasts />);
    expect(fixture.toast).toHaveBeenCalledOnce();
    setAppState(
      "session",
      "clientViewData",
      "peer",
      "name",
      "Renamed",
    );
    expect(fixture.toast).toHaveBeenCalledOnce();
    if (accept) options().action.onClick();
    else options().cancel.onClick();
    expect(fixture.respond).toHaveBeenCalledWith(
      "peer",
      "one",
      accept,
    );
    setRequest({ id: "one", state: "committing" });
    expect(fixture.dismiss).toHaveBeenCalledWith(
      "device-pairing:one",
    );
    options().action.onClick();
    expect(fixture.respond).toHaveBeenCalledOnce();
  },
);

it("dismisses expiry/disconnect and ignores an old toast after a new request or unmount", () => {
  const [request, setRequest] =
    createSignal<PairingRequest>({
      id: "old",
      state: "incoming",
    });
  fixture.request = request;
  const view = render(() => <DevicePairingToasts />);
  const old = options();
  setRequest({
    id: "old",
    state: "failed",
    reason: "timeout",
  });
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "device-pairing:old",
  );
  old.action.onClick();
  setRequest({ id: "new", state: "incoming" });
  old.action.onClick();
  expect(fixture.respond).not.toHaveBeenCalled();
  const current = options();
  setAppState(
    "session",
    "clientViewData",
    "peer",
    "messageChannel",
    false,
  );
  current.action.onClick();
  expect(fixture.respond).not.toHaveBeenCalled();
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "device-pairing:new",
  );
  view.unmount();
  current.cancel.onClick();
  expect(fixture.respond).not.toHaveBeenCalled();
});

it("shows incoming requests to an already trusted device but never approves automatically", () => {
  fixture.request = () => ({
    id: "one",
    state: "incoming",
  });
  setAppState(
    "session",
    "clientViewData",
    "peer",
    "trust",
    "trusted",
  );
  render(() => <DevicePairingToasts />);
  expect(fixture.toast).toHaveBeenCalledOnce();
  expect(fixture.respond).not.toHaveBeenCalled();
});
