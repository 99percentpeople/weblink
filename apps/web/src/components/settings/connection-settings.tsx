import { SettingSection } from "./setting-layout";
import { SettingTagList } from "./setting-tag-list";
import { SettingSwitch } from "./setting-controls";
import { userErrorMessage } from "@/libs/user-error";
import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { reconcile } from "solid-js/store";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";

import { t } from "@/i18n";
import {
  IceServerDiagnostics,
  type IceServerDiagnosticResult,
} from "@/libs/application/ice-server-diagnostics";
import { cn } from "@/libs/cn";
import { appState } from "@/libs/state/app-state";
import {
  getDefaultAppOptions,
  parseTurnServers,
  setAppOptions,
  stringifyTurnServers,
} from "@/options";

function CheckAvailabilityButton(props: {
  check(): Promise<IceServerDiagnosticResult[]>;
}) {
  const [checking, setChecking] = createSignal(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={checking()}
      onClick={async () => {
        setChecking(true);
        try {
          const results = await props.check();
          toast.info(() => (
            <div class="flex flex-col gap-2 text-xs">
              <For each={results}>
                {(result) => (
                  <p
                    class={cn(
                      "space-x-1",
                      result.msg === "available"
                        ? "text-success-foreground"
                        : "text-destructive-foreground",
                    )}
                  >
                    <span>{result.server}:</span>
                    <span>
                      {result.msg === "available"
                        ? t("setting.connection.available")
                        : userErrorMessage(
                            result.msg,
                            "errors.ice_unavailable",
                          )}
                    </span>
                  </p>
                )}
              </For>
            </div>
          ));
        } catch (error) {
          toast.error(
            userErrorMessage(
              error,
              "errors.ice_unavailable",
            ),
          );
        } finally {
          setChecking(false);
        }
      }}
    >
      {t("common.action.check_availability")}
    </Button>
  );
}

export interface ConnectionSettingsProps {
  diagnostics?: Pick<
    IceServerDiagnostics,
    "checkStunServers" | "checkTurnServers"
  >;
}

export function ConnectionSettings(
  props: ConnectionSettingsProps,
) {
  const diagnostics =
    props.diagnostics ?? new IceServerDiagnostics();
  const turnServersValue = createMemo(() =>
    stringifyTurnServers(appState.options.servers.turns),
  );

  return (
    <SettingSection
      id="connection"
      title={t("setting.connection.title")}
    >
      <SettingTagList
        label={t("setting.connection.stun_servers.title")}
        description={t(
          "setting.connection.stun_servers.description",
        )}
        placeholder="stun:stun.l.google.com:19302"
        values={appState.options.servers.stuns}
        onChange={(values) =>
          setAppOptions("servers", "stuns", values)
        }
        errorMessage={(error) =>
          userErrorMessage(error, "errors.ice_config")
        }
        actions={
          <>
            <Show
              when={
                import.meta.env.WEBLINK_STUN_SERVERS &&
                import.meta.env.WEBLINK_STUN_SERVERS !==
                  appState.options.servers.stuns.join(",")
              }
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setAppOptions(
                    "servers",
                    "stuns",
                    getDefaultAppOptions().servers.stuns,
                  )
                }
              >
                {t("common.action.reset")}
              </Button>
            </Show>
            <Show
              when={
                appState.options.servers.stuns.length > 0 &&
                appState.options.servers.stuns
              }
            >
              {(stuns) => (
                <CheckAvailabilityButton
                  check={() =>
                    diagnostics.checkStunServers(stuns())
                  }
                />
              )}
            </Show>
          </>
        }
      />
      <SettingTagList
        label={t("setting.connection.turn_servers.title")}
        description={t(
          "setting.connection.turn_servers.description",
        )}
        placeholder="turn:turn.example.com:3478|user|password|longterm"
        values={turnServersValue()
          .split("\n")
          .filter(Boolean)}
        itemLabel={(value) => {
          const [url, username] = value.split("|");
          return username ? `${url} · ${username}` : url;
        }}
        onChange={(values) => {
          const turns = parseTurnServers(values.join("\n"));
          setAppOptions(
            "servers",
            "turns",
            reconcile(turns),
          );
        }}
        errorMessage={(error) =>
          userErrorMessage(error, "errors.ice_config")
        }
        actions={
          <>
            <Show
              when={
                import.meta.env.VITE_TURN_SERVERS &&
                import.meta.env.VITE_TURN_SERVERS !==
                  turnServersValue().split("\n").join(",")
              }
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setAppOptions(
                    "servers",
                    "turns",
                    getDefaultAppOptions().servers.turns,
                  )
                }
              >
                {t("common.action.reset")}
              </Button>
            </Show>
            <Show
              when={
                appState.options.servers.turns.length > 0 &&
                appState.options.servers.turns
              }
            >
              {(turns) => (
                <CheckAvailabilityButton
                  check={() =>
                    diagnostics.checkTurnServers(turns())
                  }
                />
              )}
            </Show>
          </>
        }
      />
      <SettingSwitch
        checked={appState.options.shareServersWithOthers}
        onChange={(isChecked) =>
          setAppOptions("shareServersWithOthers", isChecked)
        }
        label={t(
          "setting.connection.share_servers_with_others.title",
        )}
        description={t(
          "setting.connection.share_servers_with_others.description",
        )}
      />
    </SettingSection>
  );
}
