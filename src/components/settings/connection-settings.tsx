import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { reconcile } from "solid-js/store";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import {
  IceServerDiagnostics,
  type IceServerDiagnosticResult,
} from "@/libs/application/ice-server-diagnostics";
import { cn } from "@/libs/cn";
import { textareaAutoResize } from "@/libs/hooks/input-resize";
import { appState } from "@/libs/state/app-state";
import { setClientProfile } from "@/libs/state/profile-store";
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
    <section
      class="settings-section"
      aria-labelledby="connection"
    >
      <h3 id="connection" class="h3">
        {t("setting.connection.title")}
      </h3>
      <div class="flex flex-col gap-2">
        <Switch
          disabled={appState.profile.initalJoin}
          class="flex items-center justify-between"
          checked={appState.profile.autoJoin}
          onChange={(isChecked) =>
            setClientProfile("autoJoin", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.connection.auto_join.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.connection.auto_join.description")}
        </p>
      </div>
      <label class="flex flex-col gap-2">
        <Label>
          {t("setting.connection.stun_servers.title")}
        </Label>
        <Textarea
          class="scrollbar-thin resize-none overflow-x-auto text-nowrap"
          placeholder="stun:stun.l.google.com:19302"
          ref={(ref) => {
            createEffect(() => {
              textareaAutoResize(ref, () =>
                appState.options.servers.stuns.toString(),
              );
            });
          }}
          value={
            appState.options.servers.stuns.join("\n") +
            (appState.options.servers.stuns ? "\n" : "")
          }
          onChange={(ev) => {
            const value = ev.currentTarget.value
              .trim()
              .split("\n")
              .filter((v) => v.trim() !== "");
            setAppOptions("servers", "stuns", value);
          }}
        />
        <p class="muted">
          {t("setting.connection.stun_servers.description")}
        </p>
        <div class="flex gap-2 self-end">
          <Show
            when={
              import.meta.env.VITE_STUN_SERVERS &&
              import.meta.env.VITE_STUN_SERVERS !==
                appState.options.servers.stuns.join(",")
            }
          >
            <Button
              variant="outline"
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
        </div>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t("setting.connection.turn_servers.title")}
        </Label>
        <Textarea
          class="scrollbar-thin resize-none overflow-x-auto text-nowrap"
          ref={(ref) => {
            createEffect(() => {
              textareaAutoResize(
                ref,
                () =>
                  appState.options.servers.turns?.toString() ??
                  "",
              );
            });
          }}
          placeholder={
            "turn:turn1.example.com:3478|user1|pass1|longterm\nturns:turn2.example.com:5349|user2|pass2|hmac\nname|TURN_TOKEN_ID|API_TOKEN|cloudflare"
          }
          value={
            turnServersValue() +
            (turnServersValue() ? "\n" : "")
          }
          onChange={(ev) => {
            try {
              const turns = parseTurnServers(
                ev.currentTarget.value.trim(),
              );
              setAppOptions(
                "servers",
                "turns",
                reconcile(turns),
              );
            } catch (error) {
              toast.error(
                userErrorMessage(
                  error,
                  "errors.ice_config",
                ),
              );
            }
          }}
        />
        <p class="muted">
          {t("setting.connection.turn_servers.description")}
        </p>
        <div class="flex gap-2 self-end">
          <Show
            when={
              import.meta.env.VITE_TURN_SERVERS &&
              import.meta.env.VITE_TURN_SERVERS !==
                turnServersValue().split("\n").join(",")
            }
          >
            <Button
              variant="outline"
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
        </div>
      </label>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.shareServersWithOthers}
          onChange={(isChecked) =>
            setAppOptions(
              "shareServersWithOthers",
              isChecked,
            )
          }
        >
          <SwitchLabel>
            {t(
              "setting.connection.share_servers_with_others.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.connection.share_servers_with_others.description",
          )}
        </p>
      </div>
    </section>
  );
}
