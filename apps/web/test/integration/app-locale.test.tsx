// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  initializeAppLocale,
  resolvedLocale,
} from "@/libs/state/app-locale";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

afterEach(() => vi.restoreAllMocks());

it("tracks system language changes, keeps manual choices and cleans up its listener", () => {
  let languages = ["zh-HK"];
  vi.spyOn(
    navigator,
    "languages",
    "get",
  ).mockImplementation(() => languages);
  setAppState("options", "locale", "system");
  const dispose = createRoot((dispose) => {
    initializeAppLocale();
    return dispose;
  });
  try {
    expect(resolvedLocale()).toBe("zh-tw");
    expect(document.documentElement.lang).toBe("zh-tw");
    languages = ["es-MX"];
    window.dispatchEvent(new Event("languagechange"));
    expect(resolvedLocale()).toBe("es-es");
    expect(document.documentElement.lang).toBe("es-es");
    expect(appState.options.locale).toBe("system");
    expect(() =>
      new Date().toLocaleString(resolvedLocale()),
    ).not.toThrow();

    setAppState("options", "locale", "en-us");
    languages = ["ja-JP"];
    window.dispatchEvent(new Event("languagechange"));
    expect(resolvedLocale()).toBe("en-us");
    setAppState("options", "locale", "system");
    expect(resolvedLocale()).toBe("ja-jp");

    dispose();
    languages = ["zh-CN"];
    window.dispatchEvent(new Event("languagechange"));
    expect(resolvedLocale()).toBe("ja-jp");
  } finally {
    dispose();
  }
});

it("falls back to navigator.language when the preferred list is empty", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(
    [],
  );
  vi.spyOn(navigator, "language", "get").mockReturnValue(
    "zh-Hans",
  );
  setAppState("options", "locale", "system");
  const dispose = createRoot((dispose) => {
    initializeAppLocale();
    return dispose;
  });
  expect(resolvedLocale()).toBe("zh-cn");
  dispose();
});
