import { Show } from "solid-js";
import { BellRing, LoaderCircle } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useAppState } from "@/libs/state/app-state-context";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";

export function NotificationPermissionButton() {
  if (platform.kind !== "browser") return null;
  const permission =
    useAppState().permissions.notifications;
  const label = () =>
    t(
      permission.busy()
        ? "setting.notifications.requesting"
        : "setting.notifications.allow",
    );
  return (
    <Show
      when={
        appState.options.notifications.enabled &&
        permission.capabilities()?.permission ===
          "default" &&
        !permission.requestUnresolved()
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="text-[12px] max-md:hidden"
        aria-label={label()}
        title={label()}
        aria-busy={permission.busy()}
        disabled={permission.busy()}
        onClick={() => {
          void permission.requestPermission().catch(() => {
            toast.error(
              t("setting.notifications.permission_failed"),
            );
          });
        }}
      >
        <Show
          when={permission.busy()}
          fallback={<BellRing aria-hidden="true" />}
        >
          <LoaderCircle
            class="animate-spin"
            aria-hidden="true"
          />
        </Show>
        <span>{label()}</span>
      </Button>
    </Show>
  );
}
