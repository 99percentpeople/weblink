import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type {
  CaptureSource,
  CaptureStatus,
} from "@weblink/platform";
import { platform } from "@/libs/platform/runtime";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function NativeCaptureSettings() {
  const capture = platform.capture;
  const [available, setAvailable] = createSignal(false);
  const [sources, setSources] = createSignal<
    CaptureSource[]
  >([]);
  const [selected, setSelected] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [status, setStatus] = createSignal<CaptureStatus>();
  let disposed = false;
  let ownedId: string | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = () => status()?.state === "running";
  const label = (key: string) =>
    t(`setting.native_capture.${key}`);
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const release = (id: string) =>
    capture?.stop(id).catch((cause: unknown) => {
      // The native lease also expires if IPC or the webview disappears.
      console.error("Could not stop native capture", cause);
    });

  function apply(next: CaptureStatus) {
    setStatus(next);
    if (next.state !== "running") ownedId = null;
    if (next.error) setError(next.error);
  }

  function poll(id: string, token: number) {
    clearTimer();
    timer = setTimeout(async () => {
      if (
        disposed ||
        token !== generation ||
        ownedId !== id ||
        !capture
      )
        return;
      try {
        const next = await capture.status(id);
        if (
          disposed ||
          token !== generation ||
          ownedId !== id
        )
          return;
        apply(next);
        if (next.state === "running") poll(id, token);
      } catch (cause) {
        if (
          disposed ||
          token !== generation ||
          ownedId !== id
        )
          return;
        setError(message(cause));
        // Keep Stop available and retry status; transient IPC failures are not a stopped session.
        poll(id, token);
      }
    }, 500);
  }

  async function refresh() {
    if (!capture) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await capture.sources();
      if (disposed) return;
      setSources(next);
      if (!next.some((source) => source.id === selected()))
        setSelected("");
    } catch (cause) {
      if (!disposed) setError(message(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function start() {
    if (!capture || !selected() || busy() || running())
      return;
    setBusy(true);
    setError(undefined);
    const token = ++generation;
    try {
      const next = await capture.start(selected());
      if (disposed) {
        if (next.sessionId) await release(next.sessionId);
        return;
      }
      ownedId =
        next.state === "running" ? next.sessionId : null;
      apply(next);
      if (ownedId) poll(ownedId, token);
    } catch (cause) {
      if (!disposed) setError(message(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function stop() {
    if (!capture || !ownedId || busy()) return;
    const id = ownedId;
    const token = ++generation;
    clearTimer();
    setBusy(true);
    setError(undefined);
    try {
      const next = await capture.stop(id);
      if (!disposed) apply(next);
    } catch (cause) {
      if (!disposed) {
        setError(message(cause));
        poll(id, token);
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  onMount(async () => {
    if (!capture) return;
    try {
      const caps = await platform.getCapabilities();
      if (disposed || !caps.nativeScreenCapture) return;
      setAvailable(true);
      await refresh();
    } catch (cause) {
      if (!disposed) {
        setAvailable(true);
        setError(message(cause));
      }
    }
  });

  onCleanup(() => {
    disposed = true;
    generation++;
    clearTimer();
    if (ownedId) void release(ownedId);
    ownedId = null;
  });

  return (
    <Show when={available()}>
      <div class="flex flex-col gap-3">
        <h4 class="h4">{label("title")}</h4>
        <p class="muted">{label("description")}</p>
        <label class="flex flex-col gap-2">
          <span class="text-sm font-medium">
            {label("source")}
          </span>
          <select
            class="bg-background border-input h-10 w-full rounded-md border
              px-3 text-sm"
            value={selected()}
            disabled={busy() || running()}
            onChange={(event) =>
              setSelected(event.currentTarget.value)
            }
          >
            <option value="">
              {label("select_source")}
            </option>
            <For each={sources()}>
              {(source) => (
                <option value={source.id}>
                  {label(source.kind)} · {source.name} (
                  {source.width} × {source.height})
                </option>
              )}
            </For>
          </select>
        </label>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy() || running()}
            onClick={() => void refresh()}
          >
            {label("refresh")}
          </Button>
          <Button
            disabled={busy() || running() || !selected()}
            onClick={() => void start()}
          >
            {label("start")}
          </Button>
          <Button
            variant="outline"
            disabled={busy() || !running()}
            onClick={() => void stop()}
          >
            {label("stop")}
          </Button>
        </div>
        <Show when={status()}>
          {(stats) => (
            <div
              class="flex flex-col gap-1 text-sm"
              role="status"
            >
              <span>{label(`state.${stats().state}`)}</span>
              <span>{stats().source?.name}</span>
              <span>
                {stats().width} × {stats().height} ·{" "}
                {stats().fps.toFixed(1)} FPS ·{" "}
                {stats().frames} {label("frames")}
              </span>
              <Show
                when={
                  stats().state === "running" &&
                  stats().frames === 0
                }
              >
                <span>{label("waiting")}</span>
              </Show>
              <Show
                when={
                  stats().stopReason ===
                  "clientDisconnected"
                }
              >
                <span>{label("disconnected")}</span>
              </Show>
            </div>
          )}
        </Show>
        <p class="muted">{label("hint")}</p>
        <Show when={error()}>
          {(text) => (
            <p
              class="text-destructive text-sm"
              role="alert"
            >
              {text()}
            </p>
          )}
        </Show>
      </div>
    </Show>
  );
}
