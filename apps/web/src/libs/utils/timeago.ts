import {
  createTimeAgo as createTimeAgoPrimitive,
  DateInit,
} from "@solid-primitives/date";
import { Accessor } from "solid-js";
import { formatRelative, formatDistance } from "date-fns";
import { enUS, zhCN, zhTW } from "date-fns/locale";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
type MaybeAccessor<T> = T | Accessor<T>;

const locale = {
  "en-us": enUS,
  "zh-cn": zhCN,
  "zh-tw": zhTW,
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
          locale:
            locale[
              appState.options.locale as keyof typeof locale
            ] ?? enUS,
          addSuffix: true,
        });
      } else {
        return formatRelative(target, now, {
          locale:
            locale[
              appState.options.locale as keyof typeof locale
            ] ?? enUS,
        });
      }
    },
    dateFormatter: (date) => {
      return new Date(date).toLocaleString();
    },
    messages: {
      justNow: t("common.timeago.just_now"),
    },
  })[0]();
};
