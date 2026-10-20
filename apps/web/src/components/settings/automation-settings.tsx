import AutomationPermissions from "./automation-permissions";
import { For, Show, createSignal } from "solid-js";
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
  const [busy, setBusy] = createSignal(false);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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
          <SettingSwitch
            checked={r().configuredEnabled()}
            disabled={!r().ready() || busy()}
            onChange={(value) => {
              void run(() => r().configure(value));
            }}
            label={t("automation.enable")}
            description={
              r().desktop
                ? t("automation.desktop")
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
          <SettingRow
            label={t("automation.session_control")}
            description={t("automation.stop_description")}
          >
            <div class="flex justify-end">
              <Button
                size="sm"
                wrap
                variant="destructive"
                disabled={!r().enabled() || busy()}
                onClick={() => void run(() => r().stop())}
              >
                {t("automation.stop")}
              </Button>
            </div>
          </SettingRow>
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
          <Show when={r().enabled()}>
            <AutomationPermissions runtime={r()} />
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
              {(peer) => (
                <SettingRow label={peer.name}>
                  <code class="text-sm">{peer.code}</code>
                </SettingRow>
              )}
            </For>
            <Show when={r().desktop}>
              <SettingHeading>
                {t("automation.jobs")}
              </SettingHeading>
              <For
                each={r().snapshot().jobs}
                fallback={
                  <Empty
                    message={t("automation.no_jobs")}
                  />
                }
              >
                {(job) => (
                  <SettingRow label={<code>{job.id}</code>}>
                    <span class="text-sm">
                      {job.status}
                      {job.exitCode !== null
                        ? ` (${job.exitCode})`
                        : ""}
                    </span>
                  </SettingRow>
                )}
              </For>
            </Show>
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
                      · {entry.status}
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
