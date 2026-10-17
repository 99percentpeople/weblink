import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MeetingRecordingStatus } from "@/routes/home/components/meeting-recording-status";
import type { RecordingStatus } from "@/libs/state/create-recording";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconRecord: () => <svg />,
  IconStop: () => <svg />,
  IconPause: () => <svg />,
  IconPlayArrow: () => <svg />,
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: (props: {
    name: string;
    avatar?: string;
  }) => (
    <span
      role="img"
      aria-label={props.name}
      data-avatar={props.avatar}
    />
  ),
}));
afterEach(cleanup);
it("shows progress and delegates stop, then keeps the saving status without another stop action", () => {
  const [state, setState] = createSignal<RecordingStatus>({
    sourceId: "source",
    name: "Alice · Screen 2",
    participantName: "Alice",
    avatar: "https://example.test/alice.png",
    sourceLabel: "Screen 2",
    phase: "recording",
    elapsed: 65000,
    bytes: 1024,
  });
  const stop = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const view = render(() => (
    <MeetingRecordingStatus
      state={state()}
      onStop={stop}
      onPause={pause}
      onResume={resume}
    />
  ));
  expect(screen.getByRole("status").textContent).toContain(
    "recording.recording",
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Screen 2",
  );
  expect(screen.getByText("1:05")).toBeTruthy();
  expect(screen.getByText("Screen 2")).toBeTruthy();
  expect(
    screen
      .getByRole("img", { name: "Alice" })
      .getAttribute("data-avatar"),
  ).toBe("https://example.test/alice.png");
  fireEvent.click(
    screen.getByRole("button", { name: "recording.pause" }),
  );
  expect(pause).toHaveBeenCalledOnce();
  setState((previous) => ({
    ...previous,
    phase: "paused",
  }));
  expect(screen.getByRole("status").textContent).toContain(
    "recording.paused",
  );
  expect(screen.getByText("1:05")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "recording.resume",
    }),
  );
  expect(resume).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: "recording.stop" }),
  );
  expect(stop).toHaveBeenCalledOnce();
  setState((previous) => ({
    ...previous,
    phase: "saving" as const,
  }));
  expect(screen.getByRole("status").textContent).toContain(
    "recording.saving",
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("Screen 2")).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Alice" }),
  ).toBeTruthy();
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});
it("allows cancelling while preparation is pending", () => {
  const stop = vi.fn();
  render(() => (
    <MeetingRecordingStatus
      state={{
        sourceId: "source",
        name: "Camera",
        phase: "preparing",
        elapsed: 0,
        bytes: 0,
      }}
      onStop={stop}
      onPause={() => {}}
      onResume={() => {}}
    />
  ));
  expect(
    screen.queryByRole("button", {
      name: "recording.pause",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "recording.resume",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  expect(stop).toHaveBeenCalledOnce();
});
