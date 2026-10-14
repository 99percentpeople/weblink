import { userErrorMessage } from "@/libs/user-error";
import { Match, Show, Switch, type JSX } from "solid-js";
import {
  Check,
  Download,
  Pause,
  Play,
  Square,
} from "lucide-solid";
import { t } from "@/i18n";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import createTransferSpeed from "@/libs/hooks/transfer-speed";

export type TransferAction =
  | "pause"
  | "resume"
  | "request"
  | "cancel";

/** The SVG owns progress semantics; its sibling button remains accessible. */
export function FileTransferIndicator(props: {
  received?: number;
  total: number;
  complete?: boolean;
  busy?: boolean;
  action?: TransferAction;
  showProgress?: boolean;
  label?: string;
  disabled?: boolean;
  onAction?: () => void;
  children?: JSX.Element;
}) {
  const percent = () =>
    props.complete
      ? 100
      : Math.min(
          100,
          Math.max(
            0,
            props.total > 0
              ? ((props.received ?? 0) / props.total) * 100
              : 0,
          ),
        );
  const label = () =>
    props.label ??
    t(
      props.action === "cancel"
        ? "common.action.cancel"
        : props.action === "request"
          ? "conversations.room_file_request"
          : props.action === "pause"
            ? "tasks.pause"
            : "tasks.resume",
    );
  const indeterminate = () =>
    !!props.busy &&
    props.received === undefined &&
    !props.complete &&
    props.action === undefined;
  const showRing = () =>
    props.showProgress !== false &&
    (props.complete ||
      props.received !== undefined ||
      indeterminate());
  return (
    <div
      class="relative size-11 shrink-0"
      data-slot="file-transfer-indicator"
    >
      <Show when={showRing()}>
        <svg
          class="pointer-events-none absolute inset-0 size-full -rotate-90"
          classList={{
            "animate-spin": indeterminate(),
          }}
          viewBox="0 0 44 44"
          role="progressbar"
          aria-label={t("tasks.progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            indeterminate() ? undefined : percent()
          }
        >
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            class="opacity-15"
          />
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            pathLength="100"
            stroke-dasharray="100"
            stroke-dashoffset={
              100 - (indeterminate() ? 25 : percent())
            }
            class="transition-[stroke-dashoffset] duration-200"
          />
        </svg>
      </Show>
      <Show
        when={props.action}
        fallback={
          <span
            class="absolute inset-1 flex items-center justify-center"
            aria-hidden="true"
          >
            <Show
              when={props.complete}
              fallback={
                props.children ?? (
                  <Show when={!props.busy}>
                    <Pause class="size-4 opacity-50" />
                  </Show>
                )
              }
            >
              <Check class="size-4" />
            </Show>
          </span>
        }
      >
        <button
          type="button"
          class="hover:bg-foreground/10 focus-visible:ring-ring absolute
            inset-1 flex items-center justify-center rounded-full
            outline-none focus-visible:ring-2 disabled:opacity-40"
          classList={{
            "bg-foreground/5": !showRing(),
          }}
          aria-label={label()}
          title={label()}
          disabled={props.disabled}
          onClick={() => props.onAction?.()}
        >
          <Switch fallback={<Download class="size-4" />}>
            <Match when={props.action === "cancel"}>
              <Square class="size-4" />
            </Match>
            <Match when={props.action === "pause"}>
              <Pause class="size-4" />
            </Match>
            <Match when={props.action === "resume"}>
              <Play class="size-4" />
            </Match>
          </Switch>
          <span class="sr-only">{label()}</span>
        </button>
      </Show>
    </div>
  );
}

export function FileTransferDetails(props: {
  status: string;
  received?: number;
  total: number;
  live?: boolean;
  queued?: boolean;
  error?: string;
}) {
  return (
    <span
      class="flex min-h-4 min-w-0 items-center gap-x-2 overflow-hidden
        whitespace-nowrap text-xs tabular-nums leading-4"
      title={
        props.error
          ? userErrorMessage(
              props.error,
              "errors.file_failed",
            )
          : undefined
      }
      data-slot="file-transfer-details"
    >
      <span
        class="min-w-0 flex-1 truncate"
        data-slot="file-transfer-status"
      >
        <Show
          when={props.live && !props.queued}
          fallback={
            props.queued
              ? t("tasks.status.waiting")
              : props.status
          }
        >
          {(_live) => {
            const speed = createTransferSpeed(
              () => props.received ?? 0,
            );
            return (
              <>
                {() =>
                  `${formatBtyeSize(speed() ?? 0, 2)}/s`
                }
              </>
            );
          }}
        </Show>
      </span>
      <Show when={props.received !== undefined}>
        <span
          class="min-w-0 max-w-[65%] truncate"
          title={`${formatBtyeSize(props.received ?? 0)} / ${formatBtyeSize(props.total)}`}
        >
          {formatBtyeSize(props.received ?? 0)} /{" "}
          {formatBtyeSize(props.total)}
        </span>
      </Show>
    </span>
  );
}
