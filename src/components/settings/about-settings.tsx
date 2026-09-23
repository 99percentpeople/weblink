import { createSignal, Show } from "solid-js";
import { reconcile } from "solid-js/store";
import { Eraser, RotateCcw } from "lucide-solid";
import { toast } from "solid-sonner";
import { AboutContent } from "@/components/common/about-content";
import { Spinner } from "@/components/common/spinner";
import { Button } from "@/components/ui/button";
import {
  createClearServiceWorkerCacheDialog,
  createResetOptionsDialog,
} from "@/components/dialogs/setting-dialogs";
import {
  setAppOptions,
  getDefaultAppOptions,
} from "@/options";
import { t } from "@/i18n";

export default function AboutSettings() {
  const resetDialog = createResetOptionsDialog();
  const cacheDialog = createClearServiceWorkerCacheDialog();
  const [pending, setPending] = createSignal<
    "reset" | "cache" | null
  >(null);
  const cacheSupported = () =>
    typeof window !== "undefined" &&
    "caches" in window &&
    "serviceWorker" in navigator;

  const maintain = async (action: "reset" | "cache") => {
    if (pending()) return;
    setPending(action);
    try {
      if (action === "reset") {
        if (!(await resetDialog.open()).result) return;
        // Replace nested maps and remove optional values absent from defaults.
        setAppOptions(reconcile(getDefaultAppOptions()));
        toast.success(
          t("common.notification.reset_options_success"),
        );
      } else {
        const { result } = await cacheDialog.open();
        if (!result) return;
        const keys = await window.caches.keys();
        await Promise.all(
          keys.map((key) => window.caches.delete(key)),
        );
        const registrations =
          await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations.map((registration) =>
            registration.unregister(),
          ),
        );
        toast.success(
          t("common.notification.clear_cache_success"),
        );
        if (result.reload) window.location.reload();
      }
    } catch (error) {
      toast.error(
        t(
          action === "reset"
            ? "setting.about.reset_failed"
            : "common.notification.clear_cache_failed",
          {
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
        ),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <section class="settings-section">
      <AboutContent />
      <section class="space-y-1 border-t pt-5">
        <h3 class="text-sm font-semibold">
          {t("setting.about.maintenance")}
        </h3>
        <div class="divide-border divide-y">
          <div
            class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center
              sm:justify-between sm:gap-6"
          >
            <div class="min-w-0 space-y-1">
              <h4 class="text-sm font-medium">
                {t("setting.about.reset_options")}
              </h4>
              <p class="text-muted-foreground text-xs leading-relaxed">
                {t("setting.about.reset_description")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              class="text-destructive hover:text-destructive self-start
                sm:self-auto"
              disabled={pending() !== null}
              aria-busy={pending() === "reset"}
              onClick={() => void maintain("reset")}
            >
              <Show
                when={pending() === "reset"}
                fallback={<RotateCcw class="size-4" />}
              >
                <Spinner size="sm" aria-hidden="true" />
              </Show>
              {t("setting.about.reset_options")}
            </Button>
          </div>
          <Show when={cacheSupported()}>
            <div
              class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center
                sm:justify-between sm:gap-6"
            >
              <div class="min-w-0 space-y-1">
                <h4 class="text-sm font-medium">
                  {t(
                    "setting.about.clear_service_worker_cache",
                  )}
                </h4>
                <p class="text-muted-foreground text-xs leading-relaxed">
                  {t("setting.about.cache_description")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                class="self-start sm:self-auto"
                disabled={pending() !== null}
                aria-busy={pending() === "cache"}
                onClick={() => void maintain("cache")}
              >
                <Show
                  when={pending() === "cache"}
                  fallback={<Eraser class="size-4" />}
                >
                  <Spinner size="sm" aria-hidden="true" />
                </Show>
                {t(
                  "setting.about.clear_service_worker_cache",
                )}
              </Button>
            </div>
          </Show>
        </div>
      </section>
    </section>
  );
}
