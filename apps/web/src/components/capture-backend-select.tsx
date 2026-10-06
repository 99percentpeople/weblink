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
  const options = () => [
    ...new Set<CaptureBackend>([
      "auto",
      ...props.backends.map((backend) => backend.id),
      props.value,
    ]),
  ];
  const name = (id: CaptureBackend) =>
    id === "auto"
      ? t("meeting.native_screen.auto_backend")
      : (props.backends.find((backend) => backend.id === id)
          ?.name ??
        `${id.toUpperCase()} (${t("meeting.native_screen.unavailable")})`);
  return (
    <SettingSelect<CaptureBackend>
      modal
      value={props.value}
      options={options()}
      disabled={props.disabled || !props.backends.length}
      onChange={(value) => {
        if (value) props.onChange(value);
      }}
      label={label()}
      optionLabel={name}
      renderValue={(state) => name(state.selectedOption())}
    />
  );
}
