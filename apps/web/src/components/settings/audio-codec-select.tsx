import { SettingSelect } from "./setting-controls";
import { createMemo, Show } from "solid-js";

import {
  audioCodecChoices,
  audioCodecLabel,
} from "@/libs/application/meeting-audio-settings";
import { t } from "@/i18n";

export default function AudioCodecSelect(props: {
  title: string;
  codecs: readonly string[];
  value: string | null;
  loading?: boolean;
  onChange(value: string | null): void;
}) {
  const label = (key: string) =>
    t(`setting.meeting_settings.audio.${key}`);
  const codecs = createMemo(() =>
    audioCodecChoices(props.codecs),
  );
  const selected = () => props.value ?? "auto";
  const name = (codec: string) =>
    codec === "auto"
      ? label("auto")
      : `${audioCodecLabel(codec)}${codecs().includes(codec) ? "" : ` (${label("unavailable")})`}`;
  const choices = createMemo(() => [
    ...new Set(["auto", ...codecs(), selected()]),
  ]);
  return (
    <SettingSelect<string>
      modal
      value={selected()}
      options={choices()}
      optionDisabled={(option) =>
        option !== "auto" && !codecs().includes(option)
      }
      onChange={(value) => {
        if (
          value &&
          (value === "auto" || codecs().includes(value))
        )
          props.onChange(value === "auto" ? null : value);
      }}
      label={props.title}
      renderValue={(state) =>
        name(state.selectedOption() ?? "auto")
      }
      hint={
        <>
          <Show when={props.loading || !codecs().length}>
            <p class="muted" role="status">
              {label(
                props.loading
                  ? "codecs_loading"
                  : "codec.unsupported",
              )}
            </p>
          </Show>
        </>
      }
      optionLabel={(option) => name(option)}
    />
  );
}
