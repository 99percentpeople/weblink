import { t } from "@/i18n";
import { createSignal, createEffect, Show } from "solid-js";
import { Label } from "@/components/ui/label";
import { createDialog } from "./dialog";
import {
  MicrophoneTrackConstraints,
  SpeakerTrackConstraints,
  VideoTrackConstraints,
} from "@/routes/home/components/track-constaints";
import {
  Switch,
  SwitchLabel,
  SwitchControl,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

export const createApplyConstraintsDialog = () => {
  const [mediaStream, setMediaStream] =
    createSignal<MediaStream | null>(null);

  createEffect(() => {
    const stream = mediaStream();
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.getConstraints();
      });
    }
  });

  const audioTracks = () => {
    return mediaStream()?.getAudioTracks();
  };

  const videoTrack = () => {
    return mediaStream()?.getVideoTracks()[0];
  };

  const microphoneAudioTrack = () => {
    return audioTracks()?.find(
      (track) => track.contentHint === "speech",
    );
  };

  const speakerAudioTrack = () => {
    return audioTracks()?.find(
      (track) => track.contentHint === "music",
    );
  };

  const { open: openDialog, close } = createDialog({
    title: () =>
      t("common.media_selection_dialog.apply_constraints"),
    description: () =>
      t(
        "common.media_selection_dialog.apply_constraints_description",
      ),
    content: () => (
      <div class="flex flex-col gap-2">
        <Show when={microphoneAudioTrack()}>
          {(track) => (
            <div class="border-border flex flex-col gap-2 rounded-md border p-2">
              <Label class="font-bold">
                {t(
                  "common.media_selection_dialog.microphone_constraints",
                )}
              </Label>
              <MicrophoneTrackConstraints track={track()} />
            </div>
          )}
        </Show>
        <Show when={speakerAudioTrack()}>
          {(track) => (
            <div class="border-border flex flex-col gap-2 rounded-md border p-2">
              <Label class="font-bold">
                {t(
                  "common.media_selection_dialog.speaker_constraints",
                )}
              </Label>
              <SpeakerTrackConstraints track={track()} />
            </div>
          )}
        </Show>
        <Show when={videoTrack()}>
          {(track) => (
            <div class="border-border flex flex-col gap-2 rounded-md border p-2">
              <Label class="font-bold">
                {t(
                  "common.media_selection_dialog.video_constraints",
                )}
              </Label>
              <VideoTrackConstraints track={track()} />
            </div>
          )}
        </Show>
      </div>
    ),
  });

  const open = (stream: MediaStream) => {
    setMediaStream(stream);
    openDialog();
  };

  return { open, close };
};

export const createPresetSpeakerTrackConstraintsDialog =
  () => {
    return createDialog({
      title: () => t("common.action.settings"),
      content: () => (
        <div class="flex flex-col gap-2">
          <Switch
            disabled={
              appState.media.constraints.speaker
                .suppressLocalAudioPlayback === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.speaker
                .suppressLocalAudioPlayback === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "speaker",
                "suppressLocalAudioPlayback",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.suppress_local_audio_playback",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.speaker
                .autoGainControl === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.speaker
                .autoGainControl === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "speaker",
                "autoGainControl",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.auto_gain_control",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.speaker
                .echoCancellation === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.speaker
                .echoCancellation === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "speaker",
                "echoCancellation",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.echo_cancellation",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.speaker
                .noiseSuppression === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.speaker
                .noiseSuppression === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "speaker",
                "noiseSuppression",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.noise_suppression",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </div>
      ),
    });
  };

export const createPresetMicrophoneConstraintsDialog =
  () => {
    return createDialog({
      title: () => t("common.action.settings"),
      content: () => (
        <div class="flex flex-col gap-2">
          <Switch
            disabled={
              appState.media.constraints.microphone
                .autoGainControl === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.microphone
                .autoGainControl === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "microphone",
                "autoGainControl",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.auto_gain_control",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.microphone
                .echoCancellation === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.microphone
                .echoCancellation === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "microphone",
                "echoCancellation",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.echo_cancellation",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.microphone
                .noiseSuppression === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.microphone
                .noiseSuppression === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "microphone",
                "noiseSuppression",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.noise_suppression",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <Switch
            disabled={
              appState.media.constraints.microphone
                .voiceIsolation === undefined
            }
            class="flex items-center justify-between gap-2"
            checked={
              appState.media.constraints.microphone
                .voiceIsolation === true
            }
            onChange={(value) =>
              setAppState(
                "media",
                "constraints",
                "microphone",
                "voiceIsolation",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "common.media_selection_dialog.constraints.voice_isolation",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </div>
      ),
    });
  };

export const createPresetVideoConstraintsDialog = () => {
  return createDialog({
    title: () => t("common.action.settings"),
    content: () => (
      <div class="flex flex-col gap-2">
        <Slider
          minValue={1}
          maxValue={120}
          value={[
            typeof appState.media.constraints.video
              .frameRate === "number"
              ? appState.media.constraints.video.frameRate
              : (appState.media.constraints.video.frameRate
                  ?.max ?? 30),
          ]}
          onChange={(value) =>
            setAppState(
              "media",
              "constraints",
              "video",
              "frameRate",
              { max: value[0] },
            )
          }
          getValueLabel={({ values }) => `${values[0]} FPS`}
          class="gap-2"
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(
                "common.media_selection_dialog.constraints.max_frame_rate",
              )}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
      </div>
    ),
  });
};
