import { t } from "@/i18n";
import { MIN_VERSIONS } from "@/libs/utils/browser-compatibility";
import { createDialog } from "./dialog";

export const createVersionSupportDetailsDialog = () => {
  const { open } = createDialog({
    title: () =>
      t("browser_unsupported.version_support_details"),
    content: () => (
      <table class="table">
        <thead>
          <tr>
            <th>{t("browser_unsupported.browser")}</th>
            <th>{t("browser_unsupported.version")}</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(MIN_VERSIONS).map(
            ([browser, version]) => (
              <tr>
                <td>{browser}</td>
                <td>{version}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    ),
  });

  return { open };
};
