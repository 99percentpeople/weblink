import {
  For,
  Show,
  createMemo,
  createSignal,
} from "solid-js";
import { Plus, Settings2, Trash2 } from "lucide-solid";
import type { AutomationRuntime } from "@/libs/state/create-automation";
import type { McpTokenSummary } from "@weblink/platform";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  SettingBlock,
  SettingHeading,
} from "./setting-layout";
import McpTokenDialog from "./mcp-token-dialog";
import { t } from "@/i18n";

/** Local HTTP credentials; peer identities and remote grants never appear here. */
export default function McpTokenSettings(props: {
  runtime: AutomationRuntime;
}) {
  const [selected, setSelected] = createSignal<{
    client?: McpTokenSummary;
  }>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let requestClose: (() => void) | undefined;
  const clients = createMemo(() =>
    [...props.runtime.snapshot().clients].sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    ),
  );
  const close = () => {
    if (!busy()) setSelected(undefined);
  };
  const remove = async (client: McpTokenSummary) => {
    if (busy() || !props.runtime.ready()) return;
    setBusy(true);
    setError("");
    try {
      await props.runtime.removeClient(client.id);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingHeading
        description={t(
          "automation.credentials_description",
        )}
        actions={
          <Button
            size="sm"
            wrap
            variant="outline"
            disabled={busy() || !props.runtime.ready()}
            onClick={() => setSelected({})}
          >
            <Plus class="size-4" />
            {t("automation.create_client")}
          </Button>
        }
      >
        {t("automation.clients")}
      </SettingHeading>
      <SettingBlock>
        <Show when={error()}>
          <p
            role="alert"
            class="text-destructive mb-2 text-sm"
          >
            {error()}
          </p>
        </Show>
        <Show
          when={clients().length}
          fallback={
            <p class="text-muted-foreground text-sm">
              {t("automation.no_tokens")}
            </p>
          }
        >
          <div class="@container">
            <div
              class="@md:grid-cols-[minmax(0,1fr)_max-content_2rem_2rem] grid
                grid-cols-[minmax(0,1fr)_2rem_2rem] gap-x-2 divide-y
                rounded-lg border px-2.5"
            >
              <For each={clients()}>
                {(client) => (
                  <div class="col-span-full grid grid-cols-subgrid items-center py-1.5">
                    <div class="col-start-1 row-start-1 min-w-0">
                      <p
                        class="break-words text-sm font-medium leading-5"
                        title={client.label}
                      >
                        {client.label}
                      </p>
                      <code class="text-muted-foreground text-[11px]">
                        {client.prefix}…
                      </code>
                    </div>
                    <p
                      class="text-muted-foreground @md:col-start-2 @md:row-start-1
                        col-start-1 row-start-2 min-w-0 text-[11px] tabular-nums
                        leading-5"
                      title={`${t("automation.created_at")}: ${new Date(client.createdAt).toLocaleString()}`}
                    >
                      {client.expiresAt === null
                        ? t("automation.permanent")
                        : `${client.expired ? t("automation.expired") : t("automation.expires_at")}: ${new Date(client.expiresAt).toLocaleString()}`}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="@md:col-start-3 @md:row-span-1 col-start-2 row-span-2
                        row-start-1 size-8"
                      disabled={
                        busy() || !props.runtime.ready()
                      }
                      aria-label={`${t("automation.edit_token")}: ${client.label}`}
                      title={t("automation.edit_token")}
                      onClick={() =>
                        setSelected({ client })
                      }
                    >
                      <Settings2 class="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="@md:col-start-4 @md:row-span-1 col-start-3 row-span-2
                        row-start-1 size-8"
                      disabled={
                        busy() || !props.runtime.ready()
                      }
                      aria-label={`${t("common.action.revoke")}: ${client.label}`}
                      title={t("common.action.revoke")}
                      onClick={() => void remove(client)}
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </SettingBlock>
      <Dialog
        open={!!selected()}
        onOpenChange={(open) => {
          if (!open) requestClose?.();
        }}
      >
        <DialogContent>
          <Show when={selected()} keyed>
            {(selection) => (
              <McpTokenDialog
                runtime={props.runtime}
                client={selection.client}
                close={close}
                onBusy={setBusy}
                onCloseRequest={(handler) => {
                  requestClose = handler;
                }}
              />
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
}
