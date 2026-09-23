import { t } from "@/i18n";

export function MeetingPipPlaceholder(props: {
  onReturn(): void;
}) {
  return (
    <section
      class="meeting-pip-placeholder"
      aria-label={t("meeting.pip_elsewhere")}
    >
      <div
        class="meeting-pip-placeholder-content"
        data-motion-layout-size="placeholder-content"
      >
        <svg
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
            x="128"
            y="82"
            width="138"
            height="96"
            rx="16"
            fill="#11151c"
          />
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
        <h2>{t("meeting.pip_elsewhere")}</h2>
        <p>{t("meeting.pip_elsewhere_hint")}</p>
        <button
          type="button"
          class="meeting-control"
          onClick={props.onReturn}
        >
          {t("meeting.pip_restore")}
        </button>
      </div>
    </section>
  );
}
