import { createSignal } from "solid-js";
import { RotateCw } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { userErrorMessage } from "@/libs/user-error";

export function MessageRetryButton(props: {
  retry(): Promise<void>;
}) {
  const [retrying, setRetrying] = createSignal(false);
  const retry = async () => {
    if (retrying()) return;
    setRetrying(true);
    try {
      await props.retry();
    } catch (error) {
      toast.error(userErrorMessage(error));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      class="size-6 shrink-0 rounded-full"
      aria-label={t("conversations.retry_failed")}
      title={t("conversations.retry_failed")}
      disabled={retrying()}
      onClick={() => void retry()}
    >
      <RotateCw
        class="size-3"
        classList={{ "animate-spin": retrying() }}
      />
    </Button>
  );
}
