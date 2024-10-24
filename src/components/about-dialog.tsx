import { t } from "@/i18n";
import { createDialog } from "./dialogs/dialog";
import IconGitHub from "@/assets/icons/github-mark.svg?component-solid";
import IconGithubWhite from "@/assets/icons/github-mark-white.svg?component-solid";
import { setAppOptions } from "@/options";

const createAboutDialog = () => {
  const {
    open: openAboutDialog,
    Component: AboutDialogComponent,
  } = createDialog({
    title: () => t("common.about_dialog.title"),
    content: () => {
      return (
        <div class="space-y-4 overflow-y-auto">
          <p>{t("common.about_dialog.description1")}</p>
          <p>{t("common.about_dialog.description2")}</p>
          <p>{t("common.about_dialog.features")}</p>
          <p class="font-bold">
            {t("common.about_dialog.disclaimer")}
          </p>
          <p>{t("common.about_dialog.star_repo")}</p>
          <div class="flex gap-2">
            <div class="grid grid-cols-2 gap-2">
              <p>{t("common.about_dialog.version")}</p>
              <p>{__APP_VERSION__}</p>
              <p>{t("common.about_dialog.author")}</p>
              <p>
                <a
                  class="text-blue-500 hover:text-blue-600 hover:underline"
                  target="_blank"
                  href="https://github.com/99percentpeople"
                >
                  99percentpeople
                </a>
              </p>
              <p>{t("common.about_dialog.license")}</p>
              <p>{__APP_LICENSE__}</p>
            </div>
            <div class="flex flex-1 flex-col items-center justify-center gap-2">
              <a
                class="flex flex-col items-center justify-center gap-2"
                target="_blank"
                href="https://github.com/99percentpeople/weblink"
              >
                <IconGitHub class="size-16" />
                <p class="text-sm">
                  {t("common.about_dialog.github")}
                </p>
              </a>
            </div>
          </div>
        </div>
      );
    },
  });

  const open = () => {
    setAppOptions({ showAboutDialog: false });
    openAboutDialog();
  };

  return {
    open,
    Component: () => <AboutDialogComponent />,
  };
};

export default createAboutDialog;
