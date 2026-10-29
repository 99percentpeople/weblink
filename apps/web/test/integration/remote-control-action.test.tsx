// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { PointerState } from "@/libs/domain/remote-control/pointer";
import { RemoteControlAction } from "@/routes/home/components/remote-control-action";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {},
}));
vi.mock(
  "@/routes/home/components/meeting-tile-actions",
  () => ({
    MeetingTileAction: (props: {
      label: string;
      disabled: boolean;
      onAction(): void;
    }) => (
      <button
        disabled={props.disabled}
        onClick={props.onAction}
      >
        {props.label}
      </button>
    ),
  }),
);
afterEach(cleanup);
it("disables the control action while busy and enables it after release", () => {
  const [state, setState] =
    createSignal<PointerState>("busy");
  const control = Object.assign(new EventTarget(), {
    state,
    request: vi.fn(),
    cancel: vi.fn(),
  });
  render(() => (
    <RemoteControlAction
      control={control}
      state={state()}
    />
  ));
  const busy = screen.getByRole("button", {
    name: "remote_control.busy",
  });
  expect(busy).toBeDisabled();
  fireEvent.click(busy);
  expect(control.request).not.toHaveBeenCalled();
  setState("viewing");
  const available = screen.getByRole("button", {
    name: "remote_control.request",
  });
  expect(available).not.toBeDisabled();
  fireEvent.click(available);
  expect(control.request).toHaveBeenCalledOnce();
  setState("active");
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  );
  expect(control.cancel).toHaveBeenCalledOnce();
});

it("only ends control and lets the viewer request it again without a close-screen action", () => {
  const [state, setState] =
    createSignal<PointerState>("active");
  const control = Object.assign(new EventTarget(), {
    state,
    request: vi.fn(),
    cancel: vi.fn(() => setState("viewing")),
  });
  render(() => (
    <RemoteControlAction
      control={control}
      state={state()}
    />
  ));
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  );
  expect(control.cancel).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", {
      name: "remote_control.close_screen",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.request",
    }),
  );
  expect(control.request).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", {
      name: "remote_control.close_screen",
    }),
  ).toBeNull();
});
