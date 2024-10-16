import * as i18n from "@solid-primitives/i18n";
import {
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  appOptions,
  Locale,
  setAppOptions,
} from "./options";

const localeOptions: Locale[] = ["en", "zh"];

const localeOptionsMap: Record<Locale, string> = {
  en: "English",
  zh: "简体中文",
};

async function fetchDictionary(locale: Locale) {
  const res = await fetch(`/i18n/${locale}.json`);
  const data = await res.json();
  return i18n.flatten(data);
}

const [dict] = createResource(
  () => appOptions.locale,
  fetchDictionary,
);

const [defaultDict] = createResource(
  () => "en" as Locale,
  fetchDictionary,
);

const translate = i18n.translator(
  dict,
  i18n.resolveTemplate,
);

const fallback = i18n.translator(
  defaultDict,
  i18n.resolveTemplate,
);

const t = (path: string, ...args: any[]): string =>
  // @ts-ignore
  translate(path, ...args) ?? fallback(path, ...args);

const LocaleSelector = () => {
  return (
    <Select
      value={appOptions.locale}
      onChange={(value) => {
        if (value) setAppOptions("locale", value as Locale);
      }}
      options={localeOptions}
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
