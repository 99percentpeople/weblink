import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useAppState } from "@/libs/state/app-state-context";
import {
  SpeedTestError,
  type SpeedTestErrorCode,
  type SpeedTestProgress,
} from "@/libs/core/speed-test-protocol";
import type { ClientID } from "@/libs/core/ids";

const GAUGE_ARC = 66.667;
const GAUGE_SWEEP = 240;
const GAUGE_START_ANGLE = -120;
const GAUGE_ROTATION = 150;
const GAUGE_CENTER = 100;
const GAUGE_RADIUS = 82;
const NEEDLE_RADIUS = 64;
const GAUGE_TICK_OUTER_RADIUS = 74;
const GAUGE_TICK_MAJOR_INNER_RADIUS = 67;
const GAUGE_TICK_MINOR_INNER_RADIUS = 70;
const GAUGE_LABEL_RADIUS = 58;
const GAUGE_TICKS = Array.from(
  { length: 9 },
  (_, index) => index / 8,
);

function gaugePoint(angle: number, radius: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: GAUGE_CENTER + Math.sin(radians) * radius,
    y: GAUGE_CENTER - Math.cos(radians) * radius,
  };
}

function formatMbps(value: number) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function gaugeLimit(value: number) {
  const safe = Math.max(0, value);
  if (safe <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / magnitude;
  const factor =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 5
          ? 5
          : 10;
  return factor * magnitude;
}

function formatGaugeTick(value: number) {
  if (value >= 1000)
    return Number.isInteger(value / 1000)
      ? `${value / 1000}k`
      : `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function SpeedDirectionIcon(props: {
  direction: "upload" | "download";
  class?: string;
}) {
  return (
    <svg
      viewBox="0 -960 960 960"
      class={props.class ?? "size-4 fill-current"}
      aria-hidden="true"
    >
      <Show
        when={props.direction === "upload"}
        fallback={
          <path d="m480-332 146-146-42-42-74 74v-182h-60v182l-74-74-42 42 146 146Zm0 252q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-156t86-127Q252-817 325-848.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 82-31.5 155T763-197.5q-54 54.5-127 86T480-80Zm0-60q142 0 241-99.5T820-480q0-142-99-241t-241-99q-141 0-240.5 99T140-480q0 141 99.5 240.5T480-140Zm0-340Z" />
        }
      >
        <path d="M450-332h60v-182l74 74 42-42-146-146-146 146 42 42 74-74v182Zm30 252q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-156t86-127Q252-817 325-848.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 82-31.5 155T763-197.5q-54 54.5-127 86T480-80Zm0-60q142 0 241-99.5T820-480q0-142-99-241t-241-99q-141 0-240.5 99T140-480q0 141 99.5 240.5T480-140Zm0-340Z" />
      </Show>
    </svg>
  );
}

function SpeedGauge(props: {
  value: number;
  bytes?: number;
  label: string;
  direction?: "upload" | "download";
  idle: boolean;
  showValue: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const [max, setMax] = createSignal(10);
  let rangeDirection: "upload" | "download" | undefined;

  createEffect(() => {
    const direction = props.direction;
    if (!props.showValue || !direction) {
      rangeDirection = direction;
      setMax(10);
      return;
    }
    const required = gaugeLimit(props.value);
    if (rangeDirection !== direction) {
      rangeDirection = direction;
      setMax(required);
      return;
    }
    setMax((current) => Math.max(current, required));
  });

  const ratio = createMemo(() =>
    Math.min(1, Math.max(0, props.value / max())),
  );
  const dash = createMemo(() => GAUGE_ARC * ratio());
  const needleAngle = createMemo(
    () => GAUGE_START_ANGLE + GAUGE_SWEEP * ratio(),
  );

  return (
    <div
      class="relative mx-auto aspect-square w-full max-w-72"
      role={props.showValue ? "meter" : undefined}
      aria-label={
        props.showValue
          ? `${props.label}: ${formatMbps(props.value)} Mbps`
          : undefined
      }
      aria-valuemin={props.showValue ? 0 : undefined}
      aria-valuemax={props.showValue ? max() : undefined}
      aria-valuenow={
        props.showValue ? props.value : undefined
      }
    >
      <svg
        viewBox="0 0 200 200"
        class="absolute inset-0 size-full"
        aria-hidden="true"
      >
        <circle
          cx={GAUGE_CENTER}
          cy={GAUGE_CENTER}
          r={GAUGE_RADIUS}
          fill="none"
          pathLength="100"
          stroke="currentColor"
          stroke-width="10"
          stroke-linecap="round"
          stroke-dasharray={`${GAUGE_ARC} ${100 - GAUGE_ARC}`}
          transform={`rotate(${GAUGE_ROTATION} ${GAUGE_CENTER} ${GAUGE_CENTER})`}
          class="text-muted-foreground/15"
        />
        <circle
          cx={GAUGE_CENTER}
          cy={GAUGE_CENTER}
          r={GAUGE_RADIUS}
          fill="none"
          pathLength="100"
          stroke="currentColor"
          stroke-width="10"
          stroke-linecap="round"
          stroke-dasharray={`${dash()} 100`}
          transform={`rotate(${GAUGE_ROTATION} ${GAUGE_CENTER} ${GAUGE_CENTER})`}
          class="text-primary transition-[stroke-dasharray] duration-300
            ease-out"
        />
        <For each={GAUGE_TICKS}>
          {(tick) => {
            const angle =
              GAUGE_START_ANGLE + GAUGE_SWEEP * tick;
            const major =
              tick === 0 ||
              tick === 0.25 ||
              tick === 0.5 ||
              tick === 0.75 ||
              tick === 1;
            const start = gaugePoint(
              angle,
              major
                ? GAUGE_TICK_MAJOR_INNER_RADIUS
                : GAUGE_TICK_MINOR_INNER_RADIUS,
            );
            const end = gaugePoint(
              angle,
              GAUGE_TICK_OUTER_RADIUS,
            );
            return (
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="currentColor"
                stroke-width={major ? 1.6 : 1}
                stroke-linecap="round"
                class={
                  major
                    ? "text-muted-foreground/65"
                    : "text-muted-foreground/35"
                }
              />
            );
          }}
        </For>
        <For each={[0, 0.25, 0.5, 0.75, 1]}>
          {(tick) => {
            const point = gaugePoint(
              GAUGE_START_ANGLE + GAUGE_SWEEP * tick,
              GAUGE_LABEL_RADIUS,
            );
            return (
              <text
                x={point.x}
                y={point.y}
                text-anchor="middle"
                dominant-baseline="middle"
                class="fill-muted-foreground text-[8px]"
              >
                {formatGaugeTick(max() * tick)}
              </text>
            );
          }}
        </For>
        <Show when={props.showValue}>
          <line
            data-speed-test-needle
            x1={GAUGE_CENTER}
            y1={GAUGE_CENTER}
            x2={GAUGE_CENTER}
            y2={GAUGE_CENTER - NEEDLE_RADIUS}
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            class="text-foreground transition-transform duration-300 ease-out"
            style={{
              "transform-box": "view-box",
              "transform-origin": `${GAUGE_CENTER}px ${GAUGE_CENTER}px`,
              transform: `rotate(${needleAngle()}deg)`,
            }}
          />
          <circle
            cx={GAUGE_CENTER}
            cy={GAUGE_CENTER}
            r="5"
            class="fill-foreground"
          />
        </Show>
      </svg>

      <Show
        when={!props.idle}
        fallback={
          <div class="absolute inset-0 flex items-center justify-center">
            <Button
              type="button"
              class="size-24 rounded-full text-base font-semibold"
              disabled={props.disabled}
              onClick={props.onStart}
            >
              {t("speed_test.start")}
            </Button>
          </div>
        }
      >
        <div
          class="absolute inset-x-0 top-[56%] flex flex-col items-center
            text-center"
        >
          <Show
            when={props.showValue}
            fallback={
              <div class="text-sm font-medium">
                {props.label}
              </div>
            }
          >
            <div class="font-mono text-4xl font-semibold tracking-tight tabular-nums">
              {formatMbps(props.value)}
            </div>
            <div class="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
              <Show when={props.bytes !== undefined}>
                <span class="font-mono tabular-nums">
                  {(props.bytes! / 1024 / 1024).toFixed(2)}{" "}
                  MiB
                </span>
                <span
                  aria-hidden="true"
                  class="bg-border mx-1 h-3 w-px"
                />
              </Show>
              <Show when={props.direction}>
                {(direction) => (
                  <span
                    role="img"
                    aria-label={t(
                      `speed_test.${direction()}`,
                    )}
                    title={t(`speed_test.${direction()}`)}
                    class="flex size-4 items-center justify-center"
                  >
                    <SpeedDirectionIcon
                      direction={direction()}
                      class="size-4 fill-current"
                    />
                  </span>
                )}
              </Show>
              <span>Mbps</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function ResultMetric(props: {
  direction: "upload" | "download";
  bytesPerSecond?: number;
  bytes?: number;
  durationMs?: number;
}) {
  const mbps = () =>
    props.bytesPerSecond === undefined
      ? undefined
      : (props.bytesPerSecond * 8) / 1_000_000;

  return (
    <div class="bg-muted/35 min-w-0 rounded-xl border p-3">
      <div class="flex items-center gap-1.5 font-mono tabular-nums">
        <span
          role="img"
          aria-label={t(`speed_test.${props.direction}`)}
          title={t(`speed_test.${props.direction}`)}
          class="text-muted-foreground flex size-5 shrink-0 items-center
            justify-center"
        >
          <SpeedDirectionIcon direction={props.direction} />
        </span>
        <span class="text-xl font-semibold">
          {mbps() === undefined ? "—" : mbps()!.toFixed(2)}
        </span>
        <Show when={mbps() !== undefined}>
          <span class="text-muted-foreground text-xs">
            Mbps
          </span>
        </Show>
      </div>
      <div class="text-muted-foreground mt-1 min-h-4 text-xs">
        <Show
          when={
            props.bytesPerSecond !== undefined &&
            props.bytes !== undefined &&
            props.durationMs !== undefined
          }
        >
          {(props.bytesPerSecond! / 1024 / 1024).toFixed(2)}{" "}
          MiB/s
          {" · "}
          {(props.bytes! / 1024 / 1024).toFixed(2)} MiB
          {" · "}
          {(props.durationMs! / 1000).toFixed(2)} s
        </Show>
      </div>
    </div>
  );
}

export function PeerSpeedTest(props: {
  clientId: ClientID | null;
  connected: boolean;
}) {
  const app = useAppState();
  const [localError, setLocalError] =
    createSignal<SpeedTestErrorCode>();
  const [introHidden, setIntroHidden] = createSignal(false);
  const [liveMbps, setLiveMbps] = createSignal(0);

  let livePhase: SpeedTestProgress["phase"] | undefined;
  let livePeer: ClientID | null = null;
  let liveBytes = 0;
  let liveAt = 0;

  createEffect(() => {
    props.clientId;
    setLocalError(undefined);
    setIntroHidden(false);
    setLiveMbps(0);
    livePhase = undefined;
    livePeer = null;
    liveBytes = 0;
    liveAt = 0;
  });

  const state = () => app.speedTestState();
  const current = () =>
    app.getSpeedTestState(props.clientId);
  const running = () => state().status === "running";
  const awaitingLocalApproval = () =>
    current()?.status === "running" &&
    current()?.incoming === true &&
    current()?.progress?.phase === "approval";
  const error = () => localError() ?? current()?.error;
  const hasTestState = () => current() !== undefined;
  const idle = () => !hasTestState() && !introHidden();

  createEffect(() => {
    const progress =
      current()?.status === "running"
        ? current()?.progress
        : undefined;
    const peer = props.clientId;

    if (
      !progress ||
      (progress.phase !== "upload" &&
        progress.phase !== "download")
    ) {
      livePhase = progress?.phase;
      livePeer = peer;
      liveBytes = progress?.bytes ?? 0;
      liveAt = performance.now();
      setLiveMbps(0);
      return;
    }

    const now = performance.now();
    if (
      livePeer !== peer ||
      livePhase !== progress.phase ||
      progress.bytes < liveBytes ||
      progress.bytes === 0
    ) {
      livePeer = peer;
      livePhase = progress.phase;
      liveBytes = progress.bytes;
      liveAt = now;
      setLiveMbps(0);
      return;
    }

    const elapsed = now - liveAt;
    const delta = progress.bytes - liveBytes;
    if (delta > 0 && elapsed > 0) {
      const sampleMbps = (delta * 8) / elapsed / 1000;
      setLiveMbps((previous) =>
        previous === 0
          ? sampleMbps
          : previous * 0.55 + sampleMbps * 0.45,
      );
    }
    liveBytes = progress.bytes;
    liveAt = now;
  });

  const measurement = (direction: "upload" | "download") =>
    current()?.result?.[direction] ??
    current()?.measurements?.[direction];

  const showGaugeValue = () => {
    const progress = current()?.progress;
    return (
      current()?.status === "running" &&
      (progress?.phase === "upload" ||
        progress?.phase === "download")
    );
  };
  const gaugeValue = () =>
    current()?.status === "running" ? liveMbps() : 0;
  const gaugeLabel = () => {
    const progress = current()?.progress;
    if (
      current()?.status === "running" &&
      progress?.phase
    ) {
      return t(
        progress.phase === "approval" && current()?.incoming
          ? "speed_test.phases.approval_incoming"
          : `speed_test.phases.${progress.phase}`,
      );
    }
    return t("speed_test.title");
  };

  const start = async () => {
    const clientId = props.clientId;
    if (!clientId) return;
    setIntroHidden(true);
    setLocalError(undefined);
    try {
      await app.startSpeedTest(clientId);
    } catch (error) {
      if (props.clientId !== clientId) return;
      setLocalError(
        error instanceof SpeedTestError
          ? error.code
          : "failed",
      );
    }
  };

  return (
    <section
      class="col-span-3 flex min-w-0 flex-col gap-4 whitespace-normal"
      aria-label={t("speed_test.title")}
    >
      <Show when={idle()}>
        <div class="space-y-1">
          <h3 class="font-medium">
            {t("speed_test.title")}
          </h3>
          <p class="text-muted-foreground text-sm">
            {t("speed_test.description")}
          </p>
          <p class="text-muted-foreground text-xs">
            {t("speed_test.traffic_notice")}
          </p>
          <p class="text-muted-foreground text-xs">
            {t("speed_test.background_notice")}
          </p>
        </div>
      </Show>

      <Show when={current()?.status !== "done"}>
        <SpeedGauge
          value={gaugeValue()}
          bytes={
            showGaugeValue()
              ? current()?.progress?.bytes
              : undefined
          }
          label={gaugeLabel()}
          direction={
            showGaugeValue()
              ? current()?.progress?.phase === "upload"
                ? "upload"
                : "download"
              : undefined
          }
          idle={idle()}
          showValue={showGaugeValue()}
          disabled={!props.connected || running()}
          onStart={() => void start()}
        />
      </Show>

      <Show when={!idle()}>
        <div class="grid grid-cols-2 gap-3">
          <ResultMetric
            direction="download"
            bytesPerSecond={
              measurement("download")?.bytesPerSecond
            }
            bytes={measurement("download")?.bytes}
            durationMs={measurement("download")?.durationMs}
          />
          <ResultMetric
            direction="upload"
            bytesPerSecond={
              measurement("upload")?.bytesPerSecond
            }
            bytes={measurement("upload")?.bytes}
            durationMs={measurement("upload")?.durationMs}
          />
        </div>
      </Show>

      <div class="flex flex-wrap justify-center gap-2">
        <Show
          when={!idle() && current()?.status !== "running"}
        >
          <Button
            type="button"
            size="sm"
            disabled={!props.connected || running()}
            onClick={() => void start()}
          >
            {t("speed_test.start")}
          </Button>
        </Show>
        <Show when={awaitingLocalApproval()}>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              props.clientId &&
              app.approveSpeedTest(props.clientId)
            }
          >
            {t("speed_test.accept")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              props.clientId &&
              app.declineSpeedTest(props.clientId)
            }
          >
            {t("speed_test.decline")}
          </Button>
        </Show>
        <Show
          when={
            current()?.status === "running" &&
            !awaitingLocalApproval()
          }
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              props.clientId &&
              app.cancelSpeedTest(props.clientId)
            }
          >
            {t("speed_test.cancel")}
          </Button>
        </Show>
      </div>

      <div role="status" aria-live="polite" class="text-sm">
        <Show when={!props.connected}>
          <p class="text-center">
            {t("speed_test.errors.offline")}
          </p>
        </Show>
        <Show
          when={
            running() && state().peerId !== props.clientId
          }
        >
          <p class="text-center">
            {t("speed_test.errors.busy")}
          </p>
        </Show>
        <Show when={error()}>
          {(code) => (
            <p class="text-center">
              {t(`speed_test.errors.${code()}`)}
            </p>
          )}
        </Show>
        <Show
          when={
            current()?.status === "done" &&
            current()?.result
          }
        >
          {(result) => (
            <>
              <div class="sr-only">
                <For each={["upload", "download"] as const}>
                  {(direction) => (
                    <span>
                      {t(`speed_test.${direction}`)}{" "}
                      {(
                        (result()[direction]
                          .bytesPerSecond *
                          8) /
                        1_000_000
                      ).toFixed(2)}{" "}
                      Mbps /{" "}
                      {(
                        result()[direction].bytesPerSecond /
                        1024 /
                        1024
                      ).toFixed(2)}{" "}
                      MiB/s
                    </span>
                  )}
                </For>
              </div>
              <p class="text-muted-foreground mt-2 text-center text-xs">
                {t("speed_test.measured_at", {
                  time: new Date(
                    result().completedAt,
                  ).toLocaleString(),
                })}
              </p>
              <p class="text-muted-foreground text-center text-xs">
                {t("speed_test.result_note")}
              </p>
              <Show
                when={
                  result().upload.durationMs < 1000 ||
                  result().download.durationMs < 1000
                }
              >
                <p class="text-muted-foreground text-center text-xs">
                  {t("speed_test.short_sample")}
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
