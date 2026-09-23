import { IconArrowUpward } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { createEffect, onCleanup } from "solid-js";

export interface ChatMoreMessageButtonProps {
  viewport: HTMLElement | undefined;
  enabled: boolean;
  onIntersect: () => void;
}

export const ChatMoreMessageButton = (
  props: ChatMoreMessageButtonProps,
) => {
  let ref!: HTMLButtonElement;
  createEffect(() => {
    const viewport = props.viewport;
    const enabled = props.enabled;
    const onIntersect = props.onIntersect;
    if (!enabled || !viewport) return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          active &&
          entries.some((entry) => entry.isIntersecting)
        ) {
          onIntersect();
        }
      },
      { root: viewport, threshold: 0 },
    );
    observer.observe(ref);
    onCleanup(() => {
      active = false;
      observer.disconnect();
    });
  });

  return (
    <Button
      ref={ref}
      onClick={() => props.onIntersect()}
      variant="ghost"
      size="icon"
      aria-label={t("common.show_more")}
      class="rounded-full"
    >
      <IconArrowUpward />
    </Button>
  );
};
