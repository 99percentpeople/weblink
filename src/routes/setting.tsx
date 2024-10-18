import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  Show,
} from "solid-js";

import { optional } from "@/libs/core/utils/optional";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  clientProfile,
  setClientProfile,
} from "@/libs/core/store";
import {
  createCameras,
  createMicrophones,
  createSpeakers,
} from "@solid-primitives/devices";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { localStream } from "@/libs/stream";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import {
  formatBitSize,
  formatBtyeSize,
} from "@/libs/utils/format-filesize";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { textareaAutoResize } from "@/libs/hooks/input-resize";
import { reconcile } from "solid-js/store";
import { LocaleSelector, t } from "@/i18n";
import {
  TurnServerOptions,
  appOptions,
  setAppOptions,
  CompressionLevel,
  getDefaultAppOptions,
} from "@/options";
import createAboutDialog from "@/components/about-dialog";
import { Button } from "@/components/ui/button";
import { IconDelete, IconInfo } from "@/components/icons";
import { Separator } from "@/components/ui/seprartor";
import { createDialog } from "@/components/dialogs/dialog";
import { toast } from "solid-sonner";

type MediaDeviceInfoType = Omit<MediaDeviceInfo, "toJSON">;

export const [camera, setCamera] =
  createSignal<MediaDeviceInfoType | null>();

export const [microphone, setMicrophone] =
  createSignal<MediaDeviceInfoType | null>();

export const [speaker, setSpeaker] =
  createSignal<MediaDeviceInfoType | null>();

textareaAutoResize;
function parseTurnServers(
  input: string,
): TurnServerOptions[] {
  const lines = input.split("\n");
  const turnServers = lines.map((line) => {
    const parts = line.split("|");
    if (parts.length !== 4)
      throw Error(`config error: ${line}`);
    const [url, username, password, authMethod] = parts.map(
      (part) => part.trim(),
    );
    if (!/^turns?:/.test(url)) {
      throw Error(`URL format error: ${url}`);
    }
    if (
      authMethod !== "longterm" &&
      authMethod !== "hmac"
    ) {
      throw Error(
        `auth method error, should be "longterm" or "hmac": ${authMethod}`,
      );
    }
    return {
      url,
      username,
      password,
      authMethod,
    } satisfies TurnServerOptions;
  });
  return turnServers;
}

export default function Settings() {
  const { open, Component: AboutDialogComponent } =
    createAboutDialog();
  const {
    open: openResetOptionsDialog,
    Component: ResetOptionsDialogComponent,
  } = createResetOptionsDialog();
  return (
    <>
      <AboutDialogComponent />
      <ResetOptionsDialogComponent />
      <div class="container">
        <div class="grid gap-4 py-4">
          <h3 id="appearance" class="h3">
            {t("setting.appearance.title")}
          </h3>

          <label class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <Label>
                {t("setting.appearance.theme.title")}
              </Label>

              <div class="ml-auto">
                <ThemeToggle />
              </div>
            </div>
            <p class="muted">
              {t("setting.appearance.theme.description")}
            </p>
          </label>

          <label class="flex flex-col gap-2">
            <Label>
              {t("setting.appearance.language.title")}
            </Label>
            <LocaleSelector />
            <p class="muted">
              {t("setting.appearance.language.description")}
            </p>
          </label>

          <h3 id="connection" class="h3">
            {t("setting.connection.title")}
          </h3>
          <div class="flex flex-col gap-2">
            <Switch
              disabled={clientProfile.firstTime}
              class="flex items-center justify-between"
              checked={clientProfile.autoJoin}
              onChange={(isChecked) =>
                setClientProfile("autoJoin", isChecked)
              }
            >
              <SwitchLabel>
                {t("setting.connection.auto_join.title")}
              </SwitchLabel>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
            <p class="muted">
              {t(
                "setting.connection.auto_join.description",
              )}
            </p>
          </div>
          <label class="flex flex-col gap-2">
            <Label>
              {t("setting.connection.stun_servers.title")}
            </Label>
            <Textarea
              placeholder="stun.l.google.com:19302"
              ref={(ref) => {
                createEffect(() => {
                  textareaAutoResize(ref, () =>
                    appOptions.servers.stuns.toString(),
                  );
                });
              }}
              value={appOptions.servers.stuns.join("\n")}
              onInput={(ev) =>
                setAppOptions(
                  "servers",
                  "stuns",
                  optional(ev.currentTarget.value)?.split(
                    "\n",
                  ) ?? [],
                )
              }
            />
            <p class="muted">
              {t(
                "setting.connection.stun_servers.description",
              )}
            </p>
          </label>
          <label class="flex flex-col gap-2">
            <Label>
              {t("setting.connection.turn_servers.title")}
            </Label>
            <Textarea
              ref={(ref) => {
                createEffect(() => {
                  textareaAutoResize(
                    ref,
                    () =>
                      appOptions.servers.turns?.toString() ??
                      "",
                  );
                });
              }}
              placeholder={
                "turn:turn1.example.com:3478|user1|pass1|longterm\nturns:turn2.example.com:5349|user2|pass2|hmac"
              }
              value={appOptions.servers.turns
                ?.map((trun) => {
                  return `${trun.url}|${trun.username}|${trun.password}|${trun.authMethod}`;
                })
                .join("\n")}
              onInput={(ev) =>
                setAppOptions(
                  "servers",
                  "turns",
                  reconcile(
                    parseTurnServers(
                      ev.currentTarget.value,
                    ),
                  ),
                )
              }
            />
            <p class="muted">
              {t(
                "setting.connection.turn_servers.description",
              )}
            </p>
          </label>

          <h3 id="stream" class="h3">
            {t("setting.stream.title")}
          </h3>
          <label class="flex flex-col gap-2">
            <Slider
              minValue={512 * 1024}
              maxValue={200 * 1024 * 1024}
              step={512 * 1024}
              defaultValue={[appOptions.videoMaxBitrate]}
              getValueLabel={({ values }) =>
                `${formatBitSize(values[0], 0)}ps`
              }
              class="gap-2"
              onChange={(value) => {
                setAppOptions("videoMaxBitrate", value[0]);
              }}
            >
              <div class="flex w-full justify-between">
                <SliderLabel>
                  {t(
                    "setting.stream.video_max_bitrate.title",
                  )}
                </SliderLabel>
                <SliderValueLabel />
              </div>
              <SliderTrack>
                <SliderFill />
                <SliderThumb />
                <SliderThumb />
              </SliderTrack>
            </Slider>
            <p class="muted">
              {t(
                "setting.stream.video_max_bitrate.description",
              )}
            </p>
          </label>
          <label class="flex flex-col gap-2">
            <Slider
              minValue={1024}
              maxValue={512 * 1024}
              step={1024}
              defaultValue={[appOptions.audioMaxBitrate]}
              getValueLabel={({ values }) =>
                `${formatBitSize(values[0], 0)}ps`
              }
              class="gap-2"
              onChange={(value) => {
                setAppOptions("audioMaxBitrate", value[0]);
              }}
            >
              <div class="flex w-full justify-between">
                <SliderLabel>
                  {t(
                    "setting.stream.audio_max_bitrate.title",
                  )}
                </SliderLabel>
                <SliderValueLabel />
              </div>
              <SliderTrack>
                <SliderFill />
                <SliderThumb />
                <SliderThumb />
              </SliderTrack>
            </Slider>
            <p class="muted">
              {t(
                "setting.stream.audio_max_bitrate.description",
              )}
            </p>
          </label>

          <h3 id="sender" class="h3">
            {t("setting.sender.title")}
          </h3>
          <label class="flex flex-col gap-2">
            <Slider
              minValue={1}
              maxValue={8}
              defaultValue={[appOptions.channelsNumber]}
              class="gap-2"
              onChange={(value) => {
                setAppOptions("channelsNumber", value[0]);
              }}
            >
              <div class="flex w-full justify-between">
                <SliderLabel>
                  {t("setting.sender.num_channels.title")}
                </SliderLabel>
                <SliderValueLabel />
              </div>
              <SliderTrack>
                <SliderFill />
                <SliderThumb />
                <SliderThumb />
              </SliderTrack>
            </Slider>
            <p class="muted">
              {t("setting.sender.num_channels.description")}
            </p>
          </label>

          <Slider
            minValue={appOptions.blockSize}
            maxValue={1024 * 1024 * 10}
            step={appOptions.blockSize}
            defaultValue={[appOptions.chunkSize]}
            class="gap-2"
            getValueLabel={({ values }) =>
              formatBtyeSize(values[0], 2)
            }
            onChange={(value) => {
              setAppOptions("chunkSize", value[0]);
            }}
          >
            <div class="flex w-full justify-between">
              <SliderLabel>
                {t("setting.sender.chunk_size.title")}
              </SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>
          <Slider
            minValue={16 * 1024}
            maxValue={200 * 1024}
            step={1024}
            defaultValue={[appOptions.blockSize]}
            class="gap-2"
            getValueLabel={({ values }) =>
              formatBtyeSize(values[0], 0)
            }
            onChange={(value) => {
              setAppOptions("blockSize", value[0]);
            }}
          >
            <div class="flex w-full justify-between">
              <SliderLabel>
                {t("setting.sender.block_size.title")}
              </SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>
          <Slider
            minValue={1024}
            maxValue={1024 * 1024 * 8}
            step={1024}
            defaultValue={[
              appOptions.bufferedAmountLowThreshold,
            ]}
            getValueLabel={({ values }) =>
              formatBtyeSize(values[0], 2)
            }
            class="gap-2"
            onChange={(value) => {
              setAppOptions(
                "bufferedAmountLowThreshold",
                value[0],
              );
            }}
          >
            <div class="flex w-full justify-between">
              <SliderLabel>
                {t(
                  "setting.sender.max_buffer_amount.title",
                )}
              </SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>

          <div class="flex flex-col gap-2">
            <Switch
              class="flex items-center justify-between"
              checked={appOptions.ordered}
              onChange={(isChecked) =>
                setAppOptions("ordered", isChecked)
              }
            >
              <SwitchLabel>
                {t("setting.sender.ordered.title")}
              </SwitchLabel>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
            <p class="muted">
              {t("setting.sender.ordered.description")}
            </p>
          </div>
          <label class="flex flex-col gap-2">
            <Slider
              minValue={0}
              maxValue={9}
              step={1}
              defaultValue={[appOptions.compressionLevel]}
              getValueLabel={({ values }) =>
                values[0] === 0
                  ? t(
                      "setting.sender.compression_level.no_compression",
                    )
                  : `${values[0]}`
              }
              class="gap-2"
              onChange={(value) => {
                setAppOptions(
                  "compressionLevel",
                  value[0] as CompressionLevel,
                );
              }}
            >
              <div class="flex w-full justify-between">
                <SliderLabel>
                  {t(
                    "setting.sender.compression_level.title",
                  )}
                </SliderLabel>
                <SliderValueLabel />
              </div>
              <SliderTrack>
                <SliderFill />
                <SliderThumb />
                <SliderThumb />
              </SliderTrack>
            </Slider>
            <p class="muted">
              {t(
                "setting.sender.compression_level.description",
              )}
            </p>
          </label>
          <h3 id="receiver" class="h3">
            {t("setting.receiver.title")}
          </h3>
          <label class="flex flex-col gap-2">
            <Slider
              minValue={1}
              maxValue={128}
              step={1}
              defaultValue={[
                appOptions.maxMomeryCacheSlices,
              ]}
              getValueLabel={({ values }) =>
                `${values[0]} (${formatBtyeSize(values[0] * appOptions.chunkSize, 0)})`
              }
              class="gap-2"
              onChange={(value) => {
                setAppOptions(
                  "maxMomeryCacheSlices",
                  value[0],
                );
              }}
            >
              <div class="flex w-full justify-between">
                <SliderLabel>
                  {t(
                    "setting.receiver.max_cached_chunks.title",
                  )}
                </SliderLabel>
                <SliderValueLabel />
              </div>
              <SliderTrack>
                <SliderFill />
                <SliderThumb />
                <SliderThumb />
              </SliderTrack>
            </Slider>
            <p class="muted">
              {t(
                "setting.receiver.max_cached_chunks.description",
              )}
            </p>
          </label>

          <MediaSetting />

          <Separator />
          <label class="flex flex-col gap-2">
            <Button
              variant="destructive"
              onClick={async () => {
                if (
                  (await openResetOptionsDialog()).result
                ) {
                  setAppOptions(getDefaultAppOptions());
                  toast.success(
                    t(
                      "common.notification.reset_options_success",
                    ),
                  );
                }
              }}
              class="gap-2"
            >
              <IconDelete class="size-4" />
              {t("setting.about.reset_options")}
            </Button>
          </label>

          <label class="flex flex-col gap-2">
            <Button onClick={() => open()} class="gap-2">
              <IconInfo class="size-4" />
              {t("setting.about.title")}
            </Button>
          </label>
        </div>
      </div>
    </>
  );
}

const createResetOptionsDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: () => t("common.reset_options_dialog.title"),
    description: () =>
      t("common.reset_options_dialog.description"),
    content: () => (
      <p>{t("common.reset_options_dialog.content")}</p>
    ),
    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
  });
  return {
    open,
    Component,
  };
};

const MediaSetting: Component = () => {
  const cameras = createCameras();
  const microphones = createMicrophones();
  const speakers = createSpeakers();

  const availableCameras = createMemo(() =>
    cameras().filter((cam) => cam.deviceId !== ""),
  );
  const availableMicrophones = createMemo(() =>
    microphones().filter((mic) => mic.deviceId !== ""),
  );
  const availableSpeakers = createMemo(() =>
    speakers().filter((speaker) => speaker.deviceId !== ""),
  );

  const availableDevices = createMemo(() => {
    return [
      ...availableCameras(),
      ...availableMicrophones(),
      ...availableSpeakers(),
    ];
  });

  return (
    <>
      <Show when={availableDevices().length !== 0}>
        <h3 id="media" class="h3">
          {t("setting.media.title")}
        </h3>
      </Show>
      <Show when={availableCameras().length !== 0}>
        <label class="flex flex-col gap-2">
          <Label>Camera</Label>
          <Select
            defaultValue={camera()}
            value={camera()}
            onChange={(value) => {
              setCamera(value);
            }}
            options={cameras()}
            optionTextValue="label"
            optionValue="deviceId"
            itemComponent={(props) => (
              <SelectItem
                item={props.item}
                value={props.item.rawValue?.deviceId}
              >
                {props.item.rawValue?.label}
              </SelectItem>
            )}
          >
            <SelectTrigger>
              <SelectValue<MediaDeviceInfoType>>
                {(state) =>
                  state.selectedOption().label.length === 0
                    ? "Default"
                    : state.selectedOption().label
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </label>
      </Show>
      <Show when={availableMicrophones().length !== 0}>
        <label class="flex flex-col gap-2">
          <Label>Microphone</Label>
          <Select
            value={microphone()}
            onChange={(value) => {
              setMicrophone(value);
            }}
            options={microphones()}
            optionTextValue="label"
            optionValue="deviceId"
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {props.item.rawValue?.label}
              </SelectItem>
            )}
          >
            <SelectTrigger>
              <SelectValue<MediaDeviceInfoType>>
                {(state) => state.selectedOption().label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </label>
      </Show>
      <Show when={availableSpeakers().length !== 0}>
        <label class="flex flex-col gap-2">
          <Label>Speaker</Label>
          <Select
            value={speaker()}
            onChange={(value) => {
              setSpeaker(value);
            }}
            options={speakers()}
            optionTextValue="label"
            optionValue="deviceId"
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {props.item.rawValue?.label}
              </SelectItem>
            )}
          >
            <SelectTrigger>
              <SelectValue<MediaDeviceInfoType>>
                {(state) => state.selectedOption().label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </label>
      </Show>
      <Show when={localStream()}>
        <video
          class="max-h-64 w-full object-contain"
          muted
          autoplay
          controls
          ref={(ref) => {
            createEffect(() => {
              ref.srcObject = localStream();
            });
          }}
        />
      </Show>
    </>
  );
};
