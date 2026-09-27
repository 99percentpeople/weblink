import { Button } from "@/components/ui/button";
import { A, RouteSectionProps } from "@solidjs/router";
import { t } from "@/i18n";

export default function NotFound(props: RouteSectionProps) {
  return (
    <main
      class="mx-auto flex min-h-[calc(100%_-_3rem)] flex-col items-center
        justify-center gap-8 p-4"
    >
      <h1 class="max-6-xs text-6xl font-thin uppercase">
        {t("404.title")}
      </h1>
      <p>
        {t("404.description", {
          path: props.params?.path,
        })}
      </p>
      <p class="my-4">
        <Button as={A} href="/" variant="outline" class="">
          {t("404.home")}
        </Button>
      </p>
    </main>
  );
}
