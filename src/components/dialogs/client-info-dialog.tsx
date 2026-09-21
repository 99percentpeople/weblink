import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  type JSX,
} from "solid-js";
import { ConnectionBadge } from "@/components/common/connection-badge";
import { createDialog } from "@/components/dialogs/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsIndicator,
  TabsContent,
} from "@/components/ui/tabs";
import { PeerSpeedTest } from "@/components/peer-speed-test";
import { createClipboardHistoryDialog } from "@/components/dialogs/clipboard-history-dialog";
import { createComfirmDeleteClientDialog } from "@/components/dialogs/confirm-delete-client-dialog";
import {
  IconAssignment,
  IconConnectWithoutContract,
  IconDelete,
  IconInfo,
} from "@/components/icons";
import { t } from "@/i18n";
import { catchError } from "@/libs/catch";
import { messageStores } from "@/libs/core/message";
import type { ClientID } from "@/libs/core/type";
import {
  notifyClientInfoDialogTabVisible,
  type ClientInfoDialogTab,
} from "@/components/dialogs/client-info-dialog-events";
import { appState } from "@/libs/state/app-state";
import { createSessionDiagnostics } from "@/libs/hooks/session-diagnostics";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import {
  getClientConfig,
  setAppOptions,
  setClientConfig,
} from "@/options";
import { toast } from "solid-sonner";

export type ClientInfoTab = ClientInfoDialogTab;

function Metric(props: {
  label: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="min-w-0 rounded-lg border p-3">
      <dt class="text-muted-foreground text-xs">
        {props.label}
      </dt>
      <dd class="mt-1 font-mono text-sm break-words tabular-nums">
        {props.children}
      </dd>
    </div>
  );
}

/** Switching/unmounting these views must never cancel an application task. */
export function ClientInfoPanel(props: {
  clientId: ClientID | null;
  active: boolean;
  tab: ClientInfoTab;
  onTabChange: (tab: ClientInfoTab) => void;
  onDeleted?: () => void;
}) {
  const info = () =>
    props.clientId
      ? appState.session.clientViewData[props.clientId]
      : undefined;
  const client = () =>
    appState.message.clients.find(
      (item) => item.clientId === props.clientId,
    );
  const session = () =>
    props.clientId
      ? appState.session.sessions[props.clientId]
      : undefined;
  const stats = createSessionDiagnostics(
    () => session()?.peerConnection,
    () => props.active,
  );
  const { open: openClipboardHistoryDialog } =
    createClipboardHistoryDialog();
  const { open: openConfirmDeleteClientDialog } =
    createComfirmDeleteClientDialog();
  const clientConfig = () =>
    props.clientId
      ? getClientConfig(props.clientId)
      : undefined;
  const [copyState, setCopyState] = createSignal<
    "idle" | "copied" | "error"
  >("idle");
  createEffect(() => {
    props.clientId;
    props.active;
    setCopyState("idle");
  });

  createEffect(() => {
    if (
      props.active &&
      props.clientId &&
      props.tab === "speed"
    ) {
      notifyClientInfoDialogTabVisible(
        props.clientId,
        props.tab,
      );
    }
  });
  // Do not stringify a large report for the summary/speed panes.
  const raw = createMemo(() =>
    props.active && props.tab === "raw"
      ? JSON.stringify(stats().reports, null, 2)
      : "",
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw());
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  const bytes = (value: number | undefined) =>
    value === undefined ? "—" : formatBtyeSize(value);

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col gap-4">
      <div
        class="bg-muted/50 flex min-w-0 flex-wrap items-center
          justify-between gap-2 rounded-lg p-3"
      >
        <div class="min-w-0">
          <p class="font-medium break-all">
            {client()?.name ?? props.clientId ?? "—"}
          </p>
          <p class="text-muted-foreground text-xs">
            {t(
              "common.client_info_dialog.session_subtitle",
            )}
          </p>
        </div>
        <ConnectionBadge client={info()} />
      </div>
      <Tabs
        class="flex min-h-0 flex-1 flex-col"
        value={props.tab}
        onChange={(value) => {
          setCopyState("idle");
          props.onTabChange(value as ClientInfoTab);
        }}
      >
        <TabsList
          class="shrink-0"
          aria-label={t(
            "common.client_info_dialog.sections",
          )}
        >
          <TabsTrigger value="session">
            {t("common.client_info_dialog.tabs.session")}
          </TabsTrigger>
          <TabsTrigger value="speed">
            {t("common.client_info_dialog.tabs.speed")}
          </TabsTrigger>
          <TabsTrigger value="raw">
            {t("common.client_info_dialog.tabs.raw")}
          </TabsTrigger>
          <TabsTrigger value="settings">
            {t("common.client_info_dialog.tabs.settings")}
          </TabsTrigger>
          <TabsIndicator />
        </TabsList>
        <TabsContent
          value="session"
          class="min-h-80 space-y-4 pt-2"
        >
          <label class="flex flex-col gap-2 text-sm">
            {t("common.client_info_dialog.client_id")}
            <Input
              readOnly
              value={props.clientId ?? ""}
              class="font-mono text-xs"
            />
          </label>
          <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Metric
              label={t(
                "common.client_info_dialog.candidate_type",
              )}
            >
              {stats().candidateRoute ?? "—"}
            </Metric>
            <Metric
              label={t(
                "common.client_info_dialog.round_trip_time",
              )}
            >
              {stats().rttMs === undefined
                ? "—"
                : `${stats().rttMs!.toFixed(1)} ms`}
            </Metric>
            <Metric
              label={t(
                "common.client_info_dialog.sent_bytes",
              )}
            >
              {bytes(stats().bytesSent)}
            </Metric>
            <Metric
              label={t(
                "common.client_info_dialog.received_bytes",
              )}
            >
              {bytes(stats().bytesReceived)}
            </Metric>
            <Metric
              label={
                <span class="inline-flex items-center gap-1">
                  {t(
                    "common.client_info_dialog.available_outgoing_bitrate",
                  )}
                  <Tooltip placement="top">
                    <TooltipTrigger
                      as="button"
                      type="button"
                      class="text-muted-foreground hover:text-foreground
                        focus-visible:ring-ring inline-flex size-4 items-center
                        justify-center rounded-full transition-colors
                        focus-visible:ring-2 focus-visible:outline-none"
                      aria-label={t(
                        "common.client_info_dialog.summary_note",
                      )}
                    >
                      <IconInfo class="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent class="max-w-72 leading-relaxed whitespace-normal">
                      {t(
                        "common.client_info_dialog.summary_note",
                      )}
                    </TooltipContent>
                  </Tooltip>
                </span>
              }
            >
              {stats().outgoingBitrate === undefined
                ? "—"
                : `${(stats().outgoingBitrate! / 1_000_000).toFixed(2)} Mbps`}
            </Metric>
            <Metric
              label={t(
                "common.client_info_dialog.created_at",
              )}
            >
              {info()?.createdAt === undefined
                ? "—"
                : new Date(
                    info()!.createdAt,
                  ).toLocaleString()}
            </Metric>
          </dl>
          <Show when={stats().error}>
            <p role="status" class="text-sm">
              {t("common.client_info_dialog.stats_error")}
            </p>
          </Show>
          <Show
            when={
              info()?.onlineStatus === "offline" &&
              appState.session.clientServiceStatus ===
                "connected"
            }
          >
            <Button
              type="button"
              variant="outline"
              class="gap-2"
              onClick={async () => {
                const session = props.clientId
                  ? appState.session.sessions[
                      props.clientId
                    ]
                  : undefined;
                if (!session) return;
                const [error] = await catchError(
                  session.reconnect(),
                );
                if (error) toast.error(error.message);
              }}
            >
              <IconConnectWithoutContract class="size-4" />
              {t("client.menu.connect")}
            </Button>
          </Show>
        </TabsContent>
        <TabsContent value="speed" class="min-h-80 pt-2">
          <PeerSpeedTest
            clientId={props.clientId}
            connected={info()?.onlineStatus === "online"}
          />
        </TabsContent>
        <TabsContent
          value="raw"
          class="flex min-h-80 flex-1 flex-col gap-3 pt-2"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-medium">
              {t("common.client_info_dialog.stats_reports")}
            </h3>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !raw() || stats().reports.length === 0
              }
              onClick={() => void copy()}
            >
              {t("common.action.copy")}
            </Button>
          </div>
          <p class="text-muted-foreground text-xs whitespace-normal">
            {t("common.client_info_dialog.raw_note")}
          </p>
          <Textarea
            aria-label={t(
              "common.client_info_dialog.stats_reports",
            )}
            readOnly
            value={raw()}
            spellcheck={false}
            class="scrollbar-thin min-h-0 w-full flex-1 resize-none
              overflow-auto font-mono text-xs whitespace-pre"
          />
          <Show when={copyState() !== "idle"}>
            <p role="status" class="text-sm">
              {t(
                `common.client_info_dialog.${copyState()}`,
              )}
            </p>
          </Show>
          <Show when={stats().error}>
            <p role="status" class="text-sm">
              {t("common.client_info_dialog.stats_error")}
            </p>
          </Show>
        </TabsContent>
        <TabsContent
          value="settings"
          class="min-h-80 space-y-6 pt-2"
        >
          <div>
            <h3 class="text-sm font-medium">
              {t("client.config.preferences")}
            </h3>
            <p class="text-muted-foreground text-xs">
              {t("client.config.preferences_description")}
            </p>
          </div>

          <div class="space-y-2">
            <Switch
              class="flex items-center justify-between gap-4"
              checked={
                !!props.clientId &&
                appState.options.redirectToClient ===
                  props.clientId
              }
              onChange={(checked) => {
                if (!props.clientId) return;
                setAppOptions(
                  "redirectToClient",
                  checked ? props.clientId : undefined,
                );
              }}
            >
              <div class="min-w-0 space-y-1">
                <SwitchLabel>
                  {t("client.config.redirect.title")}
                </SwitchLabel>
              </div>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
            <p class="text-muted-foreground text-xs whitespace-normal">
              {t("client.config.redirect.description")}
            </p>
          </div>
          <div class="space-y-2">
            <Switch
              class="flex items-center justify-between gap-4"
              checked={
                clientConfig()?.provideFileList ?? true
              }
              onChange={(checked) => {
                if (!props.clientId) return;
                setClientConfig(props.clientId, {
                  provideFileList: checked,
                });
              }}
            >
              <div class="min-w-0 space-y-1">
                <SwitchLabel>
                  {t(
                    "client.config.provide_file_list.title",
                  )}
                </SwitchLabel>
              </div>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
            <p class="text-muted-foreground text-xs whitespace-normal">
              {t(
                "client.config.provide_file_list.description",
              )}
            </p>
          </div>

          <div class="space-y-2">
            <h3 class="text-sm font-medium">
              {t("client.config.actions")}
            </h3>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Show when={info()?.clipboard}>
                {(clipboard) => (
                  <Button
                    type="button"
                    variant="outline"
                    class="justify-start gap-2"
                    onClick={() =>
                      void openClipboardHistoryDialog(
                        clipboard,
                      )
                    }
                  >
                    <IconAssignment class="size-4" />
                    {t("client.menu.clipboard")}
                  </Button>
                )}
              </Show>
              <div>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={async () => {
                    if (!props.clientId || !client())
                      return;
                    const result = (
                      await openConfirmDeleteClientDialog(
                        client()!.name,
                      )
                    ).result;
                    if (!result) return;
                    const clientId = props.clientId;
                    messageStores.deleteClient(clientId);
                    setAppOptions(
                      "clientConfigs",
                      clientId,
                      undefined,
                    );
                    if (
                      appState.options.redirectToClient ===
                      clientId
                    ) {
                      setAppOptions(
                        "redirectToClient",
                        undefined,
                      );
                    }
                    props.onDeleted?.();
                  }}
                >
                  <IconDelete class="size-4" />
                  {t("client.menu.delete_client")}
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const clientInfoDialog = () => {
  const [target, setTarget] = createSignal<ClientID | null>(
    null,
  );
  const [active, setActive] = createSignal(false);
  const [tab, setTab] =
    createSignal<ClientInfoTab>("session");
  const client = () =>
    appState.message.clients.find(
      (item) => item.clientId === target(),
    );
  const dialog = createDialog({
    class:
      "h-[min(42rem,calc(100dvh-2rem))] [&_[data-slot=dialog-body]]:flex [&_[data-slot=dialog-body]]:min-h-0 [&_[data-slot=dialog-body]]:flex-1 [&_[data-slot=dialog-body]]:flex-col",
    onCancel: () => setActive(false),
    title: () =>
      t("common.client_info_dialog.title", {
        name: client()?.name ?? target() ?? "",
      }),
    content: () => (
      <ClientInfoPanel
        clientId={target()}
        active={active()}
        tab={tab()}
        onTabChange={setTab}
        onDeleted={() => dialog.close()}
      />
    ),
  });
  return {
    open: (
      clientId: ClientID,
      initialTab: ClientInfoTab = "session",
    ) => {
      setTarget(clientId);
      setTab(initialTab);
      setActive(true);
      return dialog.open();
    },
    close: dialog.close,
  };
};

export default clientInfoDialog;
