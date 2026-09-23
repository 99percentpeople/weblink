import { t } from "@/i18n";
import { catchError } from "@/libs/catch";
import { createMemo, createEffect, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { toast } from "solid-sonner";
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
import { createDebounceAsync } from "@/libs/hooks/debounce";
import {
  setAppState,
  type VideoConstraintsState,
} from "@/libs/state/app-state";

export const SpeakerTrackConstraints = (props: {
  track: MediaStreamTrack;
}) => {
  const capabilities = createMemo(() => {
    const capabilities = props.track.getCapabilities();
    return {
      suppressLocalAudioPlayback:
        "suppressLocalAudioPlayback" in capabilities,
    };
  });
  const [enableConstraints, setEnableConstraints] =
    createStore({
      suppressLocalAudioPlayback: false,
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
    });
  createEffect(() => {
    const track = props.track;
    const constraints = track.getConstraints();
    setEnableConstraints(
      "suppressLocalAudioPlayback",
      !!(constraints as any)?.suppressLocalAudioPlayback,
    );
    setEnableConstraints(
      "noiseSuppression",
      !!constraints.noiseSuppression,
    );
    setEnableConstraints(
      "echoCancellation",
      !!constraints.echoCancellation,
    );
    setEnableConstraints(
      "autoGainControl",
      !!constraints.autoGainControl,
    );
  });
  const applyConstraints = async (
    name: keyof typeof enableConstraints,
    value: boolean,
  ) => {
    setEnableConstraints(name, value);
    const constraints = props.track.getConstraints() as any;
    const newConstraints = {
      ...constraints,
      [name]: value,
    };
    const [err] = await catchError(
      props.track.applyConstraints(newConstraints),
    );
    if (err) {
      console.error(err);
      toast.error(
        `Error applying ${name} constraint: ${err.message}`,
      );
      setEnableConstraints(name, !!constraints[name]);
    }
  };
  return (
    <>
      <Switch
        class="flex items-center justify-between gap-2"
        disabled={
          !capabilities().suppressLocalAudioPlayback
        }
        checked={
          enableConstraints.suppressLocalAudioPlayback
        }
        onChange={(value) => {
          applyConstraints(
            "suppressLocalAudioPlayback",
            value,
          );
        }}
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
    </>
  );
};

export const MicrophoneTrackConstraints = (props: {
  track: MediaStreamTrack;
}) => {
  const capabilities = createMemo(() => {
    const capabilities = props.track.getCapabilities();
    return {
      noiseSuppression: "noiseSuppression" in capabilities,
      echoCancellation: "echoCancellation" in capabilities,
      autoGainControl: "autoGainControl" in capabilities,
      voiceIsolation: "voiceIsolation" in capabilities,
    };
  });

  const [enableConstraints, setEnableConstraints] =
    createStore({
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
      voiceIsolation: false,
    });

  createEffect(() => {
    const track = props.track;
    const constraints = track.getConstraints();
    setEnableConstraints(
      "noiseSuppression",
      !!constraints.noiseSuppression,
    );
    setEnableConstraints(
      "echoCancellation",
      !!constraints.echoCancellation,
    );
    setEnableConstraints(
      "autoGainControl",
      !!constraints.autoGainControl,
    );
    setEnableConstraints(
      "voiceIsolation",
      !!(constraints as any)?.voiceIsolation,
    );
  });

  const applyConstraints = async (
    name: keyof typeof enableConstraints,
    value: boolean,
  ) => {
    setEnableConstraints(name, value);
    const constraints = props.track.getConstraints() as any;
    const newConstraints = {
      ...constraints,
      [name]: value,
    };
    const [err] = await catchError(
      props.track.applyConstraints(newConstraints),
    );
    if (err) {
      console.error(err);
      toast.error(
        `Error applying ${name} constraint: ${err.message}`,
      );
      setEnableConstraints(name, !!constraints[name]);
    }
  };

  return (
    <>
      <Switch
        class="flex items-center justify-between gap-2"
        disabled={!capabilities().autoGainControl}
        checked={enableConstraints.autoGainControl}
        onChange={(value) => {
          applyConstraints("autoGainControl", value);
        }}
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
        class="flex items-center justify-between gap-2"
        disabled={!capabilities().echoCancellation}
        checked={enableConstraints.echoCancellation}
        onChange={(value) => {
          applyConstraints("echoCancellation", value);
        }}
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
        class="flex items-center justify-between gap-2"
        disabled={!capabilities().noiseSuppression}
        checked={enableConstraints.noiseSuppression}
        onChange={(value) => {
          applyConstraints("noiseSuppression", value);
        }}
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
        class="flex items-center justify-between gap-2"
        disabled={!capabilities().voiceIsolation}
        checked={enableConstraints.voiceIsolation}
        onChange={(value) => {
          applyConstraints("voiceIsolation", value);
        }}
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
    </>
  );
};

export const VideoTrackConstraints = (props: {
  track: MediaStreamTrack;
}) => {
  const capabilities = createMemo(() => {
    return props.track.getCapabilities();
  });

  const [enableConstraints, setEnableConstraints] =
    createStore<VideoConstraintsState>({
      frameRate: { max: 60 },
    });

  createEffect(() => {
    const track = props.track;
    const constraints = track.getConstraints();
    setEnableConstraints(
      "frameRate",
      constraints.frameRate,
    );
  });

  const { debouncedFn: applyConstraints } =
    createDebounceAsync(async (value: ConstrainDouble) => {
      const constraints =
        props.track.getConstraints() as any;
      const newConstraints = {
        ...constraints,
        frameRate: value,
      };
      const [err] = await catchError(
        props.track.applyConstraints(newConstraints),
      );
      if (err) {
        console.error(err);
        toast.error(
          `Error applying frameRate constraint: ${err.message}`,
        );
        setAppState(
          "media",
          "constraints",
          "video",
          "frameRate",
          constraints.frameRate,
        );
        return;
      }
    });

  return (
    <div class="flex flex-col gap-2">
      <Show when={capabilities().frameRate}>
        <Slider
          minValue={1}
          maxValue={120}
          value={[
            typeof enableConstraints.frameRate === "number"
              ? enableConstraints.frameRate
              : (enableConstraints.frameRate?.max ?? 60),
          ]}
          onChange={(value) => {
            setEnableConstraints("frameRate", value[0]);
            applyConstraints({ max: value[0] });
          }}
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
      </Show>
    </div>
  );
};
