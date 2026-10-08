import { describe, expect, it } from "vitest";
import { getDefaultAppOptions } from "@/libs/state/app-options";
import {
  localFromLanguage,
  normalizeLocalePreference,
  resolveLocale,
} from "@/libs/i18n/locale";

describe("language preferences", () => {
  it("defaults to following the system", () => {
    expect(getDefaultAppOptions().locale).toBe("system");
  });

  it.each([
    ["en-GB", "en-us"],
    ["zh", "zh-cn"],
    ["zh-SG", "zh-cn"],
    ["zh-HK", "zh-tw"],
    ["zh-MO", "zh-tw"],
    ["zh-Hant", "zh-tw"],
    ["zh-Hant-CN", "zh-tw"],
    ["zh-Hans-TW", "zh-cn"],
    [" ZH_TW ", "zh-tw"],
    ["ja", "ja-jp"],
    ["es-MX", "es-es"],
    ["ko", "ko-kr"],
    ["fr-CA", "fr-fr"],
    ["de-AT", "de-de"],
    ["unsupported", "en-us"],
    [null, "en-us"],
  ])("matches %s to %s", (language, locale) => {
    expect(localFromLanguage(language)).toBe(locale);
  });

  it("uses supported system languages in preference order", () => {
    expect(
      resolveLocale("system", ["xx", "es-AR", "en-US"]),
    ).toBe("es-es");
    expect(
      resolveLocale("system", ["en-GB", "ja-JP"]),
    ).toBe("en-us");
    expect(resolveLocale("system", [])).toBe("en-us");
    expect(resolveLocale("system", ["xx"])).toBe("en-us");
  });

  it("preserves manual selections regardless of system languages", () => {
    expect(resolveLocale("zh-tw", ["en-US"])).toBe("zh-tw");
    expect(normalizeLocalePreference("zh-cn")).toBe(
      "zh-cn",
    );
    expect(normalizeLocalePreference("EN-us")).toBe(
      "en-us",
    );
    expect(normalizeLocalePreference("system")).toBe(
      "system",
    );
    expect(normalizeLocalePreference("invalid")).toBe(
      "system",
    );
    expect(normalizeLocalePreference(null)).toBe("system");
  });
});
