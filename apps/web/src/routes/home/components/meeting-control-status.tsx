import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { defaultRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { createSignal, Show, type JSX } from "solid-js";
import { LoaderCircle, MousePointer2 } from "lucide-solid";
import { IconStop } from "@/components/icons";
import { t } from "@/i18n";

export function MeetingControlStatus(props: {
  name: string;
  side?: "host" | "controller";
  emergencyShortcut?: string;
  children?: JSX.Element;
  revoke(): void | Promise<void>;
}) {
  const [revoking, setRevoking] = createSignal(false);
  const label = () =>
    t(
      props.side === "controller"
        ? "remote_control.controller_active"
        : "remote_control.host_active",
      { name: props.name },
    );
  const actionLabel = () =>
    t(
      props.side === "controller"
        ? "remote_control.end"
        : "common.action.revoke",
    );
  const title = (text: string) =>
    props.side === "controller"
      ? text
      : `${text} · ${shortcutLabel(props.emergencyShortcut ?? defaultRemoteKeyboardOptions.emergencyShortcut)}`;
  return (
    <div
      class="meeting-status-pill max-w-[360px]"
      title={title(label())}
    >
      <MousePointer2
        class="size-4 shrink-0"
        aria-hidden="true"
      />
      <span
        role="status"
        class="min-w-0 truncate font-medium"
        title={title(label())}
        aria-label={label()}
      >
        {props.name ||
          t(
            props.side === "controller"
              ? "remote_control.controller_active_short"
              : "remote_control.host_active_short",
          )}
      </span>
      {props.children}
      <span
        class="meeting-status-divider"
        aria-hidden="true"
      />
      <button
        type="button"
        class="meeting-status-action"
        title={title(actionLabel())}
        aria-label={actionLabel()}
        disabled={revoking()}
        onClick={async () => {
          if (revoking()) return;
          setRevoking(true);
          try {
            await props.revoke();
          } finally {
            setRevoking(false);
          }
        }}
      >
        <Show
          when={revoking()}
          fallback={
            <IconStop class="size-4" aria-hidden="true" />
          }
        >
          <LoaderCircle
            class="size-4 animate-spin"
            aria-hidden="true"
          />
        </Show>
      </button>
    </div>
  );
}
