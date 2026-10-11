import { SettingSelect } from "./settings/setting-controls";
import type {
  CaptureBackend,
  CaptureBackendInfo,
} from "@weblink/platform";

import { t } from "@/i18n";

export function captureBackendAvailable(
  value: CaptureBackend,
  backends: readonly CaptureBackendInfo[],
): boolean {
  return (
    backends.length > 0 &&
    (value === "auto" ||
      backends.some((backend) => backend.id === value))
  );
}

export default function CaptureBackendSelect(props: {
  kind: "monitor" | "window";
  value: CaptureBackend;
  backends: readonly CaptureBackendInfo[];
  disabled?: boolean;
  onChange: (value: CaptureBackend) => void;
}) {
  const label = () =>
    t(
      `meeting.native_screen.${props.kind === "monitor" ? "screen_backend" : "window_backend"}`,
    );
  const automatic = () => props.kind === "monitor";
  const options = () => [
    ...new Set<CaptureBackend>([
      ...(automatic() ? ["auto" as const] : []),
      ...props.backends.map((backend) => backend.id),
      props.value,
    ]),
  ];
  const name = (id: CaptureBackend) => {
    if (id === "auto")
      return t(
        automatic()
          ? "meeting.native_screen.auto_backend"
          : "meeting.native_screen.unavailable",
      );
    const backend = props.backends.find(
      (backend) => backend.id === id,
    );
    if (!backend)
      return `${id.toUpperCase()} (${t("meeting.native_screen.unavailable")})`;
    return !automatic() && props.backends.length === 1
      ? `${backend.name} (${t("meeting.native_screen.default_backend")})`
      : backend.name;
  };
  return (
    <SettingSelect<CaptureBackend>
      modal
      value={props.value}
      options={options()}
      disabled={props.disabled || !props.backends.length}
      onChange={(next) => {
        if (next && next !== props.value)
          props.onChange(next);
      }}
      label={label()}
      optionLabel={name}
      renderValue={(state) => name(state.selectedOption())}
    />
  );
}
