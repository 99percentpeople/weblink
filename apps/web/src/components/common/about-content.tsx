import { createSignal } from "solid-js";
import {
  Copy,
  ExternalLink,
  Github,
  History,
  MessageSquare,
} from "lucide-solid";
import { toast } from "solid-sonner";
import { Brand } from "./brand";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/constants";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";

const repositoryUrl =
  "https://github.com/99percentpeople/weblink";

/** Shared by the first-run introduction and the settings About tab. */
export function AboutContent() {
  const [copying, setCopying] = createSignal(false);
  const builtAt = new Date(__APP_BUILD_TIME__);
  const copyVersion = async () => {
    if (copying()) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(
        `${APP_NAME} ${__APP_VERSION__}\nBuild: ${builtAt.toISOString()}`,
      );
      toast.success(t("common.notification.copy_success"));
    } catch {
      toast.error(t("setting.about.copy_failed"));
    } finally {
      setCopying(false);
    }
  };

  return (
    <div class="flex min-w-0 flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <Brand class="h-12 max-w-full" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={copying()}
          onClick={() => void copyVersion()}
        >
          <Copy class="size-4" />
          {t("setting.about.copy_version")}
        </Button>
      </div>
      <p class="text-muted-foreground text-sm leading-relaxed">
        {t("common.about_dialog.description1")}
      </p>
      <dl class="grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <div class="space-y-1">
          <dt class="text-muted-foreground text-xs">
            {t("common.about_dialog.version")}
          </dt>
          <dd class="text-sm font-medium">
            {__APP_VERSION__}
          </dd>
        </div>
        <div class="space-y-1">
          <dt class="text-muted-foreground text-xs">
            {t("setting.about.build_time")}
          </dt>
          <dd class="text-sm">
            <time dateTime={builtAt.toISOString()}>
              {builtAt.toLocaleString(
                appState.options.locale,
              )}
            </time>
          </dd>
        </div>
        <div class="space-y-1">
          <dt class="text-muted-foreground text-xs">
            {t("common.about_dialog.author")}
          </dt>
          <dd class="text-sm">
            <a
              class="text-primary inline-flex items-center gap-1 rounded-sm
                hover:underline focus-visible:outline-offset-4"
              href={__APP_AUTHOR_URL__}
              target="_blank"
              rel="noopener noreferrer"
            >
              {__APP_AUTHOR_NAME__}
              <ExternalLink class="size-3.5" />
            </a>
          </dd>
        </div>
        <div class="space-y-1">
          <dt class="text-muted-foreground text-xs">
            {t("common.about_dialog.license")}
          </dt>
          <dd class="text-sm">{__APP_LICENSE__}</dd>
        </div>
      </dl>
      <div class="flex flex-wrap gap-2">
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={repositoryUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Github class="size-4" />
          {t("common.about_dialog.github")}
        </Button>
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={`${repositoryUrl}/releases`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <History class="size-4" />
          {t("setting.about.changelog")}
        </Button>
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={`${repositoryUrl}/issues`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <MessageSquare class="size-4" />
          {t("setting.about.feedback")}
        </Button>
      </div>
    </div>
  );
}
