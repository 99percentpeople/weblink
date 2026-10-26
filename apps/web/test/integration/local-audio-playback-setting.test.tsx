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
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import LocalAudioPlaybackSetting from "@/components/settings/local-audio-playback-setting";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const runtime = vi.hoisted(() => ({
  platform: {
    screenShare: undefined as object | undefined,
  },
}));
vi.mock("@/libs/platform/runtime", () => runtime);
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
const label = (key: string) =>
  `setting.meeting_settings.audio.local_playback.${key}`;

beforeEach(() => {
  runtime.platform.screenShare = undefined;
  setAppState(reconcile(createInitialAppState()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lets a supported browser save the preference", () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getSupportedConstraints: () => ({
        suppressLocalAudioPlayback: true,
      }),
    },
  });
  render(() => <LocalAudioPlaybackSetting />);
  const toggle = screen.getByRole("switch", {
    name: label("title"),
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(appState.options.suppressLocalAudioPlayback).toBe(
    true,
  );
  expect(
    screen.getByText(label("browser_description")),
  ).toBeInTheDocument();
});

it("explains unavailable browser support without clearing a saved preference", () => {
  vi.stubGlobal("navigator", {
    mediaDevices: { getSupportedConstraints: () => ({}) },
  });
  setAppState(
    "options",
    "suppressLocalAudioPlayback",
    true,
  );
  render(() => <LocalAudioPlaybackSetting />);
  const toggle = screen.getByRole("switch", {
    name: label("title"),
  });
  expect(toggle).toBeDisabled();
  expect(toggle).toBeChecked();
  expect(
    screen.getByText(label("unsupported")),
  ).toBeInTheDocument();
});

it("offers native playback suppression without browser support", () => {
  vi.stubGlobal("navigator", {});
  runtime.platform.screenShare = {};
  setAppState("capabilities", "runtime", {
    runtime: "desktop",
    os: "windows",
    version: "test",
    nativeScreenCapture: true,
    displayRefreshRates: [],
    remoteInput: false,
    nativeClipboard: false,
  });
  render(() => <LocalAudioPlaybackSetting />);
  const toggle = screen.getByRole("switch", {
    name: label("title"),
  });
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);
  expect(appState.options.suppressLocalAudioPlayback).toBe(
    true,
  );
  expect(
    screen.getByText(label("desktop_description")),
  ).toBeInTheDocument();
});

it("follows runtime support instead of the presence of desktop bridge methods", () => {
  vi.stubGlobal("navigator", {});
  runtime.platform.screenShare = {};
  render(() => <LocalAudioPlaybackSetting />);
  const toggle = screen.getByRole("switch", {
    name: label("title"),
  });
  expect(toggle).toBeDisabled();
  setAppState("capabilities", "runtime", {
    runtime: "desktop",
    os: "windows",
    version: "test",
    nativeScreenCapture: true,
    displayRefreshRates: [],
    remoteInput: false,
    nativeClipboard: false,
  });
  expect(toggle).toBeEnabled();
  setAppState(
    "capabilities",
    "runtime",
    "nativeScreenCapture",
    false,
  );
  expect(toggle).toBeDisabled();
});
