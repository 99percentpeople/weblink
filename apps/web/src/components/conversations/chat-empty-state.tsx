import { MessageCircle } from "lucide-solid";
import { t } from "@/i18n";

export function ChatEmptyState() {
  return (
    <li
      class="text-muted-foreground m-auto max-w-72 px-4 text-center
        text-sm"
    >
      <MessageCircle
        class="mx-auto mb-3 size-10 opacity-30"
        aria-hidden="true"
      />
      {t("conversations.no_messages")}
    </li>
  );
}
