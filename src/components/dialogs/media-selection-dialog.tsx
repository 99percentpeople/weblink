import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { createDialog } from "@/components/dialogs/dialog";
import {
  IconInfo,
  IconMonitor,
  IconSettings,
  IconVideoCam,
} from "@/components/icons";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createStore } from "solid-js/store";
import { Button } from "@/components/ui/button";
import {
  createMicrophones,
  createCameras,
} from "@/libs/utils/devices";
import { catchError } from "@/libs/catch";
import { toast } from "solid-sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createPermission } from "@solid-primitives/permission";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { t } from "@/i18n";
import {
  createLocalMediaStream,
  localStream,
  mergeMediaStreamTracks,
  stopMediaStream,
} from "@/libs/stream";
import { cn } from "@/libs/cn";
import {
  createPresetMicrophoneConstraintsDialog,
  createPresetSpeakerTrackConstraintsDialog,
  createPresetVideoConstraintsDialog,
} from "@/components/dialogs/media-constraints-dialogs";
import { makePersisted } from "@solid-primitives/storage";
import { VideoDisplay } from "@/routes/video/components/video-display";
import { appState } from "@/libs/state/app-state";

export type MediaDeviceInfoType = {
  label: string;
  deviceId: string;
};

const [devices, setDevices] = createStore<{
  camera: MediaDeviceInfoType | null;
  microphone: MediaDeviceInfoType | null;
  programAudio: MediaDeviceInfoType | null;
  screenAudio: MediaDeviceInfoType | null;
}>({
  camera: null,
  microphone: null,
  programAudio: null,
  screenAudio: null,
});

const canGetDisplayMedia =
  "mediaDevices" in navigator &&
  "getDisplayMedia" in navigator.mediaDevices;

const canGetUserMedia =
  "mediaDevices" in navigator &&
  "getUserMedia" in navigator.mediaDevices;

const [enableScreenSpeaker, setEnableScreenSpeaker] =
  makePersisted(createSignal(true), {
    name: "enableScreenSpeaker",
    storage: sessionStorage,
  });
const [enableScreenMicrophone, setEnableScreenMicrophone] =
  makePersisted(createSignal(false), {
    name: "enableScreenMicrophone",
    storage: sessionStorage,
  });

const [enableUserMicrophone, setEnableUserMicrophone] =
  makePersisted(createSignal(true), {
    name: "enableUserMicrophone",
    storage: sessionStorage,
  });
const [enableUserCamera, setEnableUserCamera] =
  makePersisted(createSignal(true), {
    name: "enableUserCamera",
    storage: sessionStorage,
  });
const [enableUserProgramAudio, setEnableUserProgramAudio] =
  makePersisted(createSignal(false), {
    name: "enableUserProgramAudio",
    storage: sessionStorage,
  });

export const createMediaSelectionDialog = () => {
  const cameras = createCameras();
  const microphones = createMicrophones();

  const availableCameras = createMemo(() => {
    return cameras()
      .filter((camera) => camera.deviceId !== "")
      .map((camera) => ({
        label: camera.label,
        deviceId: camera.deviceId,
      }));
  });

  const availableMicrophones = createMemo(() => {
    return microphones()
      .filter((microphone) => microphone.deviceId !== "")
      .map((microphone) => ({
        label: microphone.label,
        deviceId: microphone.deviceId,
      }));
  });

  const [selectedTab, setSelectedTab] = createSignal(
    canGetDisplayMedia ? "screen" : "user",
  );

  const [stream, setStream] =
    createSignal<MediaStream | null>(null);

  const cameraPermission = createPermission("camera");
  const microphonePermission =
    createPermission("microphone");

  const canUseScreenSpeaker = createMemo(() => {
    return enableScreenSpeaker();
  });
  const canUseScreenMicrophone = createMemo(() => {
    return (
      enableScreenMicrophone() &&
      availableMicrophones().length !== 0 &&
      microphonePermission() === "granted"
    );
  });

  const canUseUserMicrophone = createMemo(() => {
    return (
      enableUserMicrophone() &&
      availableMicrophones().length !== 0 &&
      microphonePermission() === "granted"
    );
  });

  const canUseUserCamera = createMemo(() => {
    return (
      enableUserCamera() &&
      availableCameras().length !== 0 &&
      cameraPermission() === "granted"
    );
  });

  const canUseUserProgramAudio = createMemo(() => {
    return (
      enableUserProgramAudio() &&
      availableMicrophones().length !== 0 &&
      microphonePermission() === "granted"
    );
  });

  const openAudioInput = async (
    device: MediaDeviceInfoType | null,
    constraints: MediaTrackConstraints,
  ) => {
    const audioConstraints = { ...constraints };

    if (device?.deviceId) {
      audioConstraints.deviceId = {
        exact: device.deviceId,
      };
    }

    return catchError(
      navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      }),
    );
  };

  const getProgramAudioConstraints =
    (): MediaTrackConstraints => ({
      autoGainControl:
        appState.media.constraints.speaker.autoGainControl,
      echoCancellation:
        appState.media.constraints.speaker.echoCancellation,
      noiseSuppression:
        appState.media.constraints.speaker.noiseSuppression,
    });

  const closeStream = () => {
    stopMediaStream(stream());
    setStream(null);
  };

  const openScreen = async (
    enableSpeaker: boolean = true,
    enableMicrophone: boolean = false,
  ) => {
    const screenAudioInput =
      enableSpeaker && devices.screenAudio
        ? devices.screenAudio
        : null;

    if (
      enableMicrophone &&
      screenAudioInput &&
      screenAudioInput.deviceId ===
        devices.microphone?.deviceId
    ) {
      toast.error(
        t(
          "common.media_selection_dialog.distinct_audio_inputs_required",
        ),
      );
      return;
    }

    const [err, displayMedia] = await catchError(
      navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "monitor",
          ...appState.media.constraints.video,
        },
        audio:
          enableSpeaker && !screenAudioInput
            ? { ...appState.media.constraints.speaker }
            : false,
      }),
    );
    if (err) {
      toast.error(err.message);
      return;
    }

    const local = createLocalMediaStream([
      {
        stream: displayMedia,
        kind: "audio",
        contentHint: "music",
      },
      {
        stream: displayMedia,
        kind: "video",
        contentHint: "motion",
      },
    ]);

    if (screenAudioInput) {
      const [screenAudioErr, screenAudioMedia] =
        await openAudioInput(
          screenAudioInput,
          getProgramAudioConstraints(),
        );
      if (screenAudioErr) {
        toast.error(screenAudioErr.message);
      } else {
        mergeMediaStreamTracks(local, screenAudioMedia, {
          kind: "audio",
          contentHint: "music",
        });
      }
    }

    if (enableMicrophone) {
      const [microphoneErr, microphoneMedia] =
        await openAudioInput(
          devices.microphone,
          appState.media.constraints.microphone,
        );
      if (microphoneErr) {
        toast.error(microphoneErr.message);
      } else {
        mergeMediaStreamTracks(local, microphoneMedia, {
          kind: "audio",
          contentHint: "speech",
        });
      }
    }

    setStream(local);
  };

  const openCamera = async (
    enableCamera: boolean = true,
    enableMicrophone: boolean = true,
    enableProgramAudio: boolean = false,
  ) => {
    if (
      !enableCamera &&
      !enableMicrophone &&
      !enableProgramAudio
    ) {
      toast.error(
        t(
          "common.media_selection_dialog.enable_source_required",
        ),
      );
      return;
    }

    if (
      enableMicrophone &&
      enableProgramAudio &&
      devices.microphone &&
      devices.programAudio &&
      devices.microphone.deviceId ===
        devices.programAudio.deviceId
    ) {
      toast.error(
        t(
          "common.media_selection_dialog.distinct_audio_inputs_required",
        ),
      );
      return;
    }

    const local = new MediaStream();

    if (enableCamera && availableCameras().length !== 0) {
      const videoConstraints: MediaTrackConstraints = {
        ...appState.media.constraints.video,
      };

      if (devices.camera?.deviceId) {
        videoConstraints.deviceId = {
          exact: devices.camera.deviceId,
        };
      }

      const [cameraErr, cameraMedia] = await catchError(
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints,
        }),
      );
      if (cameraErr) {
        toast.error(cameraErr.message);
      } else {
        mergeMediaStreamTracks(local, cameraMedia, {
          kind: "video",
          contentHint: "motion",
        });
      }
    }

    if (
      enableMicrophone &&
      availableMicrophones().length !== 0
    ) {
      const [microphoneErr, microphoneMedia] =
        await openAudioInput(
          devices.microphone,
          appState.media.constraints.microphone,
        );
      if (microphoneErr) {
        toast.error(microphoneErr.message);
      } else {
        mergeMediaStreamTracks(local, microphoneMedia, {
          kind: "audio",
          contentHint: "speech",
        });
      }
    }

    if (
      enableProgramAudio &&
      availableMicrophones().length !== 0
    ) {
      const [programAudioErr, programAudioMedia] =
        await openAudioInput(
          devices.programAudio,
          getProgramAudioConstraints(),
        );
      if (programAudioErr) {
        toast.error(programAudioErr.message);
      } else {
        mergeMediaStreamTracks(local, programAudioMedia, {
          kind: "audio",
          contentHint: "music",
        });
      }
    }

    if (local.getTracks().length === 0) return;

    setStream(local);
  };

  createEffect<AbortController | undefined>((prev) => {
    prev?.abort();

    const currentStream = stream();
    if (!currentStream) return;

    const controller = new AbortController();
    currentStream.getTracks().forEach((track) => {
      track.addEventListener(
        "ended",
        () => {
          track.stop();
          currentStream.removeTrack(track);
          if (currentStream.getTracks().length === 0) {
            setStream(null);
          }
        },
        { signal: controller.signal },
      );
    });

    return controller;
  });

  const { open: openMicrophoneConstraintsDialog } =
    createPresetMicrophoneConstraintsDialog();

  const { open: openSpeakerConstraintsDialog } =
    createPresetSpeakerTrackConstraintsDialog();

  const { open: openVideoConstraintsDialog } =
    createPresetVideoConstraintsDialog();

  const requestMicrophonePermission = async () => {
    if (!("mediaDevices" in navigator)) {
      toast.error(
        "Your browser does not support media devices",
      );
      return;
    }
    const [err, local] = await catchError(
      navigator.mediaDevices.getUserMedia({
        audio: true,
      }),
    );
    if (err) {
      toast.error(err.message);
      return;
    }
    local.getTracks().forEach((track) => {
      track.stop();
      local?.removeTrack(track);
    });
  };

  const requestCameraPermission = async () => {
    if (!("mediaDevices" in navigator)) {
      toast.error(
        "Your browser does not support media devices",
      );
      return;
    }
    const [err, local] = await catchError(
      navigator.mediaDevices.getUserMedia({
        video: true,
      }),
    );
    if (err) {
      toast.error(err.message);
      return;
    }
    local.getTracks().forEach((track) => {
      track.stop();
      local?.removeTrack(track);
    });
  };

  const { open, close, submit } = createDialog<MediaStream>(
    {
      title: () => t("common.media_selection_dialog.title"),
      content: () => (
        <Tabs
          value={selectedTab()}
          onChange={(value) => setSelectedTab(value)}
          class="flex flex-col gap-2 overflow-y-auto"
        >
          <TabsList>
            <TabsTrigger value="screen" class="gap-1">
              <IconMonitor class="size-4" />
              <span>
                {t("common.media_selection_dialog.screen")}
              </span>
            </TabsTrigger>
            <TabsTrigger value="user" class="gap-1">
              <IconVideoCam class="size-4" />
              <span>
                {t(
                  "common.media_selection_dialog.media_device",
                )}
              </span>
            </TabsTrigger>
            <TabsIndicator />
          </TabsList>
          <Show
            when={stream()}
            fallback={
              <VideoDisplay
                class="bg-muted aspect-video w-full rounded-lg"
                stream={localStream()}
                name={t(
                  "common.media_selection_dialog.current",
                )}
                avatar={
                  appState.profile.avatar ?? undefined
                }
              />
            }
          >
            <VideoDisplay
              class="bg-muted aspect-video w-full rounded-lg"
              stream={stream()}
              muted={true}
              name={t(
                "common.media_selection_dialog.preview",
              )}
              avatar={appState.profile.avatar ?? undefined}
            />
          </Show>
          <TabsContent
            value="screen"
            class="flex flex-col gap-2"
          >
            <div class="flex gap-2">
              <Show
                when={
                  microphones().length !== 0 &&
                  microphonePermission() === "prompt"
                }
              >
                <Button
                  size="sm"
                  class="flex-1"
                  onClick={requestMicrophonePermission}
                >
                  {t(
                    "common.media_selection_dialog.request_microphone_permission",
                  )}
                </Button>
              </Show>
            </div>
            <Show when={canGetDisplayMedia}>
              <label class="flex items-center justify-between gap-2 p-2">
                <p class="text-muted-foreground text-sm">
                  {t(
                    "common.media_selection_dialog.video_constraints",
                  )}
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={openVideoConstraintsDialog}
                >
                  <IconSettings class="size-6" />
                </Button>
              </label>
            </Show>
            <div
              class={cn(
                "flex flex-col gap-2 rounded-lg px-2",
                canUseScreenSpeaker() &&
                  "border-border border py-2",
              )}
            >
              <Switch
                class="flex items-center justify-between gap-2"
                checked={enableScreenSpeaker()}
                onChange={(value) =>
                  setEnableScreenSpeaker(value)
                }
              >
                <SwitchLabel>
                  {t(
                    "common.media_selection_dialog.enable_system_audio",
                  )}
                </SwitchLabel>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>
              <Show when={canUseScreenSpeaker()}>
                <div class="flex w-full gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={openSpeakerConstraintsDialog}
                  >
                    <IconSettings class="size-6" />
                  </Button>
                  <Select<MediaDeviceInfoType>
                    class="flex-1"
                    value={devices.screenAudio}
                    placeholder={t(
                      "common.media_selection_dialog.select_system_audio_source",
                    )}
                    onChange={(value) => {
                      setDevices("screenAudio", value);
                    }}
                    optionTextValue="label"
                    optionValue="deviceId"
                    options={availableMicrophones()}
                    itemComponent={(props) => (
                      <SelectItem item={props.item}>
                        {props.item.rawValue.label}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger
                      aria-label="Select system audio source"
                      class="hover:bg-muted/80 border-none transition-colors"
                    >
                      <SelectValue<MediaDeviceInfoType>>
                        {(state) =>
                          state.selectedOption().label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </Show>
            </div>
            <div
              class={cn(
                "flex flex-col gap-2 rounded-lg px-2",
                canUseScreenMicrophone() &&
                  "border-border border py-2",
              )}
            >
              <Switch
                class="flex items-center justify-between gap-2"
                disabled={
                  availableMicrophones().length === 0 ||
                  microphonePermission() !== "granted"
                }
                checked={enableScreenMicrophone()}
                onChange={(value) =>
                  setEnableScreenMicrophone(value)
                }
              >
                <SwitchLabel>
                  {t(
                    "common.media_selection_dialog.enable_microphone",
                  )}
                </SwitchLabel>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>
              <Show when={canUseScreenMicrophone()}>
                <div class="flex w-full gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={
                      openMicrophoneConstraintsDialog
                    }
                  >
                    <IconSettings class="size-6" />
                  </Button>
                  <Select<MediaDeviceInfoType>
                    class="flex-1"
                    value={devices.microphone}
                    placeholder={t(
                      "common.media_selection_dialog.select_microphone",
                    )}
                    onChange={(value) => {
                      setDevices("microphone", value);
                    }}
                    optionTextValue="label"
                    optionValue="deviceId"
                    options={availableMicrophones()}
                    itemComponent={(props) => (
                      <SelectItem item={props.item}>
                        {props.item.rawValue.label}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger
                      aria-label="Select microphone"
                      class="hover:bg-muted/80 border-none transition-colors"
                    >
                      <SelectValue<MediaDeviceInfoType>>
                        {(state) =>
                          state.selectedOption().label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </Show>
            </div>
            <div class="flex items-stretch gap-2">
              <Show
                when={stream()}
                fallback={
                  <Show
                    when={canGetDisplayMedia}
                    fallback={
                      <p class="text-muted-foreground text-sm">
                        {t(
                          "common.media_selection_dialog.not_support_display_media",
                        )}
                      </p>
                    }
                  >
                    <Button
                      size="sm"
                      onClick={() =>
                        openScreen(
                          enableScreenSpeaker(),
                          enableScreenMicrophone(),
                        )
                      }
                      class="w-full"
                    >
                      {t(
                        "common.media_selection_dialog.open_screen",
                      )}
                    </Button>
                  </Show>
                }
              >
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={closeStream}
                  class="flex-1"
                >
                  {t("common.action.close")}
                </Button>
                <Show when={canGetDisplayMedia}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      closeStream();
                      openScreen(
                        enableScreenSpeaker(),
                        enableScreenMicrophone(),
                      );
                    }}
                    class="flex-1"
                  >
                    {t("common.action.change")}
                  </Button>
                </Show>
              </Show>
            </div>
          </TabsContent>
          <TabsContent
            value="user"
            class="flex flex-col gap-2"
          >
            <div class="flex gap-2">
              <Show
                when={
                  cameras().length !== 0 &&
                  cameraPermission() === "prompt"
                }
              >
                <Button
                  size="sm"
                  class="flex-1"
                  onClick={requestCameraPermission}
                >
                  {t(
                    "common.media_selection_dialog.request_camera_permission",
                  )}
                </Button>
              </Show>
              <Show
                when={
                  microphones().length !== 0 &&
                  microphonePermission() === "prompt"
                }
              >
                <Button
                  size="sm"
                  class="flex-1"
                  onClick={requestMicrophonePermission}
                >
                  {t(
                    "common.media_selection_dialog.request_microphone_permission",
                  )}
                </Button>
              </Show>
            </div>
            <div
              class={cn(
                "flex flex-col gap-2 rounded-lg px-2",
                canUseUserCamera() &&
                  "border-border border py-2",
              )}
            >
              <Switch
                disabled={
                  availableCameras().length === 0 ||
                  cameraPermission() !== "granted"
                }
                class="flex items-center justify-between gap-2"
                checked={enableUserCamera()}
                onChange={(value) =>
                  setEnableUserCamera(value)
                }
              >
                <SwitchLabel>
                  {t(
                    "common.media_selection_dialog.enable_camera",
                  )}
                </SwitchLabel>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>

              <Show when={canUseUserCamera()}>
                <div class="flex w-full gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={openVideoConstraintsDialog}
                  >
                    <IconSettings class="size-6" />
                  </Button>
                  <Select<MediaDeviceInfoType>
                    class="flex-1"
                    value={devices.camera}
                    placeholder={t(
                      "common.media_selection_dialog.select_camera",
                    )}
                    onChange={(value) => {
                      setDevices("camera", value);
                    }}
                    optionTextValue="label"
                    optionValue="deviceId"
                    options={availableCameras()}
                    itemComponent={(props) => (
                      <SelectItem item={props.item}>
                        {props.item.rawValue.label}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger
                      aria-label="Select camera"
                      class="hover:bg-muted/80 border-none transition-colors"
                    >
                      <SelectValue<MediaDeviceInfoType>>
                        {(state) =>
                          state.selectedOption().label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </Show>
            </div>
            <div
              class={cn(
                "flex flex-col gap-2 rounded-lg px-2",
                canUseUserMicrophone() &&
                  "border-border border py-2",
              )}
            >
              <Switch
                disabled={
                  availableMicrophones().length === 0 ||
                  microphonePermission() !== "granted"
                }
                class="flex items-center justify-between gap-2"
                checked={enableUserMicrophone()}
                onChange={(value) =>
                  setEnableUserMicrophone(value)
                }
              >
                <SwitchLabel>
                  {t(
                    "common.media_selection_dialog.enable_microphone",
                  )}
                </SwitchLabel>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>

              <Show when={canUseUserMicrophone()}>
                <div class="flex w-full gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={
                      openMicrophoneConstraintsDialog
                    }
                  >
                    <IconSettings class="size-6" />
                  </Button>
                  <Select<MediaDeviceInfoType>
                    class="flex-1"
                    value={devices.microphone}
                    placeholder={t(
                      "common.media_selection_dialog.select_microphone",
                    )}
                    onChange={(value) => {
                      setDevices("microphone", value);
                    }}
                    optionTextValue="label"
                    optionValue="deviceId"
                    options={availableMicrophones()}
                    itemComponent={(props) => (
                      <SelectItem item={props.item}>
                        {props.item.rawValue.label}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger
                      aria-label="Select microphone"
                      class="hover:bg-muted/80 border-none transition-colors"
                    >
                      <SelectValue<MediaDeviceInfoType>>
                        {(state) =>
                          state.selectedOption().label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </Show>
            </div>
            <div
              class={cn(
                "flex flex-col gap-2 rounded-lg px-2",
                canUseUserProgramAudio() &&
                  "border-border border py-2",
              )}
            >
              <Switch
                disabled={
                  availableMicrophones().length === 0 ||
                  microphonePermission() !== "granted"
                }
                class="flex items-center justify-between gap-2"
                checked={enableUserProgramAudio()}
                onChange={(value) =>
                  setEnableUserProgramAudio(value)
                }
              >
                <div class="flex items-center gap-1">
                  <SwitchLabel>
                    {t(
                      "common.media_selection_dialog.enable_program_audio",
                    )}
                  </SwitchLabel>
                  <Tooltip placement="top">
                    <TooltipTrigger
                      as="button"
                      type="button"
                      class="text-muted-foreground hover:text-foreground
                        focus-visible:ring-ring inline-flex size-5 items-center
                        justify-center rounded-full transition-colors
                        focus-visible:ring-2 focus-visible:outline-none"
                      aria-label={t(
                        "common.media_selection_dialog.obs_audio_setup_tip",
                      )}
                    >
                      <IconInfo class="size-4" />
                    </TooltipTrigger>
                    <TooltipContent class="leading-relaxed whitespace-pre-line">
                      {t(
                        "common.media_selection_dialog.obs_audio_setup_tip",
                      )}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>

              <Show when={canUseUserProgramAudio()}>
                <div class="flex w-full gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={openSpeakerConstraintsDialog}
                  >
                    <IconSettings class="size-6" />
                  </Button>
                  <Select<MediaDeviceInfoType>
                    class="flex-1"
                    value={devices.programAudio}
                    placeholder={t(
                      "common.media_selection_dialog.select_program_audio",
                    )}
                    onChange={(value) => {
                      setDevices("programAudio", value);
                    }}
                    optionTextValue="label"
                    optionValue="deviceId"
                    options={availableMicrophones()}
                    itemComponent={(props) => (
                      <SelectItem item={props.item}>
                        {props.item.rawValue.label}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger
                      aria-label="Select program audio"
                      class="hover:bg-muted/80 border-none transition-colors"
                    >
                      <SelectValue<MediaDeviceInfoType>>
                        {(state) =>
                          state.selectedOption().label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </Show>
            </div>
            <div class="flex gap-2">
              <Show
                when={
                  (availableCameras().length !== 0 &&
                    cameraPermission() === "granted") ||
                  (availableMicrophones().length !== 0 &&
                    microphonePermission() === "granted")
                }
              >
                <Show
                  when={stream()}
                  fallback={
                    <Show
                      when={canGetUserMedia}
                      fallback={
                        <p class="text-muted-foreground text-sm">
                          {t(
                            "common.media_selection_dialog.not_support_user_media",
                          )}
                        </p>
                      }
                    >
                      <Button
                        size="sm"
                        class="w-full"
                        onClick={() =>
                          openCamera(
                            enableUserCamera(),
                            enableUserMicrophone(),
                            enableUserProgramAudio(),
                          )
                        }
                      >
                        {t(
                          "common.media_selection_dialog.open_media_device",
                        )}
                      </Button>
                    </Show>
                  }
                >
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={closeStream}
                    class="w-full"
                  >
                    {t("common.action.close")}
                  </Button>
                </Show>
              </Show>
            </div>
          </TabsContent>
        </Tabs>
      ),
      confirm: (
        <Button
          disabled={!stream()}
          onClick={() => submit(stream()!)}
        >
          {t("common.action.confirm")}
        </Button>
      ),
      cancel: (
        <Button variant="secondary" onClick={() => close()}>
          {t("common.action.cancel")}
        </Button>
      ),
      onCancel: () => {
        closeStream();
      },
      onSubmit: () => {
        setStream(null);
      },
    },
  );

  return { open, close };
};
