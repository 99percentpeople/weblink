import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { defaultRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { createSignal, Show, type JSX } from "solid-js";
import { LoaderCircle, X } from "lucide-solid";
import { ControlIndicatorIcon } from "@/components/common/control-indicator";
import { IconStop } from "@/components/icons";
import { t } from "@/i18n";
import { MeetingStatusLabel } from "./meeting-status-label";

export function MeetingControlStatus(props: {
  name: string;
  automation?: boolean;
  side?: "host" | "controller";
  emergencyShortcut?: string;
  children?: JSX.Element;
  revoke?(): void | Promise<void>;
  closeScreen?(): void;
}) {
  const [revoking, setRevoking] = createSignal(false);
  const shortLabel = () =>
    t(
      props.automation
        ? props.side === "controller"
          ? "remote_control.automation_controller_active_short"
          : "remote_control.automation_host_active_short"
        : props.side === "controller"
          ? "remote_control.controller_active_short"
          : "remote_control.host_active_short",
    );
  const label = () =>
    props.name
      ? t(
          props.automation
            ? props.side === "controller"
              ? "remote_control.automation_controller_active"
              : "remote_control.automation_controlled_by"
            : props.side === "controller"
              ? "remote_control.controller_active"
              : "remote_control.host_active",
          { name: props.name },
        )
      : shortLabel();
  const actionLabel = () => t("remote_control.end");
  const title = (text: string) =>
    props.side === "controller"
      ? text
      : `${text} · ${shortcutLabel(props.emergencyShortcut ?? defaultRemoteKeyboardOptions.emergencyShortcut)}`;
  return (
    <div
      class="meeting-status-pill max-w-[360px]"
      title={title(label())}
    >
      <ControlIndicatorIcon
        automation={props.automation}
        class="size-4 shrink-0"
      />
      <MeetingStatusLabel
        name={props.name || shortLabel()}
        label={label()}
        title={title(label())}
      />
      {props.children}
      <Show when={props.revoke}>
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
              await props.revoke?.();
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
      </Show>
      <Show
        when={
          props.side !== "controller" && props.closeScreen
        }
      >
        <span
          class="meeting-status-divider"
          aria-hidden="true"
        />
        <button
          type="button"
          class="meeting-status-action"
          title={t("remote_control.close_screen")}
          aria-label={t("remote_control.close_screen")}
          onClick={() => props.closeScreen?.()}
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
}
