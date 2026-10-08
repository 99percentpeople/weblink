import { createMemo } from "solid-js";
import { resolvedLocale } from "@/libs/state/app-locale";

export function ChatTimeSeparator(props: {
  timestamp: number;
}) {
  const date = createMemo(() => new Date(props.timestamp));
  const label = createMemo(() =>
    date().toLocaleString(resolvedLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  return (
    <li
      data-slot="chat-time-separator"
      class="flex shrink-0 justify-center py-3 first:pt-0"
    >
      <time
        dateTime={date().toISOString()}
        class="text-muted-foreground bg-muted/50 rounded-full px-3 py-1
          text-[11px] tabular-nums leading-4"
      >
        {label()}
      </time>
    </li>
  );
}
