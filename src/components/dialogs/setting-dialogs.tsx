import { t } from "@/i18n";
import { createDialog } from "./dialog";
import { createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

export const createResetOptionsDialog = () => {
  const { open, close, submit } = createDialog({
    title: () => t("common.reset_options_dialog.title"),
    description: () =>
      t("common.reset_options_dialog.description"),
    content: () => (
      <p>{t("common.reset_options_dialog.content")}</p>
    ),
    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
  });
  return { open };
};

export const createClearServiceWorkerCacheDialog = () => {
  const [reload, setReload] = createSignal(true);
  const { open, close, submit } = createDialog<{
    reload: boolean;
  }>({
    title: () =>
      t("common.clear_service_worker_cache_dialog.title"),
    description: () =>
      t(
        "common.clear_service_worker_cache_dialog.description",
      ),
    content: () => (
      <>
        <p>
          {t(
            "common.clear_service_worker_cache_dialog.content",
          )}
        </p>
        <div>
          <Switch
            class="flex items-center justify-between text-sm"
            checked={reload()}
            onChange={(isChecked) => setReload(isChecked)}
          >
            <SwitchLabel>
              {t(
                "common.clear_service_worker_cache_dialog.reload",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </div>
      </>
    ),
    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() =>
          submit({
            reload: reload(),
          })
        }
      >
        {t("common.action.confirm")}
      </Button>
    ),
  });
  return {
    open: () => {
      setReload(true);
      return open();
    },
  };
};
