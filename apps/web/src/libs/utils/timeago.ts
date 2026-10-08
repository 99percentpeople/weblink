import {
  createTimeAgo as createTimeAgoPrimitive,
  DateInit,
} from "@solid-primitives/date";
import { Accessor } from "solid-js";
import { formatRelative, formatDistance } from "date-fns";
import {
  enUS,
  zhCN,
  zhTW,
  ja,
  es,
  ko,
  fr,
  de,
} from "date-fns/locale";
import { t } from "@/i18n";
import { resolvedLocale } from "@/libs/state/app-locale";
type MaybeAccessor<T> = T | Accessor<T>;

const locale = {
  "en-us": enUS,
  "zh-cn": zhCN,
  "zh-tw": zhTW,
  "ja-jp": ja,
  "es-es": es,
  "ko-kr": ko,
  "fr-fr": fr,
  "de-de": de,
};

export const createTimeAgo = (
  date: MaybeAccessor<DateInit>,
): string => {
  return createTimeAgoPrimitive(date, {
    min: 30000, // 30 seconds
    max: 1000 * 60 * 60 * 24, // 1 day
    relativeFormatter: (now, target) => {
      if (
        now.getTime() - target.getTime() <
        1000 * 60 * 60 // 1 hour
      ) {
        return formatDistance(target, now, {
          locale: locale[resolvedLocale()],
          addSuffix: true,
        });
      } else {
        return formatRelative(target, now, {
          locale: locale[resolvedLocale()],
        });
      }
    },
    dateFormatter: (date) => {
      return new Date(date).toLocaleString(
        resolvedLocale(),
      );
    },
    messages: {
      justNow: t("common.timeago.just_now"),
    },
  })[0]();
};
