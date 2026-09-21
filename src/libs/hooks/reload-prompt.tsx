import { t } from "@/i18n";
import { makePersisted } from "@solid-primitives/storage";
import { createSignal, onMount } from "solid-js";
import { toast } from "solid-sonner";
import { registerSW } from "virtual:pwa-register";

export const createReloadPrompt = () => {
  onMount(() => {
    let toastId: string | number | undefined;
    const [prompted, setPrompted] = makePersisted(
      createSignal(false),
      {
        storage: sessionStorage,
        name: "prompted",
      },
    );
    const updateServiceWorker = registerSW({
      immediate: true,
      async onRegisteredSW(swScriptUrl, registration) {
        registration &&
          setInterval(async () => {
            await registration.update();
          }, 60 * 1000 /* 60s for testingpurposes */);
      },
      onRegisterError(error) {
        console.error("SW registration error", error);
      },
      onNeedRefresh() {
        console.debug("weblink need refresh");
        if (toastId !== undefined) return;

        if (prompted()) {
          setPrompted(false);
          updateServiceWorker(true);
          return;
        }
        setPrompted(true);
        toastId = toast.info(
          t("common.notification.new_version_available"),
          {
            action: {
              label: t("common.action.reload"),
              onClick: () => {
                setPrompted(false);
                updateServiceWorker(true);
              },
            },
            cancel: {
              label: t("common.action.close"),
              onClick: () => {},
            },
            duration: Infinity,
          },
        );
      },
      onOfflineReady() {
        console.debug("weblink offline ready");
      },
    });
  });
};
