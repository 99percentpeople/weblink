import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import {
  defaultVideoFrameRates,
  displayVideoFrameRates,
  videoResolutions,
} from "@/libs/application/meeting-video-settings";
import { platform } from "@/libs/platform/runtime";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export default function VideoCaptureSettings(props: {
  frameRates?: readonly number[] | null;
}) {
  const [detected, setDetected] = createSignal<
    readonly number[] | null
  >(null);
  const frameRates = () => props.frameRates ?? detected();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(async () => {
    // The meeting page supplies its existing capability query; standalone
    // capture dialogs discover their own rates without suspending their parent.
    if (props.frameRates !== undefined) return;
    let rates: readonly number[] = defaultVideoFrameRates;
    try {
      if (platform.kind === "desktop") {
        const capabilities =
          await platform.getCapabilities();
        if (capabilities.runtime === "desktop")
          rates = displayVideoFrameRates(
            capabilities.displayRefreshRates,
          );
      }
    } catch {
      /* Keep the common rates when system information is unavailable. */
    }
    if (!disposed) setDetected(rates);
  });
  createEffect(() => {
    const rates = frameRates();
    if (!rates?.length) return;
    const current = appState.options.videoFrameRate;
    if (rates.includes(current)) return;
    const bounded =
      rates
        .filter(
          (rate) =>
            rate <=
            (Number.isFinite(current) ? current : 30),
        )
        .at(-1) ?? rates[0];
    setAppOptions("videoFrameRate", bounded);
  });
  return (
    <>
      <For each={["resolution", "frame_rate"] as const}>
        {(kind) => {
          const options = () =>
            kind === "resolution"
              ? Object.keys(videoResolutions)
              : (
                  frameRates() ?? defaultVideoFrameRates
                ).map(String);
          const label = (value: string) =>
            kind === "resolution" ? value : `${value} FPS`;
          return (
            <div class="flex flex-col gap-2">
              <Label>
                {t(`setting.meeting_settings.${kind}`)}
              </Label>
              <Select
                modal
                value={
                  kind === "resolution"
                    ? appState.options.videoResolution
                    : String(
                        appState.options.videoFrameRate,
                      )
                }
                options={options()}
                onChange={(value) => {
                  if (!value) return;
                  if (kind === "resolution")
                    setAppOptions(
                      "videoResolution",
                      value as keyof typeof videoResolutions,
                    );
                  else
                    setAppOptions(
                      "videoFrameRate",
                      Number(value),
                    );
                }}
                itemComponent={(props) => (
                  <SelectItem item={props.item}>
                    {label(props.item.rawValue)}
                  </SelectItem>
                )}
              >
                <SelectTrigger
                  aria-label={t(
                    `setting.meeting_settings.${kind}`,
                  )}
                >
                  <SelectValue<string>>
                    {(state) =>
                      label(
                        state.selectedOption() ??
                          String(
                            appState.options.videoFrameRate,
                          ),
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
              <Show when={kind === "frame_rate"}>
                <p class="muted">
                  {t(
                    "setting.meeting_settings.capture_description",
                  )}
                </p>
              </Show>
            </div>
          );
        }}
      </For>
    </>
  );
}
