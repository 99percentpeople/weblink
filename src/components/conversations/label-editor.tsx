import { createSignal, For } from "solid-js";
import { Plus, Check, Trash2, Tags } from "lucide-solid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { appState } from "@/libs/state/app-state";
import { messageStores } from "@/libs/application/messaging/message-store";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

export function LabelEditor() {
  const [name, setName] = createSignal("");
  const run = (action: () => void) => {
    try {
      action();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  };
  return (
    <Popover placement="bottom-end" flip>
      <PopoverTrigger
        as={Button}
        size="icon"
        variant="ghost"
        class="size-8"
        aria-label={t("conversations.manage_labels")}
      >
        <Tags class="size-4" />
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-2rem)] space-y-3">
        <PopoverTitle class="font-semibold">
          {t("conversations.manage_labels")}
        </PopoverTitle>
        <form
          class="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => {
              messageStores.createLabel(name());
              setName("");
            });
          }}
        >
          <Input
            aria-label={t("conversations.new_label")}
            placeholder={t("conversations.new_label")}
            value={name()}
            maxLength={48}
            onInput={(event) =>
              setName(event.currentTarget.value)
            }
          />
          <Button
            size="icon"
            type="submit"
            disabled={!name().trim()}
            aria-label={t("conversations.add_label")}
          >
            <Plus class="size-4" />
          </Button>
        </form>
        <div class="max-h-64 space-y-2 overflow-y-auto">
          <For each={appState.message.labels}>
            {(label) => {
              const [draft, setDraft] = createSignal(
                label.name,
              );
              return (
                <form
                  class="flex gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(() =>
                      messageStores.renameLabel(
                        label.id,
                        draft(),
                      ),
                    );
                  }}
                >
                  <Input
                    aria-label={t(
                      "conversations.rename_label",
                      { name: label.name },
                    )}
                    value={draft()}
                    maxLength={48}
                    onInput={(event) =>
                      setDraft(event.currentTarget.value)
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    type="submit"
                    disabled={
                      !draft().trim() ||
                      draft() === label.name
                    }
                    aria-label={t(
                      "conversations.save_label",
                    )}
                  >
                    <Check class="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    type="button"
                    aria-label={t(
                      "conversations.delete_label",
                      { name: label.name },
                    )}
                    onClick={() =>
                      messageStores.deleteLabel(label.id)
                    }
                  >
                    <Trash2 class="size-4" />
                  </Button>
                </form>
              );
            }}
          </For>
        </div>
      </PopoverContent>
    </Popover>
  );
}
