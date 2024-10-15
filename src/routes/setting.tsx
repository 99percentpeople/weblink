import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  Show,
} from "solid-js";
import { Input } from "@/components/ui/input";
import { optional } from "@/libs/core/utils/optional";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  clientProfile,
  CompressionLevel,
  setClientProfile,
  setAppOptions,
  appOptions,
  TurnServerOptions,
} from "@/libs/core/store";
import {
  createCameras,
  createMicrophones,
  createSpeakers,
} from "@solid-primitives/devices";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { localStream } from "@/libs/stream";
import { ModeToggle } from "@/components/mode-toggle";
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
      throw Error(`配置格式错误：${line}`);
    const [url, username, password, authMethod] = parts.map(
      (part) => part.trim(),
    );
    // 验证输入
    if (!/^turns?:/.test(url)) {
      throw Error(`URL 格式错误：${url}`);
    }
    if (
      authMethod !== "longterm" &&
      authMethod !== "hmac"
    ) {
      throw Error(
        `认证方式错误，应为 "longterm" 或 "hmac"：${authMethod}`,
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
  return (
    <>
      <div class="container">
        <div class="grid gap-4 py-4">
          <h3 class="h3">Appearance</h3>

          <label class="flex items-center justify-between gap-2">
            <Label>Theme</Label>
            <div class="col-span-2 md:col-span-3">
              <ModeToggle />
            </div>
          </label>

          <Switch
            class="flex items-center justify-between"
            checked={clientProfile.autoJoin}
            onChange={(isChecked) =>
              setClientProfile("autoJoin", isChecked)
            }
          >
            <SwitchLabel>Auto join</SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>

          <h2 class="h3">Connection</h2>
          <label class="flex flex-col gap-2">
            <Label>Stun Servers</Label>
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
          </label>
          <label class="flex flex-col gap-2">
            <Label>Turn Servers</Label>
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
          </label>

          <h3 class="h3">Stream</h3>

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
              <SliderLabel>Video max bitrate</SliderLabel>
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
              <SliderLabel>Audio max bitrate</SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>

          <h2 class="h3">Sender</h2>
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
              <SliderLabel>No. of channels</SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>
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
              <SliderLabel>Chunk size</SliderLabel>
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
              <SliderLabel>Block size</SliderLabel>
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
              <SliderLabel>Max buffer amount</SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>

          <Switch
            class="flex items-center justify-between"
            checked={appOptions.ordered}
            onChange={(isChecked) =>
              setAppOptions("ordered", isChecked)
            }
          >
            <SwitchLabel>Ordered</SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>

          <Slider
            minValue={0}
            maxValue={9}
            step={1}
            defaultValue={[appOptions.compressionLevel]}
            getValueLabel={({ values }) =>
              values[0] === 0
                ? "0 (No Compression)"
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
              <SliderLabel>Compression Level</SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>

          <h2 class="h3">Receiver</h2>
          <Slider
            minValue={1}
            maxValue={128}
            step={1}
            defaultValue={[appOptions.maxMomeryCacheSlices]}
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
                Max number of cached chunk slices
              </SliderLabel>
              <SliderValueLabel />
            </div>
            <SliderTrack>
              <SliderFill />
              <SliderThumb />
              <SliderThumb />
            </SliderTrack>
          </Slider>

          <h2 class="h3">Media</h2>
          <MediaSetting />
        </div>
      </div>
    </>
  );
}

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

  return (
    <>
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
