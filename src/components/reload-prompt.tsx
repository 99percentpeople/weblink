import { Component, createEffect, onMount } from "solid-js";
import { useRegisterSW } from "virtual:pwa-register/solid";

export const ReloadPrompt: Component = () => {
  onMount(() => {
    const {
      needRefresh: [needRefresh, setNeedRefresh],
      offlineReady: [offlineReady, setOfflineReady],
      updateServiceWorker,
    } = useRegisterSW({
      immediate: true,
      async onRegisteredSW(swScriptUrl, registration) {
        registration &&
          setInterval(async () => {
            // console.log("Checking for sw update");
            await registration.update();
          }, 60 * 1000 /* 60s for testingpurposes */);
      },
      onRegisterError(error) {
        console.error("SW registration error", error);
      },
    });

    createEffect(() => {
      if (offlineReady()) {
        console.log("App ready to work offline");
      }
    });
  });
  return <></>;
};
