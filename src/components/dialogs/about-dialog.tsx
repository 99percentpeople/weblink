import { t } from "@/i18n";
import { createDialog } from "./dialog";
import IconGitHub from "@/assets/icons/github-mark.svg?component-solid";

const createAboutDialog = () => {
  const { open: openAboutDialog } = createDialog({
    title: () => t("common.about_dialog.title"),
    content: () => {
      return (
        <div class="flex flex-col gap-4">
          <p>{t("common.about_dialog.description1")}</p>
          <p>{t("common.about_dialog.description2")}</p>
          <p>{t("common.about_dialog.description3")}</p>
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
                  href={__APP_AUTHOR_URL__}
                >
                  {__APP_AUTHOR_NAME__}
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
          <p class="muted text-xs">{__APP_BUILD_TIME__}</p>
        </div>
      );
    },
  });

  return {
    open: openAboutDialog,
  };
};

export default createAboutDialog;
