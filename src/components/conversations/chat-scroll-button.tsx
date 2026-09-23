import { IconArrowDownward } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";

export function ChatScrollButton(props: {
  visible: boolean;
  onClick(): void;
  class?: string;
  iconClass?: string;
}) {
  return (
    <AnimatePresence when={props.visible}>
      <Button
        as={Motion.button}
        type="button"
        variant="secondary"
        size="icon"
        disabled={!props.visible}
        aria-label={t("client.scroll_to_bottom")}
        onClick={() => props.onClick()}
        initial={{ opacity: 0, scale: 0.75, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.75, y: 8 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        class={cn(
          `absolute right-4 bottom-4 z-10 size-11 rounded-full border
          shadow-md backdrop-blur transition-colors`,
          props.class,
        )}
      >
        <IconArrowDownward
          class={cn("size-6 sm:size-8", props.iconClass)}
        />
      </Button>
    </AnimatePresence>
  );
}
