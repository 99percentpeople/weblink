import languages from "@/assets/i18n/languages.json";

export type SupportedLocale = keyof typeof languages;
export type Locale = SupportedLocale | "system";

export const localeOptionsMap = languages;
export const localeOptions: Locale[] = [
  "system",
  ...(Object.keys(languages) as SupportedLocale[]),
];

function matchLanguage(
  language: string,
): SupportedLocale | undefined {
  const normalized = language
    .trim()
    .replaceAll("_", "-")
    .toLowerCase();
  if (Object.hasOwn(languages, normalized)) {
    return normalized as SupportedLocale;
  }
  const [base, ...subtags] = normalized.split("-");
  if (base === "zh") {
    if (subtags.includes("hant")) return "zh-tw";
    if (subtags.includes("hans")) return "zh-cn";
    return subtags.some((tag) =>
      ["tw", "hk", "mo"].includes(tag),
    )
      ? "zh-tw"
      : "zh-cn";
  }
  return (Object.keys(languages) as SupportedLocale[]).find(
    (locale) => locale.split("-")[0] === base,
  );
}

export function localFromLanguage(
  language: string | null | undefined,
): SupportedLocale {
  return (language && matchLanguage(language)) || "en-us";
}

export function normalizeLocalePreference(
  value: unknown,
): Locale {
  if (value === "system") return "system";
  return typeof value === "string"
    ? (matchLanguage(value) ?? "system")
    : "system";
}

export function resolveLocale(
  preference: Locale,
  preferredLanguages: readonly string[],
): SupportedLocale {
  if (preference !== "system")
    return localFromLanguage(preference);
  for (const language of preferredLanguages) {
    const match = matchLanguage(language);
    if (match) return match;
  }
  return "en-us";
}
