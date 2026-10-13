import type { SupportedLocale } from "@weblink/locale";
import zhCN from "./zh-cn.json";
import zhTW from "./zh-tw.json";
import en from "./en-us.json";
import ja from "./ja-jp.json";
import ko from "./ko-kr.json";
import es from "./es-es.json";
import fr from "./fr-fr.json";
import de from "./de-de.json";

export type MessageKey = keyof typeof zhCN;
export type Messages = Record<MessageKey, string>;

// A missing language or translation is a type error, including new app locales.
export const catalogs = {
  "zh-cn": zhCN,
  "zh-tw": zhTW,
  "en-us": en,
  "ja-jp": ja,
  "ko-kr": ko,
  "es-es": es,
  "fr-fr": fr,
  "de-de": de,
} satisfies Record<SupportedLocale, Messages>;
