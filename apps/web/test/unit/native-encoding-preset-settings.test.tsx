// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createStore } from "solid-js/store";
import type { NativeEncoder } from "@weblink/platform";
import NativeEncodingPresetSettings from "@/components/settings/native-encoding-preset-settings";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";

vi.mock("@/i18n", () => ({
  t: (key: string) => key.split("encoding_preset_").at(-1),
}));
vi.mock("@/libs/state/app-state", async () => {
  const { createStore } = await import("solid-js/store");
  const [appState, write] = createStore({
    options: {
      nativeScreenEncoder: "auto",
      nativeEncoderPresets: {},
    },
  });
  return { appState, write };
});
vi.mock("@/options", async () => {
  const state =
    (await import("@/libs/state/app-state")) as unknown as {
      write: (...args: unknown[]) => void;
    };
  return {
    setAppOptions: vi.fn((key, value) =>
      state.write("options", key, value),
    ),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const catalog: NativeEncoder[] = [
  {
    id: "nvenc:h265",
    name: "NVENC",
    hardware: true,
    codecs: ["video/h265"],
    presets: ["balanced", "quality", "latency"],
  },
  {
    id: "mf:partial",
    name: "MFT",
    hardware: true,
    codecs: ["video/h264"],
    presets: ["balanced", "latency"],
  },
  {
    id: "software",
    name: "Software",
    hardware: false,
    codecs: ["video/vp8"],
    presets: ["balanced", "quality", "latency"],
  },
];

it("selects and remembers three intents per encoder and hides unsupported backends", async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  setAppOptions("nativeScreenEncoder", "nvenc:h265");
  render(() => (
    <NativeEncodingPresetSettings encoders={catalog} />
  ));
  const button = () =>
    screen.getByRole("button", { name: /^label/ });
  expect(button().textContent).toContain("balanced");
  await userEvent.click(button());
  expect(screen.getAllByRole("option")).toHaveLength(3);
  await userEvent.click(
    screen.getByRole("option", { name: "quality" }),
  );
  expect(
    appState.options.nativeEncoderPresets["nvenc:h265"],
  ).toBe("quality");
  // Reopen settings between selections; jsdom does not run the popover exit animation.
  cleanup();
  setAppOptions("nativeScreenEncoder", "mf:partial");
  render(() => (
    <NativeEncodingPresetSettings encoders={catalog} />
  ));
  expect(button().textContent).toContain("balanced");
  await userEvent.click(button());
  expect(
    screen
      .getByRole("option", { name: "quality" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.click(
    screen.getByRole("option", { name: "latency" }),
  );
  cleanup();
  setAppOptions("nativeScreenEncoder", "nvenc:h265");
  render(() => (
    <NativeEncodingPresetSettings encoders={catalog} />
  ));
  expect(button().textContent).toContain("quality");
  setAppOptions("nativeScreenEncoder", "software");
  expect(button().textContent).toContain("balanced");
  await userEvent.click(button());
  await userEvent.click(
    screen.getByRole("option", { name: "latency" }),
  );
  expect(
    appState.options.nativeEncoderPresets.software,
  ).toBe("latency");
  cleanup();
  setAppOptions("nativeScreenEncoder", "legacy-software");
  render(() => (
    <NativeEncodingPresetSettings encoders={catalog} />
  ));
  expect(screen.queryByRole("button")).toBeNull();
  expect(
    appState.options.nativeEncoderPresets["mf:partial"],
  ).toBe("latency");
});

it("does not overwrite saved preferences when capability support disappears", () => {
  const [state, set] = createStore({ encoders: catalog });
  setAppOptions("nativeScreenEncoder", "nvenc:h265");
  setAppOptions("nativeEncoderPresets", {
    "nvenc:h265": "quality",
  });
  render(() => (
    <NativeEncodingPresetSettings
      encoders={state.encoders}
    />
  ));
  set("encoders", [
    { ...catalog[0], presets: ["balanced"] },
  ]);
  expect(screen.queryByRole("button")).toBeNull();
  expect(
    appState.options.nativeEncoderPresets["nvenc:h265"],
  ).toBe("quality");
});
