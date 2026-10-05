import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { defaultRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { createSignal, type JSX } from "solid-js";
import { MousePointer2, Square } from "lucide-solid";
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
        : "remote_control.revoke",
    );
  const title = (text: string) =>
    props.side === "controller"
      ? text
      : `${text} · ${shortcutLabel(props.emergencyShortcut ?? defaultRemoteKeyboardOptions.emergencyShortcut)}`;
  return (
    <div class="meeting-status-pill max-w-[360px]">
      <MousePointer2
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <span
        role="status"
        class="min-w-0 truncate font-medium"
        title={title(label())}
      >
        <span class="max-md:hidden">{label()}</span>
        <span class="md:hidden" aria-label={label()}>
          {t(
            props.side === "controller"
              ? "remote_control.controller_active_short"
              : "remote_control.host_active_short",
          )}
        </span>
      </span>
      {props.children}
      <span
        class="bg-input h-[18px] w-px shrink-0"
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
        <Square
          class="size-3.5 md:hidden"
          aria-hidden="true"
        />
        <span class="max-md:hidden">{actionLabel()}</span>
      </button>
    </div>
  );
}
