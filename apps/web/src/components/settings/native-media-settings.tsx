import { SettingHeading } from "./setting-layout";
import { SettingSelect } from "./setting-controls";
import type { NativeMediaCapabilitiesSnapshot } from "@/libs/state/create-app-media-capabilities";
import type { NativeReadbackBuffers } from "@weblink/platform";
import { createMemo, Show } from "solid-js";
import { SelectSection } from "@/components/ui/select";

import CaptureBackendSelect from "@/components/capture-backend-select";
import NativeColorSettings from "./native-color-settings";
import { appState } from "@/libs/state/app-state";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";

export type NativeMediaSettingsCapabilities =
  NativeMediaCapabilitiesSnapshot;
interface EncodingOption {
  id: string;
  encoder: string;
  codec: string | null;
  label: string;
  disabled: boolean;
  group: "hardware" | "software" | null;
}
interface EncodingGroup {
  id: string;
  label: string;
  options: EncodingOption[];
}
export default function NativeMediaSettings(props: {
  available: NativeMediaSettingsCapabilities;
}) {
  const label = (key: string) =>
    t(`setting.meeting_settings.${key}`);
  const encodingOption = (
    encoder: string,
    codec: string | null,
  ): EncodingOption => {
    const item = props.available.encoders.find(
      (item) => item.id === encoder,
    );
    const codecs =
      encoder === "auto"
        ? props.available.codecs
        : item?.codecs;
    const disabled =
      !codecs ||
      (codec !== null && !codecs.includes(codec));
    let name =
      encoder === "auto"
        ? label("native_encoder_auto")
        : !item
          ? encoder
          : item.hardware
            ? item.name
                .replace(
                  /\b(?:H[.\s-]?26[45]|VP[89]|AV1)\b/gi,
                  "",
                )
                .replace(/\s+/g, " ")
                .trim()
            : label("software");
    if (item?.hardware && codec !== null) {
      // Different transforms can have the same friendly name. Keep both
      // selectable, but distinguish them without exposing opaque driver IDs.
      const siblings = [
        ...new Set(
          props.available.encoders
            .filter(
              (other) =>
                other.hardware &&
                other.name === item.name &&
                other.codecs.includes(codec),
            )
            .map((other) => other.id),
        ),
      ].sort();
      if (siblings.length > 1)
        name += ` · ${siblings.indexOf(encoder) + 1}`;
    }
    const format = codec
      ? codec
          .replace(/^video\//i, "")
          .toUpperCase()
          .replace(/^H(26[45])$/, "H.$1")
      : label("stream.preferred_video_codec.auto");
    const text =
      encoder === "auto" && codec === null
        ? name
        : (item && !item.hardware && codec !== null) ||
            !name
          ? format
          : `${format} (${name})`;
    return {
      // Select uses IDs in CSS selectors; keep opaque encoder IDs out of them.
      id: btoa(
        encodeURIComponent(
          JSON.stringify([encoder, codec]),
        ),
      ),
      encoder,
      codec,
      label:
        disabled && !props.available.encodingLoading
          ? `${text} (${t("meeting.native_screen.unavailable")})`
          : text,
      disabled,
      group:
        encoder === "auto" || codec === null || !item
          ? null
          : item.hardware
            ? "hardware"
            : "software",
    };
  };
  const selected = createMemo(() =>
    encodingOption(
      appState.options.nativeScreenEncoder ?? "auto",
      appState.options.nativeScreenCodec ?? null,
    ),
  );
  const options = createMemo(() => {
    const seen = new Set<string>();
    const choices = [
      encodingOption("auto", null),
      ...[...props.available.encoders]
        .sort(
          (a, b) => Number(b.hardware) - Number(a.hardware),
        )
        .flatMap((encoder) =>
          encoder.codecs.map((codec) =>
            encodingOption(encoder.id, codec),
          ),
        ),
    ].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    // Keep old automatic-format/automatic-encoder combinations and missing
    // devices visible without rewriting persisted preferences on mount.
    if (!choices.some((item) => item.id === selected().id))
      choices.push(selected());
    const grouped: (EncodingOption | EncodingGroup)[] =
      choices.filter((item) => item.group === null);
    for (const group of ["hardware", "software"] as const) {
      const options = choices.filter(
        (item) => item.group === group,
      );
      if (options.length)
        grouped.push({
          id: group,
          label: label(group),
          options,
        });
    }
    return grouped;
  });
  return (
    <div class="setting-group">
      <SettingHeading
        description={label("native_encoder_description")}
      >
        {label("native_capture")}
      </SettingHeading>

      <Show when={props.available.backendsLoading}>
        <p class="muted" role="status">
          {label("backends_loading")}
        </p>
      </Show>
      <CaptureBackendSelect
        kind="monitor"
        backends={props.available.backends.screen}
        value={
          appState.options.nativeScreenCaptureBackend ??
          "auto"
        }
        disabled={
          props.available.backendsLoading ||
          props.available.backendsFailed
        }
        onChange={(value) =>
          setAppOptions("nativeScreenCaptureBackend", value)
        }
      />
      <CaptureBackendSelect
        kind="window"
        backends={props.available.backends.window}
        value={
          appState.options.nativeWindowCaptureBackend ??
          "auto"
        }
        disabled={
          props.available.backendsLoading ||
          props.available.backendsFailed
        }
        onChange={(value) =>
          setAppOptions("nativeWindowCaptureBackend", value)
        }
      />
      <Show when={props.available.backendsFailed}>
        <p class="muted" role="status">
          {label("backends_unavailable")}
        </p>
      </Show>
      <SettingSelect<NativeReadbackBuffers>
        modal
        value={
          nativeScreenOptions(appState.options)
            .readbackBuffers
        }
        options={[1, 2, 3]}
        onChange={(value) => {
          if (value === 1 || value === 2 || value === 3)
            setAppOptions("nativeReadbackBuffers", value);
        }}
        label={label("readback_buffers")}
        description={label("readback_buffers_description")}
        optionLabel={(option) =>
          label(`readback_buffers_${option}`)
        }
      />
      <SettingSelect<EncodingOption, EncodingGroup>
        modal
        value={selected()}
        disabled={
          props.available.failed ||
          props.available.encodingLoading
        }
        options={options()}
        optionValue="id"
        optionTextValue="label"
        optionDisabled="disabled"
        optionGroupChildren="options"
        onChange={(value) => {
          if (!value || value.disabled) return;
          setAppOptions({
            nativeScreenEncoder: value.encoder,
            nativeScreenCodec: value.codec,
          });
        }}
        sectionComponent={(section) => (
          <SelectSection class="text-muted-foreground px-2 py-1.5 text-xs font-medium">
            {section.section.rawValue.label}
          </SelectSection>
        )}
        label={label("native_encoder")}
        hint={
          <>
            <Show
              when={
                props.available.encodingLoading ||
                props.available.failed
              }
            >
              <p class="muted" role="status">
                {label(
                  props.available.encodingLoading
                    ? "encoders_loading"
                    : "native_unavailable",
                )}
              </p>
            </Show>
          </>
        }
        optionLabel={(option) => option.label}
      />
      <Show
        when={
          !props.available.encodingLoading &&
          !props.available.failed &&
          !selected().disabled
        }
      >
        <div class="setting-group">
          <SettingHeading>
            {label("native_advanced")}
          </SettingHeading>
          <NativeColorSettings />
        </div>
      </Show>
    </div>
  );
}
