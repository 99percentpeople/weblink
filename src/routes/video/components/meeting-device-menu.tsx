import { Motion } from "@/components/ui/motion";
import { createMemo, createUniqueId, Show } from "solid-js";
import {
  Camera,
  Mic,
  RefreshCw,
  ShieldAlert,
  Volume2,
  X,
} from "lucide-solid";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { MeetingDeviceControls } from "@/libs/domain/meeting-devices";
export type { MeetingDeviceControls } from "@/libs/domain/meeting-devices";

type DeviceOption = { id: string; label: string };

export function MeetingDeviceField(props: {
  variant?: "meeting" | "dialog";
  devices: MeetingDeviceControls;
  kind: MediaDeviceKind;
  selected: string;
  busy: boolean;
  onSelect(id: string): void | Promise<void>;
}) {
  const id = createUniqueId();
  const access = () =>
    props.devices.access.state(props.kind);
  const options = createMemo(() => [
    ...new Map(
      props.devices
        .list()
        .filter(
          (device) =>
            device.kind === props.kind &&
            device.deviceId &&
            device.deviceId !== "default",
        )
        .map((device) => [device.deviceId, device]),
    ).values(),
  ]);
  const family = () =>
    props.kind === "audioinput"
      ? "microphone"
      : props.kind === "audiooutput"
        ? "speaker"
        : "camera";
  const missing = () =>
    props.selected &&
    !options().some(
      (device) => device.deviceId === props.selected,
    );
  const emptyKey = () =>
    props.kind === "audioinput"
      ? "meeting.no_microphones"
      : props.kind === "audiooutput"
        ? "meeting.no_speakers"
        : "meeting.no_cameras";
  const choices = createMemo<DeviceOption[]>(() => [
    { id: "", label: t("meeting.default_device") },
    ...(missing()
      ? [
          {
            id: props.selected,
            label: t("meeting.device_unavailable"),
          },
        ]
      : []),
    ...options().map((device, index) => ({
      id: device.deviceId,
      label:
        device.label ||
        t(`meeting.unnamed_${family()}`, {
          count: index + 1,
        }),
    })),
  ]);
  // Select also emits onChange when reconciling refreshed options. Only
  // an explicit pointer/keyboard choice may switch a live capture device.
  let choosing = false;
  const beginChoice = () => {
    choosing = true;
    queueMicrotask(() => {
      choosing = false;
    });
  };
  return (
    <div
      data-device-kind={props.kind}
      class={
        props.variant === "dialog"
          ? "flex min-w-0 flex-col gap-2 text-sm"
          : "meeting-device-field"
      }
    >
      <label
        for={id}
        class={
          props.variant === "dialog"
            ? "flex items-center gap-2 [&>svg]:size-4"
            : "meeting-device-label"
        }
      >
        <Show
          when={props.kind === "videoinput"}
          fallback={
            <Show
              when={props.kind === "audioinput"}
              fallback={<Volume2 />}
            >
              <Mic />
            </Show>
          }
        >
          <Camera />
        </Show>
        {t(`meeting.${family()}_device`)}
      </label>
      <Show when={access() !== "unsupported"}>
        <Select<DeviceOption>
          options={choices()}
          // Kobalte reserves an empty key for an unselected value.
          optionValue={(choice) => `device:${choice.id}`}
          optionTextValue="label"
          value={choices().find(
            (choice) => choice.id === props.selected,
          )}
          onChange={(choice) => {
            if (!choosing || !choice) return;
            choosing = false;
            void props.onSelect(choice.id);
          }}
          disallowEmptySelection
          modal={props.variant === "dialog"}
          disabled={
            props.busy ||
            access() !== "granted" ||
            props.devices.refreshing() ||
            (options().length === 0 && !props.selected)
          }
          itemComponent={(itemProps) => (
            <SelectItem
              item={itemProps.item}
              data-device-id={itemProps.item.rawValue.id}
              onPointerUp={beginChoice}
              onClick={beginChoice}
              onKeyDown={beginChoice}
            >
              {itemProps.item.rawValue.label}
            </SelectItem>
          )}
        >
          <SelectTrigger
            id={id}
            role="combobox"
            aria-label={t(`meeting.${family()}_device`)}
            data-device-id={props.selected}
            onKeyDown={beginChoice}
            class={
              props.variant === "dialog"
                ? "h-10"
                : "meeting-device-select-trigger"
            }
          >
            <SelectValue<DeviceOption>>
              {(state) => state.selectedOption().label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            data-meeting-device-popup={
              props.variant !== "dialog" ? "" : undefined
            }
            class={cn(
              `max-h-[min(20rem,var(--kb-popper-content-available-height))]
              overflow-y-auto`,
              props.variant !== "dialog" &&
                "meeting-device-select-content",
            )}
          />
        </Select>
      </Show>
      <Show
        when={
          access() !== "granted" || options().length === 0
        }
      >
        <span
          role="status"
          class={
            props.variant === "dialog"
              ? "text-muted-foreground text-xs"
              : "meeting-device-hint"
          }
        >
          {t(
            access() === "checking"
              ? "meeting.permission_checking"
              : access() === "prompt"
                ? "meeting.permission_needed"
                : access() === "denied"
                  ? "meeting.device_disabled"
                  : access() === "unsupported"
                    ? props.kind === "audiooutput"
                      ? "meeting.output_unsupported"
                      : "meeting.media_unavailable"
                    : emptyKey(),
          )}
        </span>
      </Show>
      <Show when={access() === "denied"}>
        <span
          class={
            props.variant === "dialog"
              ? "text-muted-foreground text-xs"
              : "meeting-device-hint"
          }
        >
          {t("meeting.permission_disabled_hint")}
        </span>
      </Show>
      <Show
        when={
          access() === "prompt" &&
          props.variant === "dialog"
        }
      >
        <Show
          when={
            props.kind === "audiooutput" &&
            props.devices.access.outputNeedsMicrophone()
          }
        >
          <span class="text-muted-foreground text-xs">
            {t("meeting.output_permission_hint")}
          </span>
        </Show>
        <button
          type="button"
          class="border-input hover:bg-muted self-start rounded-md border
            px-3 py-1.5 text-xs disabled:opacity-50"
          disabled={
            props.devices.access.requesting() !== null
          }
          aria-label={t(
            "meeting.request_device_permission",
            { device: t(`meeting.${family()}_device`) },
          )}
          onClick={() =>
            void props.devices.access.request(props.kind)
          }
        >
          {t(
            props.devices.access.requesting() === props.kind
              ? "meeting.permission_requesting"
              : "meeting.get_permission",
          )}
        </button>
      </Show>
    </div>
  );
}

export function MeetingDeviceMenu(props: {
  mode: "audio" | "camera";
  devices: MeetingDeviceControls;
  microphoneBusy: boolean;
  cameraBusy: boolean;
  playingAudio: boolean;
  hasAudio: boolean;
  onToggleAudio(): void;
  onClose(): void;
}) {
  const permissionTarget = () => {
    const kinds: MediaDeviceKind[] =
      props.mode === "camera"
        ? ["videoinput"]
        : [
            "audioinput",
            ...(props.devices.outputSupported()
              ? ["audiooutput" as const]
              : []),
          ];
    const requesting = props.devices.access.requesting();
    if (requesting && kinds.includes(requesting))
      return requesting;
    return kinds.find(
      (kind) =>
        props.devices.access.state(kind) === "prompt",
    );
  };
  const requestPermission = () => {
    const kind = permissionTarget();
    if (
      !kind ||
      props.devices.access.requesting() ||
      props.devices.access.state(kind) !== "prompt"
    )
      return;
    // Call directly from the click; a native speaker picker needs user activation.
    void props.devices.access.request(kind);
  };
  return (
    <Motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      id="meeting-device-menu"
      class="meeting-device-menu"
      aria-label={t(
        props.mode === "audio"
          ? "meeting.audio_devices"
          : "meeting.camera_devices",
      )}
    >
      <header class="meeting-device-menu-header">
        <span>
          {t(
            props.mode === "audio"
              ? "meeting.audio_devices"
              : "meeting.camera_devices",
          )}
        </span>
        <Show when={permissionTarget()}>
          <button
            class="meeting-icon-button meeting-permission-button"
            type="button"
            aria-label={t("meeting.get_permission")}
            title={t("meeting.request_device_permission", {
              device: t(
                permissionTarget() === "audioinput"
                  ? "meeting.microphone_device"
                  : permissionTarget() === "audiooutput"
                    ? "meeting.speaker_device"
                    : "meeting.camera_device",
              ),
            })}
            disabled={
              props.devices.access.requesting() !== null
            }
            onClick={requestPermission}
          >
            <ShieldAlert />
            <span>
              {t(
                props.devices.access.requesting()
                  ? "meeting.permission_requesting"
                  : "meeting.get_permission",
              )}
            </span>
          </button>
        </Show>
        <button
          class="meeting-icon-button"
          type="button"
          disabled={props.devices.refreshing()}
          aria-label={t("meeting.refresh_devices")}
          title={t("meeting.refresh_devices")}
          onClick={props.devices.refresh}
        >
          <RefreshCw />
        </button>
        <button
          class="meeting-icon-button"
          type="button"
          aria-label={t("meeting.close_device_menu")}
          title={t("meeting.close_device_menu")}
          onClick={props.onClose}
        >
          <X />
        </button>
      </header>
      <div class="meeting-device-fields">
        <Show
          when={props.mode === "audio"}
          fallback={
            <MeetingDeviceField
              devices={props.devices}
              kind="videoinput"
              selected={props.devices.cameraId()}
              busy={props.cameraBusy}
              onSelect={props.devices.selectCamera}
            />
          }
        >
          <MeetingDeviceField
            devices={props.devices}
            kind="audioinput"
            selected={props.devices.microphoneId()}
            busy={props.microphoneBusy}
            onSelect={props.devices.selectMicrophone}
          />
          <Show
            when={props.devices.outputSupported()}
            fallback={
              <p class="meeting-device-hint">
                {t("meeting.output_unsupported")}
              </p>
            }
          >
            <MeetingDeviceField
              devices={props.devices}
              kind="audiooutput"
              selected={props.devices.outputId()}
              busy={props.devices.outputBusy()}
              onSelect={props.devices.selectOutput}
            />
          </Show>
        </Show>
      </div>
      <Show when={props.mode === "audio"}>
        <button
          type="button"
          class="meeting-device-sound"
          disabled={!props.hasAudio}
          aria-pressed={props.playingAudio}
          onClick={props.onToggleAudio}
          aria-label={
            props.playingAudio
              ? t("video.global_mute")
              : t("video.global_unmute")
          }
        >
          <Volume2 />
          {props.playingAudio
            ? t("video.global_mute")
            : t("video.global_unmute")}
        </button>
      </Show>
    </Motion.section>
  );
}
