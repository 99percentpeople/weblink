import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import type { AutomationRuntime } from "@/libs/state/create-automation";
import {
  DEFAULT_MCP_SERVER,
  type McpServerConfig,
} from "@weblink/platform";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-solid";
import {
  SettingBlock,
  SettingHeading,
  SettingRow,
} from "./setting-layout";
import { SettingInput } from "./setting-controls";
import { createSettingsWriter } from "./create-settings-writer";
import { t } from "@/i18n";

export default function McpServerSettings(props: {
  runtime: AutomationRuntime;
}) {
  const config = () => props.runtime.snapshot().server;
  const endpoints = () => {
    const snapshot = props.runtime.snapshot();
    return snapshot.endpoints?.length
      ? snapshot.endpoints
      : snapshot.endpoint
        ? [snapshot.endpoint]
        : [];
  };
  const savedHost = createMemo(() => config().host);
  const savedPort = createMemo(() => config().port);
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("");
  const [validation, setValidation] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const writer = createSettingsWriter<
    McpServerConfig,
    McpServerConfig
  >((config) => props.runtime.configureServer(config));
  let dirty = false;
  let draftRevision = 0;
  const reset = () => {
    setHost(savedHost());
    setPort(String(savedPort()));
  };
  // Status polling and older save responses must not overwrite a field being edited.
  createEffect(
    on([savedHost, savedPort], () => {
      if (!dirty) reset();
    }),
  );
  const edit = () => {
    dirty = true;
    draftRevision++;
    setValidation("");
    writer.clearError();
    setSaved(false);
  };
  const save = () => {
    if (!props.runtime.ready() || !dirty) return;
    if (!host().trim()) {
      setValidation(t("automation.server_invalid_host"));
      return;
    }
    if (
      !/^\d+$/.test(port()) ||
      Number(port()) < 1 ||
      Number(port()) > 65535
    ) {
      setValidation(t("automation.server_invalid_port"));
      return;
    }
    const revision = draftRevision;
    void writer.save(
      { host: host().trim(), port: Number(port()) },
      (committed) => {
        if (revision !== draftRevision) return;
        dirty = false;
        setHost(committed.host);
        setPort(String(committed.port));
        setSaved(true);
      },
    );
  };
  const error = () => {
    const message = writer.error();
    return (
      validation() ||
      (message === "INVALID_MCP_HOST"
        ? t("automation.server_invalid_host")
        : message === "INVALID_MCP_PORT"
          ? t("automation.server_invalid_port")
          : message)
    );
  };
  // Closing the settings dialog with Escape may remove a focused input without blur.
  onCleanup(save);
  return (
    <>
      <SettingHeading
        description={t("automation.server_description")}
      >
        {t("automation.server")}
      </SettingHeading>
      <SettingRow
        label={t("automation.server_status")}
        description={t(
          "automation.server_apply_description",
        )}
      >
        <div class="flex justify-end">
          <span class="text-sm">
            {t(
              props.runtime.enabled()
                ? "automation.server_active"
                : "automation.server_inactive",
            )}
          </span>
        </div>
      </SettingRow>
      <Show
        when={
          props.runtime.enabled() && endpoints().length > 0
        }
      >
        <SettingRow
          layout="stacked"
          label={t("automation.endpoint")}
        >
          <div class="flex min-w-0 flex-col gap-2">
            <For each={endpoints()}>
              {(endpoint) => (
                <code class="select-all break-all text-sm">
                  {endpoint}
                </code>
              )}
            </For>
          </div>
        </SettingRow>
      </Show>
      <Show when={props.runtime.snapshot().serverPending}>
        <SettingBlock>
          <p
            role="status"
            class="text-muted-foreground text-sm"
          >
            {t("automation.server_pending")}
          </p>
        </SettingBlock>
      </Show>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <SettingInput
          label={t("automation.server_host")}
          description={t(
            "automation.server_host_description",
          )}
          disabled={!props.runtime.ready()}
          value={host()}
          placeholder="127.0.0.1"
          spellcheck={false}
          onInput={(e) => {
            setHost(e.currentTarget.value);
            edit();
          }}
          onBlur={save}
        />
        <SettingInput
          label={t("automation.server_port")}
          description={t(
            "automation.server_port_description",
          )}
          disabled={!props.runtime.ready()}
          type="number"
          min={1}
          max={65535}
          step={1}
          value={port()}
          onInput={(e) => {
            setPort(e.currentTarget.value);
            edit();
          }}
          onBlur={save}
        />
      </form>
      <Show
        when={
          error() ||
          writer.saving() ||
          saved() ||
          host() !== DEFAULT_MCP_SERVER.host ||
          port() !== String(DEFAULT_MCP_SERVER.port)
        }
      >
        <SettingBlock>
          <Show
            when={error()}
            fallback={
              <Show when={writer.saving() || saved()}>
                <p
                  role="status"
                  class="text-muted-foreground text-sm"
                >
                  {t(
                    writer.saving()
                      ? "automation.saving"
                      : "automation.settings_saved",
                  )}
                </p>
              </Show>
            }
          >
            <p
              role="alert"
              class="text-destructive text-sm"
            >
              {error()}
            </p>
          </Show>
          <Show
            when={
              host() !== DEFAULT_MCP_SERVER.host ||
              port() !== String(DEFAULT_MCP_SERVER.port)
            }
          >
            <div class="setting-actions">
              <Button
                type="button"
                size="sm"
                wrap
                variant="outline"
                disabled={!props.runtime.ready()}
                onClick={() => {
                  setHost(DEFAULT_MCP_SERVER.host);
                  setPort(String(DEFAULT_MCP_SERVER.port));
                  edit();
                  save();
                }}
              >
                <RotateCcw class="size-4" />
                {t("automation.server_reset")}
              </Button>
            </div>
          </Show>
        </SettingBlock>
      </Show>
    </>
  );
}
