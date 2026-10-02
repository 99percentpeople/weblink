import { Show } from "solid-js";
import { BellRing, LoaderCircle } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { createNotificationPermission } from "@/libs/hooks/notification-permission";
import { platform } from "@/libs/platform/runtime";

export function NotificationPermissionButton() {
  if (platform.kind !== "browser") return null;
  const permission = createNotificationPermission();
  const label = () =>
    t(
      permission.busy()
        ? "setting.notifications.requesting"
        : "setting.notifications.allow",
    );
  return (
    <Show
      when={
        permission.capabilities()?.permission === "default"
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="max-sm:px-2"
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
        <span class="max-sm:hidden">{label()}</span>
      </Button>
    </Show>
  );
}
