/* @refresh reload */
import "@/global.css";
import { render } from "solid-js/web";
import { Router } from "@solidjs/router";
import { lazy } from "solid-js";
import {
  ColorModeProvider,
  createLocalStorageManager,
} from "@kobalte/core";
import { ColorModeScript } from "@kobalte/core";
import { CompatibilityView } from "@/components/app/compatibility-view";
import routes from "@/routes";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

const App = lazy(() => import("@/app"));

render(() => {
  const storageManager =
    createLocalStorageManager("ui-theme");
  return (
    <>
      <ColorModeScript storageType={storageManager.type} />
      <ColorModeProvider storageManager={storageManager}>
        <CompatibilityView>
          <Router root={App}>{routes}</Router>
        </CompatibilityView>
      </ColorModeProvider>
    </>
  );
}, root!);
