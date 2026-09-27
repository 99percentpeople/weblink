import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { toast } from "solid-sonner";
import { v4 } from "uuid";
import DropArea from "@/components/drop-area";
import {
  IconCheck,
  IconClose,
  IconRestartAlt,
  IconSync,
  IconUploadFile,
  IconWallpaper,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import { t } from "@/i18n";
import { cacheManager } from "@/libs/application/cache-service";
import { appState } from "@/libs/state/app-state";
import {
  getWallpaperPreset,
  resolveWallpaper,
  wallpaperPresets,
} from "@/libs/wallpapers";
import { backgroundImage, setAppOptions } from "@/options";
import "./wallpaper-picker.css";

const label = (key: string) =>
  t(`setting.appearance.background_image.${key}`);

export default function WallpaperPicker() {
  let fileInput!: HTMLInputElement;
  const [uploading, setUploading] = createSignal(false);
  const preset = createMemo(() =>
    getWallpaperPreset(appState.options.backgroundPreset),
  );
  const wallpaper = createMemo(() =>
    resolveWallpaper(
      appState.options.backgroundPreset,
      backgroundImage(),
    ),
  );
  const hasSelection = () =>
    Boolean(preset() || appState.options.backgroundImage);
  const currentName = () => {
    const selected = preset();
    if (selected) return label(`presets.${selected.id}`);
    const id = appState.options.backgroundImage;
    if (id)
      return (
        appState.cache.cacheInfo[id]?.fileName ??
        label("custom_image")
      );
    return label("default");
  };

  const upload = async (file?: File) => {
    if (!file || uploading()) return;
    if (!file.type.startsWith("image/")) {
      toast.error(label("invalid_image"));
      return;
    }
    setUploading(true);
    const id = v4();
    try {
      const cache = await cacheManager.createCache(id);
      await cache.setInfo({
        fileName: file.name,
        fileSize: file.size,
        mimetype: file.type,
        lastModified: file.lastModified,
        chunkSize: 1024 * 1024,
        file,
      });
      setAppOptions({
        backgroundImage: id,
        backgroundPreset: undefined,
      });
    } catch (error) {
      console.warn(
        "Unable to save background image",
        error,
      );
      toast.error(label("upload_failed"));
      // Only discard this failed import; existing file-cache entries stay intact.
      await cacheManager.remove(id).catch(console.warn);
    } finally {
      setUploading(false);
    }
  };

  return (
    <fieldset
      class="wallpaper-picker"
      aria-busy={uploading()}
    >
      <legend class="text-sm font-medium">
        {label("title")}
      </legend>
      <p class="muted">{label("description")}</p>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        aria-label={label("upload")}
        disabled={uploading()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void upload(file);
        }}
      />
      <DropArea
        class="wallpaper-card"
        disabled={uploading()}
        onDrop={(event) => {
          const files = Array.from(
            event.dataTransfer?.files ?? [],
          );
          void upload(
            files.find((file) =>
              file.type.startsWith("image/"),
            ) ?? files[0],
          );
        }}
        overlay={(state) => (
          <Show when={state.active}>
            <div class="wallpaper-drop-overlay">
              <Show
                when={state.accepted}
                fallback={<IconClose class="size-7" />}
              >
                <IconUploadFile class="size-7" />
                <span>{label("drop_to_upload")}</span>
              </Show>
            </div>
          </Show>
        )}
      >
        <div
          class="wallpaper-preview"
          role="img"
          aria-label={`${label("preview")}: ${currentName()}`}
        >
          <div
            class="wallpaper-preview-image"
            style={{
              "background-image": wallpaper().image,
              "background-size": wallpaper().size,
              "background-repeat": wallpaper().repeat,
              opacity:
                1 - appState.options.backgroundImageOpacity,
            }}
          />
          <span class="wallpaper-preview-badge">
            {label("preview")}
          </span>
          <Show when={!hasSelection()}>
            <IconWallpaper class="text-muted-foreground/40 size-9" />
          </Show>
        </div>
        <div class="wallpaper-card-footer">
          <span
            class="min-w-0 flex-1 truncate text-sm"
            title={currentName()}
          >
            {currentName()}
          </span>
          <div class="flex items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={uploading()}
              onClick={() => fileInput.click()}
            >
              <Show
                when={uploading()}
                fallback={<IconUploadFile class="size-4" />}
              >
                <IconSync class="size-4 animate-spin" />
              </Show>
              {uploading()
                ? label("uploading")
                : label("upload")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              class="size-8"
              disabled={!hasSelection() || uploading()}
              aria-label={label("reset")}
              title={label("reset")}
              onClick={() =>
                setAppOptions({
                  backgroundImage: undefined,
                  backgroundPreset: undefined,
                })
              }
            >
              <IconRestartAlt class="size-4" />
            </Button>
          </div>
        </div>
      </DropArea>

      <fieldset class="min-w-0">
        <legend class="text-muted-foreground mb-2 text-xs font-medium">
          {label("textures")}
        </legend>
        <div class="wallpaper-presets">
          <For each={wallpaperPresets}>
            {(item) => (
              <button
                type="button"
                class="wallpaper-preset"
                aria-pressed={preset()?.id === item.id}
                disabled={uploading()}
                onClick={() =>
                  setAppOptions({
                    backgroundPreset: item.id,
                    backgroundImage: undefined,
                  })
                }
              >
                <span
                  class="wallpaper-preset-swatch"
                  aria-hidden="true"
                  style={{
                    "background-image": item.image,
                    "background-size": item.size,
                  }}
                >
                  <Show when={preset()?.id === item.id}>
                    <span class="wallpaper-preset-check">
                      <IconCheck class="size-3.5" />
                    </span>
                  </Show>
                </span>
                <span class="px-2 py-1.5 text-xs">
                  {label(`presets.${item.id}`)}
                </span>
              </button>
            )}
          </For>
        </div>
      </fieldset>

      <Slider
        minValue={0}
        maxValue={1}
        step={0.01}
        disabled={!hasSelection()}
        class="mt-1"
        getValueLabel={({ values }) =>
          `${(values[0] * 100).toFixed(0)}%`
        }
        value={[
          1 - appState.options.backgroundImageOpacity,
        ]}
        onChange={(value) =>
          setAppOptions(
            "backgroundImageOpacity",
            1 - value[0],
          )
        }
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t(
              "setting.appearance.background_image_opacity.title",
            )}
          </SliderLabel>
          <SliderValueLabel class="text-muted-foreground text-xs tabular-nums" />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
    </fieldset>
  );
}
