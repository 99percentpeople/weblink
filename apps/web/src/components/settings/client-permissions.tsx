import ClientAutomationPermissions from "./client-automation-permissions";
import { Show, createEffect, createSignal } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { sessionService } from "@/libs/application/session-service";
import { setClientConfig } from "@/options";
import { PermissionSelect } from "./permission-select";
import {
  SettingGroup,
  SettingSection,
} from "./setting-layout";
import { Button } from "@/components/ui/button";
export function ClientPermissions(props: {
  clientId: string;
}) {
  type Decision = "ask" | "allow" | "deny";
  const config = () =>
    appState.options.clientConfigs[props.clientId];
  const trust = () =>
    sessionService?.trust.get(props.clientId);
  const trusted = () => trust()?.state === "trusted";
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => {
    trust()?.code;
    props.clientId;
    setConfirmed(false);
    setError("");
  });
  return (
    <SettingSection>
      <SettingGroup
        title={t("setting.permissions.groups.identity")}
      >
        <div class="space-y-2 text-sm">
          <p
            role="status"
            class={
              trusted()
                ? "text-sm"
                : "text-destructive text-sm"
            }
          >
            {t(
              `device_trust.${trust()?.state ?? "offline"}`,
            )}
          </p>
          <Show when={trust()?.code}>
            <p>
              {t("device_trust.pairing_code")}:{" "}
              <code>
                {trust()
                  ?.code?.match(/.{1,4}/g)
                  ?.join("-")}
              </code>
            </p>
          </Show>
          <Show when={!trusted()}>
            <p class="text-muted-foreground text-sm">
              {t("device_trust.blocked_description")}
            </p>
            <Show when={trust()?.code}>
              <label class="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmed()}
                  onChange={(e) =>
                    setConfirmed(e.currentTarget.checked)
                  }
                />
                {t("device_trust.confirm_code")}
              </label>
              <div class="setting-actions">
                <Button
                  disabled={!confirmed() || busy()}
                  onClick={async () => {
                    const proof = trust();
                    if (
                      !proof?.fingerprint ||
                      !proof.code ||
                      !confirmed()
                    )
                      return;
                    setBusy(true);
                    setError("");
                    try {
                      await sessionService.trust.pair(
                        props.clientId,
                        proof.fingerprint,
                        proof.code,
                      );
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("device_trust.repair")}
                </Button>
              </div>
            </Show>
            <Show when={!trust()?.code}>
              <p class="text-muted-foreground text-sm">
                {t("device_trust.proof_required")}
              </p>
            </Show>
          </Show>
          <Show when={error()}>
            <p role="alert" class="text-destructive">
              {error()}
            </p>
          </Show>
        </div>
      </SettingGroup>
      <SettingGroup
        title={t("setting.permissions.groups.content")}
      >
        <PermissionSelect<"allowed" | "disallowed">
          label={t("device_trust.receive_content")}
          description={t(
            "device_trust.receive_description",
          )}
          disabled={!trusted()}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.receiveContent === true
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                receiveContent: decision === "allowed",
              });
          }}
        />
        <PermissionSelect<"allowed" | "disallowed">
          disabled={!trusted()}
          label={t("client.config.provide_file_list.title")}
          description={t(
            "client.config.provide_file_list.description",
          )}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.provideFileList !== false
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                provideFileList: decision === "allowed",
              });
          }}
        />
      </SettingGroup>
      <SettingGroup
        title={t("setting.permissions.groups.sharing")}
      >
        <PermissionSelect<"allowed" | "disallowed">
          label={t("device_trust.share_screen")}
          description={t("device_trust.share_description")}
          disabled={!trusted()}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.shareScreen === true
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                shareScreen: decision === "allowed",
              });
          }}
        />
        <PermissionSelect<Decision>
          disabled={!trusted()}
          label={t("app_menu.settings_remote_control")}
          options={["ask", "allow", "deny"]}
          value={
            trusted()
              ? (config()?.remoteControl ?? "ask")
              : "deny"
          }
          optionLabel={(decision) =>
            decision === "allow"
              ? t("setting.permissions.allow_permanently")
              : t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                remoteControl:
                  decision === "ask" ? undefined : decision,
              });
          }}
        />
      </SettingGroup>
      <ClientAutomationPermissions
        clientId={props.clientId}
        trusted={trusted()}
      />
    </SettingSection>
  );
}
