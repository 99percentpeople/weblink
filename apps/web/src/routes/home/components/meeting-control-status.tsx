import { createSignal } from "solid-js";
import { MousePointer2 } from "lucide-solid";
import { t } from "@/i18n";

export function MeetingControlStatus(props: {
  name: string;
  revoke(): Promise<void>;
}) {
  const [revoking, setRevoking] = createSignal(false);
  const label = () =>
    t("remote_control.host_active", { name: props.name });
  return (
    <div class="meeting-status-pill max-w-[360px]">
      <MousePointer2
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <span
        role="status"
        class="min-w-0 truncate font-medium"
        title={`${label()} · Ctrl+Alt+Shift+F10`}
      >
        {label()}
      </span>
      <span
        class="bg-input h-[18px] w-px shrink-0"
        aria-hidden="true"
      />
      <button
        type="button"
        class="meeting-status-action"
        title={`${t("remote_control.revoke")} · Ctrl+Alt+Shift+F10`}
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
        {t("remote_control.revoke")}
      </button>
    </div>
  );
}
