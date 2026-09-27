import { IconArrowDownward } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { t } from "@/i18n";

export function ChatScrollButton(props: {
  visible: boolean;
  onClick(): void;
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
        class="absolute right-3 bottom-3 z-10 size-9 rounded-full border
          shadow backdrop-blur transition-colors"
      >
        <IconArrowDownward class="size-5" />
      </Button>
    </AnimatePresence>
  );
}
