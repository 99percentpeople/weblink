import { t } from "@/i18n";
import { createSignal, createEffect, Show } from "solid-js";
import {
  SettingHeading,
  SettingSection,
} from "@/components/settings/setting-layout";
import { createDialog } from "./dialog";
import {
  MicrophoneTrackConstraints,
  SpeakerTrackConstraints,
  VideoTrackConstraints,
} from "@/routes/home/components/track-constaints";
import { SettingSwitch } from "@/components/settings/setting-controls";
import VideoCaptureSettings from "@/components/settings/video-capture-settings";
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
            <SettingSection class="border-border rounded-lg border p-3">
              <SettingHeading>
                {t(
                  "common.media_selection_dialog.microphone_constraints",
                )}
              </SettingHeading>
              <MicrophoneTrackConstraints track={track()} />
            </SettingSection>
          )}
        </Show>
        <Show when={speakerAudioTrack()}>
          {(track) => (
            <SettingSection class="border-border rounded-lg border p-3">
              <SettingHeading>
                {t(
                  "common.media_selection_dialog.speaker_constraints",
                )}
              </SettingHeading>
              <SpeakerTrackConstraints track={track()} />
            </SettingSection>
          )}
        </Show>
        <Show when={videoTrack()}>
          {(track) => (
            <SettingSection class="border-border rounded-lg border p-3">
              <SettingHeading>
                {t(
                  "common.media_selection_dialog.video_constraints",
                )}
              </SettingHeading>
              <VideoTrackConstraints track={track()} />
            </SettingSection>
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
        <SettingSection>
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.suppress_local_audio_playback",
            )}
            disabled={
              appState.media.constraints.speaker
                .suppressLocalAudioPlayback === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.auto_gain_control",
            )}
            disabled={
              appState.media.constraints.speaker
                .autoGainControl === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.echo_cancellation",
            )}
            disabled={
              appState.media.constraints.speaker
                .echoCancellation === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.noise_suppression",
            )}
            disabled={
              appState.media.constraints.speaker
                .noiseSuppression === undefined
            }
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
          />
        </SettingSection>
      ),
    });
  };

export const createPresetMicrophoneConstraintsDialog =
  () => {
    return createDialog({
      title: () => t("common.action.settings"),
      content: () => (
        <SettingSection>
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.auto_gain_control",
            )}
            disabled={
              appState.media.constraints.microphone
                .autoGainControl === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.echo_cancellation",
            )}
            disabled={
              appState.media.constraints.microphone
                .echoCancellation === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.noise_suppression",
            )}
            disabled={
              appState.media.constraints.microphone
                .noiseSuppression === undefined
            }
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
          />
          <SettingSwitch
            label={t(
              "common.media_selection_dialog.constraints.voice_isolation",
            )}
            disabled={
              appState.media.constraints.microphone
                .voiceIsolation === undefined
            }
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
          />
        </SettingSection>
      ),
    });
  };

export const createPresetVideoConstraintsDialog = () =>
  createDialog({
    title: () => t("app_menu.settings_meeting"),
    content: () => (
      <SettingSection>
        <VideoCaptureSettings />
      </SettingSection>
    ),
  });
