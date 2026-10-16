import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";
import type { StoredFile } from "@weblink/platform";
import {
  createMemo,
  Match,
  onCleanup,
  Switch,
  Show,
} from "solid-js";
import { MediaThumbnail } from "./media-thumbnail";
import type { MediaHashRoute } from "./media-hash-route";

/** Local bytes only. Images and videos open in the conversation gallery. */
export function LocalFileMedia(props: {
  file: StoredFile;
  mimeType?: string;
  route: MediaHashRoute;
}) {
  const type = () =>
    props.file.type || props.mimeType || "";
  const url = createMemo(() => {
    if (!/^(image|video|audio)\//.test(type())) return;
    const value = fileObjectUrl(props.file);
    onCleanup(() => revokeFileUrl(value));
    return value;
  });
  return (
    <Show when={url()} keyed>
      {(url) => {
        const video = () => type().startsWith("video/");
        return (
          <Switch>
            <Match
              when={type().startsWith("image/") || video()}
            >
              <MediaThumbnail
                src={url}
                name={props.file.name}
                mimeType={type()}
                kind={video() ? "video" : "image"}
                route={props.route}
              />
            </Match>
            <Match when={type().startsWith("audio/")}>
              <audio
                src={url}
                aria-label={props.file.name}
                controls
                preload="metadata"
                class="w-full min-w-0"
              />
            </Match>
          </Switch>
        );
      }}
    </Show>
  );
}
