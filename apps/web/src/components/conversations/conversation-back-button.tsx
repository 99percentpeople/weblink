import { ChevronLeft } from "lucide-solid";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function ConversationBackButton(props: {
  onClick(): void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="shrink-0"
      aria-label={t("conversations.back_to_list")}
      title={t("conversations.back_to_list")}
      onClick={() => props.onClick()}
    >
      <ChevronLeft class="size-5" />
    </Button>
  );
}
