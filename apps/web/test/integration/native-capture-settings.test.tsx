// @vitest-environment jsdom
import { createSignal, Show, type JSX } from "solid-js";
import { SettingsStateProvider } from "../helpers/settings-state";
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
  render as renderView,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type { CaptureStatus } from "@weblink/platform";
import NativeCaptureSettings from "@/components/settings/native-capture-settings";

const api = vi.hoisted(() => ({
  sources: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  stop: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    kind: "desktop",
    capture: api,
    getCapabilities: api.capabilities,
  },
}));

function render(view: () => JSX.Element) {
  return renderView(() => (
    <SettingsStateProvider>{view()}</SettingsStateProvider>
  ));
}
const source = {
  id: "selected-window",
  kind: "window",
  name: "Test window",
  width: 640,
  height: 480,
} as const;
const active: CaptureStatus = {
  sessionId: "session-1",
  source,
  state: "running",
  frames: 0,
  width: 0,
  height: 0,
  fps: 0,
  elapsedMs: 0,
  lastFrameAgeMs: null,
  stopReason: null,
  error: null,
};
const button = (key: string) =>
  screen.getByRole("button", {
    name: `setting.native_capture.${key}`,
  });
const choose = async () => {
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, {
    target: { value: source.id },
  });
};
const begin = async () => {
  await choose();
  fireEvent.click(button("start"));
  await waitFor(() => expect(button("stop")).toBeEnabled());
};

beforeEach(() => {
  vi.resetAllMocks();
  api.capabilities.mockResolvedValue({
    runtime: "desktop",
    nativeScreenCapture: true,
    displayRefreshRates: [],
  });
  api.sources.mockResolvedValue([source]);
  api.start.mockResolvedValue(active);
  api.status.mockResolvedValue(active);
  api.stop.mockResolvedValue({
    ...active,
    state: "stopped",
    stopReason: "user",
  });
});
afterEach(cleanup);

it("requires an explicit choice and stops the owned session", async () => {
  render(() => <NativeCaptureSettings />);
  await screen.findByRole("combobox");
  expect(button("start")).toBeDisabled();
  expect(api.start).not.toHaveBeenCalled();
  await begin();
  expect(api.start).toHaveBeenCalledWith(source.id);
  expect(screen.getByRole("combobox")).toBeDisabled();
  fireEvent.click(button("stop"));
  await waitFor(() =>
    expect(button("start")).toBeEnabled(),
  );
  expect(api.stop).toHaveBeenCalledWith(active.sessionId);
  expect(screen.getByRole("status")).toHaveTextContent(
    "setting.native_capture.state.stopped",
  );
});

it("stops capture when the settings panel unmounts", async () => {
  const view = render(() => <NativeCaptureSettings />);
  await begin();
  view.unmount();
  expect(api.stop).toHaveBeenCalledOnce();
  expect(api.stop).toHaveBeenCalledWith(active.sessionId);
});

it("releases a session even if start finishes after the panel unmounts", async () => {
  let resolve!: (status: CaptureStatus) => void;
  api.start.mockReturnValue(
    new Promise<CaptureStatus>((r) => {
      resolve = r;
    }),
  );
  const view = render(() => <NativeCaptureSettings />);
  await choose();
  fireEvent.click(button("start"));
  view.unmount();
  resolve(active);
  await waitFor(() =>
    expect(api.stop).toHaveBeenCalledWith(active.sessionId),
  );
  expect(api.stop).toHaveBeenCalledOnce();
});

it("does not let a delayed status response undo a completed stop", async () => {
  let resolve!: (status: CaptureStatus) => void;
  api.status.mockReturnValue(
    new Promise<CaptureStatus>((r) => {
      resolve = r;
    }),
  );
  render(() => <NativeCaptureSettings />);
  await begin();
  await waitFor(() =>
    expect(api.status).toHaveBeenCalledWith(
      active.sessionId,
    ),
  );
  fireEvent.click(button("stop"));
  await waitFor(() =>
    expect(button("start")).toBeEnabled(),
  );
  resolve({ ...active, frames: 100 });
  await Promise.resolve();
  expect(screen.getByRole("status")).toHaveTextContent(
    "setting.native_capture.state.stopped",
  );
  expect(button("stop")).toBeDisabled();
});

it("surfaces source closure and allows selecting another source", async () => {
  api.status.mockResolvedValue({
    ...active,
    state: "closed",
    stopReason: "sourceClosed",
    frames: 12,
  });
  render(() => <NativeCaptureSettings />);
  await begin();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "setting.native_capture.state.closed",
    ),
  );
  expect(screen.getByRole("combobox")).toBeEnabled();
  expect(button("start")).toBeEnabled();
});

it("shows start failures and permits retry without losing the selected source", async () => {
  api.start.mockRejectedValueOnce("GPU unavailable");
  render(() => <NativeCaptureSettings />);
  await choose();
  fireEvent.click(button("start"));
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("GPU unavailable");
  expect(button("start")).toBeEnabled();
  fireEvent.click(button("start"));
  await waitFor(() => expect(button("stop")).toBeEnabled());
  expect(api.start).toHaveBeenCalledTimes(2);
});

it("does not enumerate or expose capture when the runtime lacks support", async () => {
  api.capabilities.mockResolvedValue({
    runtime: "desktop",
    nativeScreenCapture: false,
    displayRefreshRates: [],
  });
  const view = render(() => <NativeCaptureSettings />);
  await Promise.resolve();
  expect(view.container).toBeEmptyDOMElement();
  expect(api.sources).not.toHaveBeenCalled();
});

it("keeps discovered sources ready when the settings panel is reopened", async () => {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <Show when={open()}>
      <NativeCaptureSettings />
    </Show>
  ));
  await choose();
  setOpen(false);
  setOpen(true);
  expect(screen.getByRole("combobox")).toBeEnabled();
  expect(
    screen.getByRole("option", { name: /Test window/ }),
  ).toBeVisible();
  expect(api.capabilities).toHaveBeenCalledOnce();
  expect(api.sources).toHaveBeenCalledOnce();
  expect(api.start).not.toHaveBeenCalled();
});

it("keeps the selected source during background refresh and clears it if the source disappears", async () => {
  render(() => <NativeCaptureSettings />);
  await choose();
  api.sources.mockResolvedValue([{ ...source }]);
  fireEvent.click(button("refresh"));
  await waitFor(() =>
    expect(button("start")).toBeEnabled(),
  );
  expect(screen.getByRole("combobox")).toHaveValue(
    source.id,
  );
  api.sources.mockResolvedValue([]);
  fireEvent.click(button("refresh"));
  await waitFor(() =>
    expect(button("refresh")).toBeEnabled(),
  );
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(button("start")).toBeDisabled();
});

it("keeps Stop reachable if capture support disappears during a diagnostic session", async () => {
  render(() => <NativeCaptureSettings />);
  await begin();
  api.capabilities.mockResolvedValue({
    runtime: "desktop",
    nativeScreenCapture: false,
    displayRefreshRates: [],
  });
  window.dispatchEvent(new Event("focus"));
  await waitFor(() =>
    expect(api.capabilities).toHaveBeenCalledTimes(2),
  );
  expect(button("stop")).toBeEnabled();
  fireEvent.click(button("stop"));
  await waitFor(() =>
    expect(api.stop).toHaveBeenCalledWith(active.sessionId),
  );
});
