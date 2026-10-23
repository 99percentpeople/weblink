import { For, Show, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { useAppState } from "@/libs/state/app-state-context";
import {
  SettingSection,
  SettingHeading,
  SettingBlock,
  SettingRow,
} from "./setting-layout";
import { SettingSwitch } from "./setting-controls";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { callStatusLabel } from "@/libs/i18n/automation";
import McpServerSettings from "./mcp-server-settings";
import McpTokenSettings from "./mcp-token-settings";
const Empty = (props: { message: string }) => (
  <SettingBlock>
    <p class="text-muted-foreground text-sm">
      {props.message}
    </p>
  </SettingBlock>
);
export default function AutomationSettings() {
  const runtime = useAppState().automation;
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createStore({
    automation: false,
    mcp: false,
  });
  const run = async (
    feature: keyof typeof busy,
    action: () => Promise<unknown>,
  ) => {
    if (busy[feature]) return;
    setError("");
    setBusy(feature, true);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(feature, false);
    }
  };
  const download = (data: unknown) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "weblink-diagnostics.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Show when={runtime}>
      {(r) => (
        <SettingSection
          id="automation-settings"
          title={t("automation.title")}
          description={t("automation.description")}
        >
          <Show when={r().desktop}>
            <SettingSwitch
              checked={r().configuredEnabled()}
              disabled={!r().ready()}
              // Disabling a focused input drops focus to the document body.
              readOnly={busy.automation}
              aria-busy={busy.automation}
              onChange={(value) => {
                void run("automation", () =>
                  r().configure(value),
                );
              }}
              label={t("automation.enable")}
              description={t("automation.desktop")}
            />
          </Show>
          <SettingSwitch
            checked={
              r().desktop
                ? r().configuredMcpEnabled()
                : r().webSupported() && r().mcpEnabled()
            }
            disabled={
              !r().ready() ||
              (!r().desktop && !r().webSupported())
            }
            readOnly={busy.mcp}
            aria-busy={busy.mcp}
            onChange={(value) => {
              void run("mcp", () =>
                r().configureMcp(value),
              );
            }}
            label={t("automation.mcp_enable")}
            description={
              r().desktop
                ? t("automation.mcp_description")
                : r().webSupported()
                  ? t("automation.browser")
                  : t("automation.unsupported")
            }
          />
          <Show when={error() || r().error()}>
            <SettingBlock>
              <p
                role="alert"
                class="text-destructive text-sm"
              >
                {error() || r().error()}
              </p>
            </SettingBlock>
          </Show>
          <Show when={r().snapshot().policiesSuspended}>
            <SettingBlock>
              <p
                role="status"
                class="text-muted-foreground text-sm"
              >
                {t("automation.policies_paused")}
              </p>
            </SettingBlock>
          </Show>
          <Show when={r().desktop}>
            <McpServerSettings runtime={r()} />
            <McpTokenSettings runtime={r()} />
          </Show>
          <Show when={r().active()}>
            <SettingHeading
              description={t("automation.pair_description")}
            >
              {t("automation.peers")}
            </SettingHeading>
            <For
              each={r().peers()}
              fallback={
                <Empty message={t("automation.no_peers")} />
              }
            >
              {(peer) => <SettingRow label={peer.name} />}
            </For>
          </Show>
          <SettingHeading>
            {t("automation.diagnostics")}
          </SettingHeading>
          <SettingRow
            label={t("automation.export")}
            description={t("automation.export_description")}
          >
            <div class="flex justify-end">
              <Button
                size="sm"
                wrap
                variant="outline"
                onClick={() => download(r().export())}
              >
                {t("automation.export")}
              </Button>
            </div>
          </SettingRow>
          <SettingHeading>
            {t("automation.audit")}
          </SettingHeading>
          <SettingBlock>
            <ul class="max-h-64 divide-y overflow-auto">
              <For
                fallback={
                  <li class="text-muted-foreground text-sm">
                    {t("automation.no_audit")}
                  </li>
                }
                each={r()
                  .snapshot()
                  .audit.slice(-50)
                  .reverse()}
              >
                {(entry) => (
                  <li class="flex flex-wrap justify-between gap-x-3 gap-y-1 py-2 text-xs">
                    <span>
                      {entry.principal} ·{" "}
                      <code>{entry.tool}</code>
                    </span>
                    <span class="text-muted-foreground">
                      {new Date(
                        entry.at,
                      ).toLocaleTimeString()}{" "}
                      · {callStatusLabel(entry.status)}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </SettingBlock>
        </SettingSection>
      )}
    </Show>
  );
}
