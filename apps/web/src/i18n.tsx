import {
  flatten,
  resolveTemplate,
} from "@solid-primitives/i18n";
import { createMemo, createResource } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setAppOptions } from "./options";
import {
  localeOptions,
  localeOptionsMap,
  type Locale,
  type SupportedLocale,
} from "@/libs/i18n/locale";
import { appState } from "@/libs/state/app-state";
import { resolvedLocale } from "@/libs/state/app-locale";

import en from "@/assets/i18n/en-us.json";

const dictionaryLoaders = import.meta.glob<{
  default: typeof en;
}>(["./assets/i18n/*.json", "!./assets/i18n/en-us.json"]);
const englishDictionary = flatten(en);

async function importDictionary(locale: SupportedLocale) {
  const localeKey = locale.toLowerCase();
  if (localeKey === "en-us") return englishDictionary;
  const loader =
    dictionaryLoaders[`./assets/i18n/${localeKey}.json`];
  if (!loader) {
    console.warn(`Locale ${locale} not found`);
    return englishDictionary;
  }
  try {
    const data = await loader();
    return flatten(data.default);
  } catch (error) {
    console.warn(`Could not load locale ${locale}`, error);
    return englishDictionary;
  }
}

const [dict] = createResource(
  resolvedLocale,
  importDictionary,
  { initialValue: englishDictionary },
);

export const isDictLoaded = createMemo(() => {
  return !dict.loading;
});

// Reading the latest dictionary keeps text mounted while the next chunk loads.
// A direct resource read would suspend the entire settings dialog.
const t = (
  path: string,
  args?: Record<
    string,
    string | number | boolean | null | undefined
  >,
): string => {
  const dictionary: Record<string, unknown> = dict.latest;
  const fallback: Record<string, unknown> =
    englishDictionary;
  const translated = dictionary[path];
  const original = fallback[path];
  // Empty translations must fall back too; otherwise a present key can
  // leave a label blank even though English has usable text.
  const template =
    typeof translated === "string" && translated.trim()
      ? translated
      : typeof original === "string" && original.trim()
        ? original
        : path;
  return resolveTemplate(
    template,
    args &&
      Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          value ?? "",
        ]),
      ),
  );
};

export const localeLabel = (locale: Locale): string =>
  locale === "system"
    ? t("setting.appearance.language.system")
    : localeOptionsMap[locale];

const LocaleSelector = () => {
  return (
    <Select<Locale>
      value={appState.options.locale}
      onChange={(value) => {
        if (value) setAppOptions("locale", value);
      }}
      options={localeOptions}
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          {localeLabel(props.item.rawValue)}
        </SelectItem>
      )}
    >
      <SelectTrigger>
        <SelectValue<Locale>>
          {(state) => localeLabel(state.selectedOption())}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

export { t, LocaleSelector };
