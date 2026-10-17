import type { StoredFile } from "@weblink/platform";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Play, Video } from "lucide-solid";
import { videoThumbnail } from "@/libs/utils/video-thumbnail";

export function VideoFileThumbnail(props: {
  file: StoredFile;
}) {
  let container!: HTMLDivElement;
  const [visible, setVisible] = createSignal(
    typeof IntersectionObserver === "undefined",
  );
  const [poster, setPoster] = createSignal<string>();
  onMount(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    const file = props.file;
    setPoster(undefined);
    if (!visible()) return;
    const controller = new AbortController();
    let url: string | undefined;
    onCleanup(() => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    });
    void videoThumbnail(file, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setPoster(url);
      },
      () => {
        // Unsupported codecs or unavailable storage keep the video icon.
      },
    );
  });
  return (
    <div
      ref={container}
      class="relative flex size-full items-center justify-center"
    >
      <Show
        when={poster()}
        fallback={<Video class="size-5" />}
      >
        <img
          src={poster()}
          alt=""
          class="size-full object-cover"
        />
        <Play
          class="absolute bottom-0.5 right-0.5 size-3 fill-current text-white
            drop-shadow"
        />
      </Show>
    </div>
  );
}
