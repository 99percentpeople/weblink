import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { t } from "@/i18n";
import type { VideoQualityControl } from "@/libs/domain/video-quality";

export function VideoQualityStatus(props: {
  control: VideoQualityControl;
}) {
  const [revision, setRevision] = createSignal(0);
  createEffect(() => {
    const control = props.control;
    const changed = () => setRevision((n) => n + 1);
    control.addEventListener("change", changed);
    onCleanup(() =>
      control.removeEventListener("change", changed),
    );
  });
  const state = () => {
    revision();
    return props.control;
  };
  return (
    <div
      class="text-muted-foreground text-sm"
      role="status"
      aria-live="polite"
    >
      <Show when={state().applied}>
        {(limits) => (
          <p>
            {t("video_quality.applied", {
              width: limits().maxWidth,
              height: limits().maxHeight,
              fps: limits().frameRate,
            })}
          </p>
        )}
      </Show>
      <Show
        when={!state().available}
        fallback={
          <Show
            when={state().pending}
            fallback={
              <Show when={state().error}>
                {t("video_quality.failed")}
              </Show>
            }
          >
            {t("video_quality.adjusting")}
          </Show>
        }
      >
        {t("video_quality.unavailable")}
      </Show>
    </div>
  );
}
