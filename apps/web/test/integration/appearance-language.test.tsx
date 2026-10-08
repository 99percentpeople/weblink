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
import { Suspense } from "solid-js";
import AppearanceSettings from "@/components/settings/appearance-settings";
import { isDictLoaded, t } from "@/i18n";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { initializeAppLocale } from "@/libs/state/app-locale";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
});
vi.mock(
  "@/assets/i18n/zh-cn.json",
  async (importOriginal) => {
    await loading.pending;
    return importOriginal();
  },
);
vi.mock("@/assets/i18n/zh-tw.json", () => {
  throw new Error("Language chunk unavailable");
});
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});
vi.mock("@/components/settings/wallpaper-picker", () => ({
  default: () => <input aria-label="Unfinished edit" />,
}));
vi.mock("@/components/common/theme-toggle", () => ({
  ThemeToggle: () => <button>Theme</button>,
}));

beforeEach(async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  setAppState("options", "locale", "en-us");
  await waitFor(() => expect(isDictLoaded()).toBe(true));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSettings() {
  const fallback = vi.fn(() => <p>Loading whole dialog</p>);
  render(() => {
    initializeAppLocale();
    return (
      <Suspense fallback={fallback()}>
        <AppearanceSettings />
      </Suspense>
    );
  });
  // Suspense evaluates the fallback lazily only if it is needed.
  return fallback;
}

async function choose(option: string) {
  const trigger = screen.getByRole("button", {
    name: (name) =>
      name.startsWith(
        t("setting.appearance.language.title") + " ",
      ),
  });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(
    await screen.findByRole("option", { name: option }),
  );
}

it("keeps settings and edits mounted while loading, and ignores a stale language response", async () => {
  const fallback = renderSettings();
  const input = screen.getByRole(
    "textbox",
  ) as HTMLInputElement;
  fireEvent.input(input, {
    target: { value: "keep this edit" },
  });
  input.focus();
  await choose("简体中文");
  expect(isDictLoaded()).toBe(false);
  expect(t("setting.appearance.language.title")).toBe(
    "Language",
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input.value).toBe("keep this edit");
  expect(fallback).not.toHaveBeenCalled();

  await choose("English");
  await waitFor(() => expect(isDictLoaded()).toBe(true));
  loading.release();
  await import("@/assets/i18n/zh-cn.json");
  expect(t("setting.appearance.language.title")).toBe(
    "Language",
  );
  expect(appState.options.locale).toBe("en-us");

  await choose("简体中文");
  await waitFor(() =>
    expect(t("setting.appearance.language.title")).toBe(
      "语言",
    ),
  );
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input.value).toBe("keep this edit");
  expect(fallback).not.toHaveBeenCalled();
});

it("offers system and new languages and updates the system label in place", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue([
    "en-GB",
  ]);
  renderSettings();
  for (const [label, locale, title] of [
    ["Español", "es-es", "Idioma"],
    ["日本語", "ja-jp", "言語"],
    ["한국어", "ko-kr", "언어"],
    ["Français", "fr-fr", "Langue"],
    ["Deutsch", "de-de", "Sprache"],
  ]) {
    await choose(label);
    await waitFor(() =>
      expect(t("setting.appearance.language.title")).toBe(
        title,
      ),
    );
    expect(appState.options.locale).toBe(locale);
  }
  await choose("Systemsprache verwenden");
  await waitFor(() =>
    expect(t("setting.appearance.language.title")).toBe(
      "Language",
    ),
  );
  expect(appState.options.locale).toBe("system");
  expect(
    screen.getByRole("button", {
      name: "Language Follow system",
    }),
  ).toHaveTextContent("Follow system");
});

it("keeps the settings usable when a language chunk fails", async () => {
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation(() => {});
  const fallback = renderSettings();
  await choose("繁體中文");
  await waitFor(() => expect(warn).toHaveBeenCalled());
  expect(isDictLoaded()).toBe(true);
  expect(t("setting.appearance.language.title")).toBe(
    "Language",
  );
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  expect(fallback).not.toHaveBeenCalled();
});
