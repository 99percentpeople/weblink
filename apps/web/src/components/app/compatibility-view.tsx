import { t } from "@/i18n";
import {
  checkBrowserSupport,
  isWebRTCAvailable,
} from "@/libs/utils/browser-compatibility";
import { APP_NAME } from "@/constants";
import { JSX } from "solid-js";
import { createVersionSupportDetailsDialog } from "@/components/dialogs/compatibility-dialog";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Button } from "@/components/ui/button";

export const CompatibilityView = (props: {
  children: JSX.Element;
}) => {
  let reasons = [];

  if (!checkBrowserSupport()) {
    reasons.push(() =>
      t(
        "browser_unsupported.reasons.browser_version_too_low",
      ),
    );
  }
  if (!isWebRTCAvailable()) {
    reasons.push(() =>
      t(
        "browser_unsupported.reasons.browser_does_not_support_webrtc",
      ),
    );
  }
  const { open: openVersionSupportDetailsDialog } =
    createVersionSupportDetailsDialog();

  if (reasons.length === 0) {
    return props.children;
  }

  return (
    <>
      <div
        class="bg-background/80 flex h-full min-h-0 flex-col
          overflow-y-auto p-2 backdrop-blur"
      >
        <div class="flex items-center justify-between">
          <h2 class="p-2 font-mono text-xl font-bold">
            {APP_NAME}
          </h2>
          <ThemeToggle />
        </div>

        <div
          class="flex flex-1 flex-col items-center justify-center gap-4
            text-center"
        >
          <h1 class="text-4xl font-bold">
            {t("browser_unsupported.title")}
          </h1>
          <ul>
            {reasons.map((reason) => (
              <li>{reason()}</li>
            ))}
          </ul>
          <p class="text-muted-foreground text-sm">
            {t("browser_unsupported.description")}
          </p>

          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              openVersionSupportDetailsDialog()
            }
          >
            {t(
              "browser_unsupported.version_support_details",
            )}
          </Button>
        </div>
        <div class="flex flex-col gap-2">
          <p class="text-muted-foreground self-end text-xs">
            {navigator.userAgent}
          </p>
        </div>
      </div>
    </>
  );
};
