import { t } from "@/i18n";
import { createDialog } from "./dialog";
import { AboutContent } from "@/components/common/about-content";

const createAboutDialog = () => {
  const { open: openAboutDialog } = createDialog({
    title: () => t("common.about_dialog.title"),
    content: () => {
      return (
        <div class="space-y-5">
          <AboutContent />
          <p class="text-muted-foreground border-t pt-4 text-xs leading-relaxed">
            {t("common.about_dialog.disclaimer")}
          </p>
        </div>
      );
    },
  });

  return {
    open: openAboutDialog,
  };
};

export default createAboutDialog;
