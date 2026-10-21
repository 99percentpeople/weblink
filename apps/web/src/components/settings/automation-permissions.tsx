import { For, Show, createSignal } from "solid-js";
import {
  permissionGroup,
  type Principal,
} from "@weblink/automation";
import {
  groupDescription,
  scopeLabel,
} from "@/libs/i18n/automation";
import type { AutomationRuntime } from "@/libs/state/create-automation";
import {
  SettingHeading,
  SettingBlock,
  SettingRow,
} from "./setting-layout";
import { SettingSelect } from "./setting-controls";
import { Button } from "@/components/ui/button";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import { t } from "@/i18n";
const Empty = (props: { message: string }) => (
  <SettingBlock>
    <p class="text-muted-foreground text-sm">
      {props.message}
    </p>
  </SettingBlock>
);
export default function AutomationPermissions(props: {
  runtime: AutomationRuntime;
  peerId: string;
}) {
  const accepts = (principal: Principal) =>
    principal.kind === "peer" &&
    props.runtime.principalPeerId(principal.id) ===
      props.peerId;
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
  return (
    <>
      <Show when={error()}>
        <p role="alert" class="text-destructive text-sm">
          {error()}
        </p>
      </Show>
      <Show when={props.runtime.desktop}>
        <SettingHeading>
          {t("automation.requests")}
        </SettingHeading>
        <For
          each={props.runtime
            .snapshot()
            .pending.filter((request) =>
              accepts(request.principal),
            )}
          fallback={
            <Empty message={t("automation.no_requests")} />
          }
        >
          {(request) => {
            const [minutes, setMinutes] = createSignal(15);
            const [verified, setVerified] =
              createSignal(false);
            return (
              <div class="setting-group">
                <SettingRow
                  label={request.principal.label}
                  description={
                    <>
                      {scopeLabel(request.scope)} ·{" "}
                      <code>{request.tool}</code> ·{" "}
                      {t("automation.target")}:{" "}
                      {String(request.arguments.target)}
                    </>
                  }
                >
                  <span class="text-muted-foreground text-sm">
                    {t("automation.peer")}
                  </span>
                </SettingRow>
                <SettingBlock>
                  <div class="grid gap-3">
                    <Show when={request.source}>
                      <p class="text-sm">
                        {t("automation.reported_source")}:{" "}
                        {request.source?.kind} ·{" "}
                        {request.source?.label}
                      </p>
                    </Show>
                    <Show
                      when={request.principal.fingerprint}
                    >
                      <p>
                        {t("automation.compare")}:{" "}
                        <code>
                          {request.principal.fingerprint
                            ?.slice(0, 12)
                            .match(/.{1,4}/g)
                            ?.join("-")}
                        </code>
                      </p>
                      <Checkbox
                        checked={verified()}
                        disabled={busy()}
                        onChange={setVerified}
                        class="flex items-center gap-2"
                      >
                        <CheckboxControl />
                        <CheckboxLabel class="text-sm">
                          {t("automation.verified")}
                        </CheckboxLabel>
                      </Checkbox>
                    </Show>
                    <p class="text-muted-foreground text-sm">
                      {groupDescription(
                        permissionGroup(request.scope),
                      )}
                    </p>
                    <details>
                      <summary class="cursor-pointer text-sm">
                        {t("automation.arguments")}
                      </summary>
                      <pre
                        class="bg-muted mt-2 max-h-48 overflow-auto whitespace-pre-wrap
                          break-all rounded-md p-3 text-xs"
                      >
                        {JSON.stringify(
                          request.arguments,
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                </SettingBlock>
                <SettingSelect<number>
                  modal
                  disallowEmptySelection
                  label={t("automation.duration")}
                  options={[5, 15, 60]}
                  value={minutes()}
                  disabled={busy()}
                  onChange={(value) =>
                    value && setMinutes(value)
                  }
                  optionLabel={(n) =>
                    `${n} ${t("automation.minutes")}`
                  }
                />
                <SettingBlock>
                  <div class="setting-actions">
                    <Button
                      size="sm"
                      wrap
                      disabled={
                        busy() ||
                        (!!request.principal.fingerprint &&
                          !verified())
                      }
                      onClick={() =>
                        void run(() =>
                          props.runtime.decide(
                            request.id,
                            minutes(),
                          ),
                        )
                      }
                    >
                      {t("automation.allow")}
                    </Button>
                    <Button
                      size="sm"
                      wrap
                      variant="outline"
                      disabled={busy()}
                      onClick={() =>
                        void run(() =>
                          props.runtime.decide(
                            request.id,
                            0,
                          ),
                        )
                      }
                    >
                      {t("automation.deny")}
                    </Button>
                  </div>
                </SettingBlock>
              </div>
            );
          }}
        </For>
        <SettingHeading>
          {t("automation.grants")}
        </SettingHeading>
        <For
          each={props.runtime
            .snapshot()
            .grants.filter((grant) =>
              accepts(grant.principal),
            )}
          fallback={
            <Empty message={t("automation.no_grants")} />
          }
        >
          {(grant) => (
            <SettingRow
              label={grant.principal.label}
              description={
                <>
                  {[
                    ...new Set(
                      grant.scopes.map(scopeLabel),
                    ),
                  ].join(", ")}{" "}
                  · {t("automation.target")}: {grant.target}{" "}
                  ·{" "}
                  {grant.expiresAt === null
                    ? t(
                        "setting.permissions.allow_permanently",
                      )
                    : new Date(
                        grant.expiresAt,
                      ).toLocaleTimeString()}
                </>
              }
            >
              <div class="flex justify-end">
                <Button
                  size="sm"
                  wrap
                  variant="outline"
                  disabled={busy()}
                  onClick={() =>
                    void run(() =>
                      props.runtime.revoke(grant.id),
                    )
                  }
                >
                  {t("automation.revoke")}
                </Button>
              </div>
            </SettingRow>
          )}
        </For>
      </Show>
    </>
  );
}
