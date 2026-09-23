import {
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Play } from "lucide-solid";
import { t } from "@/i18n";
import {
  mediaHash,
  type MediaHashRoute,
} from "./media-hash-route";

/** A fixed 16:9 frame with a thumbnail element that bounds the actual pixels. */
export function MediaThumbnail(props: {
  src: string;
  name: string;
  kind: "image" | "video";
  route: MediaHashRoute;
}) {
  return (
    <Show when={props.src} keyed>
      {(src) => {
        const [dimensions, setDimensions] = createSignal<{
          width: number;
          height: number;
        }>();
        const [poster, setPoster] = createSignal<string>();
        let disposed = false;
        let posterPending = false;
        onCleanup(() => {
          disposed = true;
          if (poster()) URL.revokeObjectURL(poster()!);
        });
        const fit = createMemo(() => {
          const size = dimensions();
          const wide =
            size && size.width / size.height >= 16 / 9;
          return {
            width: wide ? "100%" : "auto",
            height: wide ? "auto" : "100%",
          };
        });
        const loaded = (width: number, height: number) => {
          if (width > 0 && height > 0)
            setDimensions({ width, height });
        };
        const capturePoster = (video: HTMLVideoElement) => {
          if (
            posterPending ||
            !video.videoWidth ||
            !video.videoHeight
          )
            return;
          posterPending = true;
          const canvas = document.createElement("canvas");
          const scale = Math.min(
            1,
            640 /
              Math.max(video.videoWidth, video.videoHeight),
          );
          canvas.width = Math.round(
            video.videoWidth * scale,
          );
          canvas.height = Math.round(
            video.videoHeight * scale,
          );
          try {
            canvas
              .getContext("2d")
              ?.drawImage(
                video,
                0,
                0,
                canvas.width,
                canvas.height,
              );
            canvas.toBlob(
              (blob) => {
                if (!disposed && blob)
                  setPoster(URL.createObjectURL(blob));
              },
              "image/jpeg",
              0.85,
            );
          } catch {
            /* Unsupported posters use a fade; metadata still allows preview. */
          }
        };
        return (
          <a
            href={mediaHash(props.route)}
            data-message-media={props.route.messageId}
            data-media-ready={!!dimensions()}
            data-media-kind={props.kind}
            data-pswp-src={src}
            data-pswp-width={dimensions()?.width}
            data-pswp-height={dimensions()?.height}
            data-pswp-type={
              props.kind === "video" ? "video" : undefined
            }
            data-pswp-video-src={
              props.kind === "video" ? src : undefined
            }
            data-download={props.name}
            aria-label={`${t("common.action.preview")}: ${props.name}`}
            class="bg-foreground/5 focus-visible:ring-ring relative flex
              aspect-video w-full min-w-0 items-center justify-center
              overflow-hidden rounded-lg outline-none focus-visible:ring-2"
          >
            <Show
              when={props.kind === "video"}
              fallback={
                <img
                  src={src}
                  alt={props.name}
                  data-media-thumbnail
                  class="block max-h-full max-w-full"
                  style={fit()}
                  onLoad={(event) =>
                    loaded(
                      event.currentTarget.naturalWidth,
                      event.currentTarget.naturalHeight,
                    )
                  }
                />
              }
            >
              <video
                src={src}
                aria-label={props.name}
                preload="metadata"
                muted
                playsinline
                class="block max-h-full max-w-full"
                classList={{
                  absolute: !!poster(),
                  invisible: !!poster(),
                }}
                style={fit()}
                onLoadedMetadata={(event) =>
                  loaded(
                    event.currentTarget.videoWidth,
                    event.currentTarget.videoHeight,
                  )
                }
                onLoadedData={(event) =>
                  capturePoster(event.currentTarget)
                }
              />
              <Show when={poster()}>
                {(url) => (
                  <img
                    src={url()}
                    alt={props.name}
                    data-media-thumbnail
                    class="block max-h-full max-w-full"
                    style={fit()}
                  />
                )}
              </Show>
              <span
                class="absolute flex size-10 items-center justify-center
                  rounded-full bg-black/50 text-white"
              >
                <Play class="size-5" />
              </span>
            </Show>
          </a>
        );
      }}
    </Show>
  );
}
