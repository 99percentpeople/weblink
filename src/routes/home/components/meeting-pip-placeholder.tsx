import { t } from "@/i18n";

export function MeetingPipPlaceholder(props: {
  onReturn(): void;
}) {
  return (
    <section
      class="[container-type:size] flex min-h-0 min-w-0 flex-1 flex-col
        items-center justify-center overflow-auto p-6 text-center"
      aria-label={t("meeting.pip_elsewhere")}
    >
      <div
        class="flex w-full max-w-[32em] shrink-0 flex-col items-center
          gap-3"
        data-motion-layout-size="placeholder-content"
      >
        <svg
          class="text-ring h-auto max-h-[32cqh] w-[min(240px,70%)] shrink-0"
          viewBox="0 0 280 190"
          width="280"
          height="190"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          {/* The original window stays behind an opaque, floating meeting window. */}
          <rect
            x="18"
            y="18"
            width="196"
            height="124"
            rx="12"
            fill="currentColor"
            fill-opacity="0.04"
            stroke="currentColor"
            stroke-opacity="0.25"
            stroke-width="2"
          />
          <path
            d="M19 42h194"
            stroke="currentColor"
            stroke-opacity="0.18"
            stroke-width="2"
          />
          <g fill="currentColor" opacity="0.4">
            <circle cx="31" cy="30" r="2" />
            <circle cx="41" cy="30" r="2" />
            <circle cx="51" cy="30" r="2" />
          </g>
          <rect
            x="132"
            y="86"
            width="130"
            height="88"
            rx="12"
            fill="var(--meeting-surface)"
            stroke="currentColor"
            stroke-opacity="0.75"
            stroke-width="2"
          />
          {/* A 16:9 video area above a separate, centered control row. */}
          <rect
            x="140"
            y="94"
            width="114"
            height="64.125"
            rx="6"
            fill="currentColor"
            fill-opacity="0.1"
          />
          <circle
            cx="197"
            cy="114"
            r="9"
            fill="currentColor"
            fill-opacity="0.8"
          />
          <path
            d="M179 147c0-10 8-17 18-17s18 7 18 17Z"
            fill="currentColor"
            fill-opacity="0.5"
          />
          <g fill="currentColor" opacity="0.55">
            <circle cx="185" cy="166" r="2.5" />
            <circle cx="197" cy="166" r="2.5" />
            <circle cx="209" cy="166" r="2.5" />
          </g>
        </svg>
        <h2 class="text-[17px] font-medium">
          {t("meeting.pip_elsewhere")}
        </h2>
        <p class="text-muted-foreground max-w-[32em] text-[13px] leading-[1.6]">
          {t("meeting.pip_elsewhere_hint")}
        </p>
        <button
          type="button"
          class="bg-accent text-accent-foreground mt-1 flex min-h-9 min-w-16
            flex-col items-center justify-center gap-1.5 rounded-md px-4
            py-2 text-[10px] whitespace-nowrap transition-[background]
            duration-150"
          onClick={props.onReturn}
        >
          {t("meeting.pip_restore")}
        </button>
      </div>
    </section>
  );
}
