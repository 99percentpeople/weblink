import { createMemo, Show } from "solid-js";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    <div class="flex flex-col gap-2">
      <Label>{props.title}</Label>
      <Select<string>
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
        itemComponent={(item) => (
          <SelectItem item={item.item}>
            {name(item.item.rawValue)}
          </SelectItem>
        )}
      >
        <SelectTrigger aria-label={props.title}>
          <SelectValue<string>>
            {(state) =>
              name(state.selectedOption() ?? "auto")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
      <Show when={props.loading || !codecs().length}>
        <p class="muted" role="status">
          {label(
            props.loading
              ? "codecs_loading"
              : "codec.unsupported",
          )}
        </p>
      </Show>
    </div>
  );
}
