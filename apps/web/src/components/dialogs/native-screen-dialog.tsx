import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type {
  CaptureBackend,
  CaptureCapabilities,
  CaptureSource,
  NativeCapture,
} from "@weblink/platform";
import { createDialog } from "./dialog";
import { Button } from "@/components/ui/button";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
  SwitchDescription,
} from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  IconCheck,
  IconMonitor,
  IconWindow,
} from "@/components/icons";
import { captureBackendAvailable } from "@/components/capture-backend-select";
import { appState } from "@/libs/state/app-state";
import { createCaptureThumbnail } from "@/libs/hooks/native-capture-thumbnail";
import { t } from "@/i18n";

type Kind = CaptureSource["kind"];
export interface NativeScreenSelection {
  sourceId: string;
  backend: CaptureBackend;
  audio: boolean;
}

export function createNativeScreenDialog(
  capture: NativeCapture,
) {
  const [sources, setSources] = createSignal<
    CaptureSource[]
  >([]);
  const [capabilities, setCapabilities] =
    createSignal<CaptureCapabilities>({
      screen: [],
      window: [],
    });
  const [kind, setKind] = createSignal<Kind>("monitor");
  const [selected, setSelected] = createSignal<
    Record<Kind, string>
  >({ monitor: "", window: "" });
  const [audio, setAudio] = createSignal(true);
  const [search, setSearch] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [choosing, setChoosing] = createSignal(false);
  const [previewRevision, setPreviewRevision] =
    createSignal(0);
  let generation = 0;
  let disposed = false;
  const label = (key: string) =>
    t(`meeting.native_screen.${key}`);
  const preference = (sourceKind: Kind) =>
    sourceKind === "monitor"
      ? "nativeScreenCaptureBackend"
      : "nativeWindowCaptureBackend";
  const backend = (sourceKind: Kind) =>
    appState.options[preference(sourceKind)] ?? "auto";
  const backends = (sourceKind: Kind) =>
    sourceKind === "monitor"
      ? capabilities().screen
      : capabilities().window;
  const visible = (sourceKind: Kind) =>
    sources().filter(
      (source) =>
        source.kind === sourceKind &&
        (sourceKind === "monitor" ||
          source.name
            .toLocaleLowerCase()
            .includes(search().trim().toLocaleLowerCase())),
    );
  const selection = createMemo(() =>
    visible(kind()).find(
      (source) => source.id === selected()[kind()],
    ),
  );
  const preview = createCaptureThumbnail(capture, () => {
    const source = selection();
    return choosing() && source
      ? {
          sourceId: source.id,
          backend: backend(source.kind),
          revision: previewRevision(),
        }
      : null;
  });
  const canShare = () =>
    !loading() &&
    !error() &&
    !!selection() &&
    captureBackendAvailable(
      backend(kind()),
      backends(kind()),
    );
  const loadSources = async () => {
    const token = ++generation;
    setLoading(true);
    setError("");
    try {
      const [next, available] = await Promise.all([
        capture.sources(),
        capture.backends(),
      ]);
      if (disposed || token !== generation) return;
      setSources(next);
      setCapabilities(available);
    } catch (error) {
      if (!disposed && token === generation)
        setError(String(error));
    } finally {
      if (!disposed && token === generation)
        setLoading(false);
    }
  };
  const dialog = createDialog<NativeScreenSelection>({
    title: () => label("title"),
    description: () => label("description"),
    class: "sm:max-w-4xl",
    content: () => (
      <div class="flex flex-col gap-3">
        <Tabs
          class="grid gap-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
          value={kind()}
          onChange={(value) => setKind(value as Kind)}
        >
          <div class="flex h-80 min-w-0 flex-col">
            <TabsList class="shrink-0">
              <TabsTrigger value="monitor" class="gap-1">
                <IconMonitor class="size-4" />
                {label("screens")}
              </TabsTrigger>
              <TabsTrigger value="window" class="gap-1">
                <IconWindow class="size-4" />
                {label("windows")}
              </TabsTrigger>
              <TabsIndicator />
            </TabsList>
            <For each={["monitor", "window"] as const}>
              {(sourceKind) => (
                <TabsContent
                  value={sourceKind}
                  class="flex min-h-0 flex-1 flex-col gap-3"
                >
                  <Show when={sourceKind === "window"}>
                    <Input
                      type="search"
                      class="shrink-0"
                      aria-label={label("search_windows")}
                      placeholder={label("search_windows")}
                      value={search()}
                      onInput={(event) =>
                        setSearch(event.currentTarget.value)
                      }
                    />
                  </Show>
                  <ul
                    class="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border
                      p-1"
                    aria-label={label("source")}
                    aria-busy={loading()}
                  >
                    <For each={visible(sourceKind)}>
                      {(source) => (
                        <li>
                          <Button
                            variant="ghost"
                            type="button"
                            disabled={loading()}
                            aria-pressed={
                              selected()[sourceKind] ===
                              source.id
                            }
                            class="aria-pressed:bg-accent aria-pressed:text-accent-foreground
                              h-auto w-full justify-start gap-3 px-3 py-2.5 text-left
                              font-normal"
                            onClick={() =>
                              setSelected((previous) => ({
                                ...previous,
                                [sourceKind]: source.id,
                              }))
                            }
                          >
                            <Show
                              when={
                                sourceKind === "monitor"
                              }
                            >
                              <IconMonitor class="text-muted-foreground size-5 shrink-0" />
                            </Show>
                            <span class="min-w-0 flex-1">
                              <span
                                class="block truncate text-sm font-medium"
                                title={source.name}
                              >
                                {source.name}
                              </span>
                              <span class="text-muted-foreground block text-xs">
                                {source.width > 0 &&
                                source.height > 0
                                  ? `${source.width} × ${source.height}`
                                  : label("size_unknown")}
                              </span>
                            </span>
                            <span
                              class="size-4 shrink-0"
                              aria-hidden="true"
                            >
                              <Show
                                when={
                                  selected()[sourceKind] ===
                                  source.id
                                }
                              >
                                <IconCheck class="text-primary size-4" />
                              </Show>
                            </span>
                          </Button>
                        </li>
                      )}
                    </For>
                    <Show when={error()}>
                      <li
                        class="text-destructive break-words px-3 py-6 text-sm"
                        role="alert"
                      >
                        {error()}
                      </li>
                    </Show>
                    <Show
                      when={
                        !error() &&
                        !visible(sourceKind).length
                      }
                    >
                      <li
                        class="text-muted-foreground px-3 py-6 text-center text-sm"
                        role="status"
                      >
                        {loading()
                          ? label("loading")
                          : label(
                              sourceKind === "window" &&
                                search().trim()
                                ? "no_matches"
                                : "empty",
                            )}
                      </li>
                    </Show>
                  </ul>
                  <Show
                    when={
                      !loading() &&
                      !error() &&
                      !captureBackendAvailable(
                        backend(sourceKind),
                        backends(sourceKind),
                      )
                    }
                  >
                    <p
                      class="text-destructive shrink-0 text-sm"
                      role="alert"
                    >
                      {label("backend_unavailable")}
                    </p>
                  </Show>
                </TabsContent>
              )}
            </For>
          </div>
          <div class="min-w-0 space-y-3 self-start">
            <div
              class="bg-muted/40 relative aspect-video w-full overflow-hidden
                rounded-lg border"
              aria-label={label("preview")}
              aria-busy={preview.state() === "loading"}
            >
              <Show
                when={preview.url()}
                fallback={
                  <div
                    class="text-muted-foreground absolute inset-0 flex flex-col
                      items-center justify-center gap-3 p-4 text-center"
                  >
                    <IconMonitor class="size-10" />
                    <p class="text-sm" role="status">
                      {preview.state() === "loading"
                        ? label("preview_loading")
                        : preview.state() === "failed"
                          ? label("preview_failed")
                          : label("preview_select")}
                    </p>
                    <Show
                      when={preview.state() === "failed"}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setPreviewRevision(
                            (value) => value + 1,
                          )
                        }
                      >
                        {label("preview_retry")}
                      </Button>
                    </Show>
                  </div>
                }
              >
                {(url) => (
                  <img
                    src={url()}
                    alt={
                      selection()?.name ?? label("preview")
                    }
                    class="absolute inset-0 size-full object-contain"
                  />
                )}
              </Show>
            </div>
            <p
              class="h-5 truncate text-center text-sm font-medium"
              title={selection()?.name}
            >
              {selection()?.name}
            </p>
          </div>
        </Tabs>
        <Switch
          checked={audio()}
          onChange={setAudio}
          class="flex items-center justify-between gap-4"
        >
          <div class="space-y-1">
            <SwitchLabel>
              {label("share_audio")}
            </SwitchLabel>
            <SwitchDescription class="text-muted-foreground text-xs">
              {label("share_audio_description")}
            </SwitchDescription>
          </div>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
      </div>
    ),
    confirm: (
      <Button
        disabled={!canShare()}
        onClick={() => {
          const source = selection();
          if (canShare() && source)
            dialog.submit({
              sourceId: source.id,
              backend: backend(kind()),
              audio: audio(),
            });
        }}
      >
        {label("share")}
      </Button>
    ),
    cancel: (
      <Button
        variant="outline"
        onClick={() => dialog.close()}
      >
        {t("common.action.cancel")}
      </Button>
    ),
  });
  onCleanup(() => {
    disposed = true;
    generation++;
    dialog.close();
  });
  const choose = async () => {
    setAudio(true);
    setSelected({ monitor: "", window: "" });
    setSearch("");
    setSources([]);
    setCapabilities({ screen: [], window: [] });
    setChoosing(true);
    void loadSources();
    const { result, cancel } = await dialog.open();
    setChoosing(false);
    generation++;
    setLoading(false);
    if (cancel || !result || disposed)
      throw new DOMException(
        "Screen selection cancelled",
        "NotAllowedError",
      );
    return result;
  };
  return {
    choose,
    cancel: () => {
      generation++;
      setChoosing(false);
      dialog.close();
    },
  };
}
