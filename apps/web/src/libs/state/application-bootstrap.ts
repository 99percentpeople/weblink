import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Router } from "@solidjs/router";
import {
  ColorModeProvider,
  ColorModeScript,
  createLocalStorageManager,
} from "@kobalte/core";
import { CompatibilityView } from "@/components/app/compatibility-view";
import {
  checkBrowserSupport,
  isWebRTCAvailable,
} from "@/libs/utils/browser-compatibility";
import routes from "@/routes";
import { createApplicationRoot } from "./application-root";

/** The unaccepted entry dependency provides Vite's native application-rebuild boundary. */
export function mountApplication(
  root: HTMLElement,
): () => void {
  return render(() => {
    const storageManager =
      createLocalStorageManager("ui-theme");
    return [
      createComponent(ColorModeScript, {
        storageType: storageManager.type,
      }),
      createComponent(ColorModeProvider, {
        storageManager,
        get children() {
          if (
            !checkBrowserSupport() ||
            !isWebRTCAvailable()
          )
            return createComponent(CompatibilityView, {
              children: null,
            });
          return createComponent(Router, {
            root: createApplicationRoot,
            children: routes,
          });
        },
      }),
    ];
  }, root);
}
