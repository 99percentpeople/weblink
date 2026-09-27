import {
  flatten,
  resolveTemplate,
  translator,
} from "@solid-primitives/i18n";
import { createMemo, createResource } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Locale,
  localeOptionsMap,
  setAppOptions,
} from "./options";
import { appState } from "@/libs/state/app-state";

import en from "@/assets/i18n/en-us.json";

async function importDictionary(locale: Locale) {
  const localeKey = locale.toLowerCase();
  if (!localeOptionsMap[localeKey]) {
    console.warn(`Locale ${locale} not found`);
    return flatten(en);
  }
  if (localeKey === "en-us") return flatten(en);
  const data = await import(
    `./assets/i18n/${localeKey}.json`
  );
  return flatten(data.default);
}

const [dict] = createResource(
  () => appState.options.locale,
  importDictionary,
);

export const isDictLoaded = createMemo(() => {
  return !dict.loading;
});

const translate = translator(dict, resolveTemplate);

const fallback = translator(
  () => flatten(en),
  resolveTemplate,
);

const t = (path: string, ...args: any[]): string =>
  // @ts-ignore
  translate(path, ...args) ??
  // @ts-ignore
  fallback(path, ...args) ??
  path;

const LocaleSelector = () => {
  return (
    <Select
      value={appState.options.locale}
      onChange={(value) => {
        if (value) setAppOptions("locale", value as Locale);
      }}
      options={Object.keys(localeOptionsMap)}
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          {localeOptionsMap[props.item.rawValue]}
        </SelectItem>
      )}
    >
      <SelectTrigger>
        <SelectValue<Locale>>
          {(state) =>
            localeOptionsMap[state.selectedOption()]
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

export { t, LocaleSelector };
