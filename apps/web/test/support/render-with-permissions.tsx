import { render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { platform } from "@/libs/platform/runtime";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";
import { createAppPermissions } from "@/libs/state/create-app-permissions";

/** Exercise the real application permission lifetime without unrelated room services. */
export function renderWithPermissions(
  view: () => JSX.Element,
) {
  return render(() => {
    const permissions = createAppPermissions({
      notifications: platform.notifications,
      outputSupported: () => true,
    });
    return (
      <AppStateContext.Provider
        value={{ permissions } as AppStateContextProps}
      >
        {view()}
      </AppStateContext.Provider>
    );
  });
}
