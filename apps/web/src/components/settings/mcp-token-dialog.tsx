import {
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
} from "solid-js";
import type { AutomationRuntime } from "@/libs/state/create-automation";
import type { McpTokenSummary } from "@weblink/platform";
import { Button } from "@/components/ui/button";
import { Copy, RotateCcw } from "lucide-solid";
import { toast } from "solid-sonner";
import { copyText } from "@/libs/utils/copy-text";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingSection } from "./setting-layout";
import {
  SettingInput,
  SettingSelect,
} from "./setting-controls";
import { createSettingsWriter } from "./create-settings-writer";
import { t } from "@/i18n";

const localDateTime = (at: number) => {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

/** Mounted only while the child dialog is open; closing discards the secret. */
export default function McpTokenDialog(props: {
  runtime: AutomationRuntime;
  client?: McpTokenSummary;
  close: () => void;
  onBusy: (busy: boolean) => void;
  onCloseRequest: (
    handler: (() => void) | undefined,
  ) => void;
}) {
  const formId = createUniqueId();
  const initialCustom = props.client?.expiresAt
    ? localDateTime(props.client.expiresAt)
    : "";
  const [label, setLabel] = createSignal(
    props.client?.label ?? "",
  );
  const [duration, setDuration] = createSignal(
    props.client
      ? props.client.expiresAt === null
        ? "permanent"
        : "custom"
      : "30",
  );
  const [custom, setCustom] = createSignal(initialCustom);
  // Relative durations become an absolute deadline once selected, not on every name edit.
  const [deadline, setDeadline] = createSignal(
    Date.now() + 30 * 86400000,
  );
  const [created, setCreated] = createSignal<{
    token: string;
    endpoint: string;
  }>();
  const [creating, setCreating] = createSignal(false);
  const [copying, setCopying] = createSignal(false);
  const [validation, setValidation] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  let dirty = false;
  let revision = 0;
  const writer = createSettingsWriter<{
    label: string;
    expiresAt: number | null;
  }>((value) =>
    props.runtime.updateClient(
      props.client!.id,
      value.label,
      value.expiresAt,
    ),
  );
  createEffect(() =>
    props.onBusy(creating() || writer.saving()),
  );
  const expiresAt = () =>
    duration() === "permanent"
      ? null
      : duration() === "custom"
        ? props.client && custom() === initialCustom
          ? props.client.expiresAt
          : new Date(custom()).getTime()
        : props.client
          ? deadline()
          : Date.now() + Number(duration()) * 86400000;
  const valid = () =>
    label().trim().length > 0 &&
    (expiresAt() === null ||
      (Number.isFinite(expiresAt()) &&
        expiresAt()! > Date.now()));
  const disabled = () =>
    creating() || !props.runtime.ready();
  const edit = () => {
    dirty = true;
    revision++;
    setSaved(false);
    setValidation("");
    writer.clearError();
  };
  const saveEdit = async () => {
    if (!props.client || !dirty) return true;
    if (!valid()) {
      setValidation(t("automation.token_invalid"));
      return false;
    }
    const savedRevision = revision;
    return writer.save(
      { label: label().trim(), expiresAt: expiresAt() },
      () => {
        if (revision === savedRevision) {
          dirty = false;
          setSaved(true);
        }
      },
    );
  };
  const create = async () => {
    if (disabled() || !valid()) return;
    setCreating(true);
    setValidation("");
    try {
      setCreated(
        await props.runtime.client(
          label().trim(),
          expiresAt(),
        ),
      );
    } catch (error) {
      setValidation(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setCreating(false);
    }
  };
  const close = async () => {
    if (creating()) return;
    if (
      props.client &&
      (!(await saveEdit()) || !(await writer.flush()))
    )
      return;
    props.close();
  };
  props.onCloseRequest(() => {
    void close();
  });
  onCleanup(() => props.onCloseRequest(undefined));
  const error = () => validation() || writer.error();
  const endpoint = () =>
    props.runtime.snapshot().endpoint ||
    created()?.endpoint;
  const configuration = () => {
    const client = created();
    return client
      ? JSON.stringify(
          {
            url: endpoint() || undefined,
            headers: {
              Authorization: client.token,
            },
          },
          null,
          2,
        )
      : "";
  };
  const copy = async () => {
    if (!created() || copying()) return;
    setCopying(true);
    try {
      if (await copyText(configuration()))
        toast.success(
          t("common.notification.copy_success"),
        );
      else
        toast.error(t("common.notification.copy_failed"));
    } finally {
      setCopying(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {created()
            ? t("automation.token_created")
            : props.client
              ? t("automation.edit_token")
              : t("automation.create_client")}
        </DialogTitle>
        <DialogDescription>
          {created()
            ? t("automation.token_once")
            : props.client
              ? t("automation.settings_auto_description")
              : t("automation.credentials_description")}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Show
          when={created()}
          fallback={
            <form
              id={formId}
              onSubmit={(e) => {
                e.preventDefault();
                void (props.client ? saveEdit() : create());
              }}
            >
              <SettingSection>
                <SettingInput
                  label={t("automation.client_name")}
                  maxlength={128}
                  disabled={disabled()}
                  value={label()}
                  onInput={(e) => {
                    setLabel(e.currentTarget.value);
                    edit();
                  }}
                  onBlur={() => {
                    void saveEdit();
                  }}
                />
                <SettingSelect<string>
                  modal
                  disallowEmptySelection
                  label={t("automation.token_lifetime")}
                  disabled={disabled()}
                  value={duration()}
                  options={[
                    "1",
                    "7",
                    "30",
                    "90",
                    "custom",
                    "permanent",
                  ]}
                  onChange={(value) => {
                    if (!value || value === duration())
                      return;
                    setDuration(value);
                    if (
                      value !== "custom" &&
                      value !== "permanent"
                    )
                      setDeadline(
                        Date.now() +
                          Number(value) * 86400000,
                      );
                    edit();
                    if (value !== "custom" || valid())
                      void saveEdit();
                  }}
                  optionLabel={(value) =>
                    value === "custom"
                      ? t("automation.custom_expiry")
                      : value === "permanent"
                        ? t("automation.permanent")
                        : `${value} ${t("automation.days")}`
                  }
                />
                <Show when={duration() === "custom"}>
                  <SettingInput
                    label={t("automation.expires_at")}
                    type="datetime-local"
                    class="block min-w-0"
                    disabled={disabled()}
                    value={custom()}
                    onInput={(e) => {
                      setCustom(e.currentTarget.value);
                      edit();
                    }}
                    onBlur={() => {
                      void saveEdit();
                    }}
                  />
                </Show>
                <Show when={duration() !== "30"}>
                  <div class="setting-actions">
                    <Button
                      type="button"
                      size="sm"
                      wrap
                      variant="outline"
                      disabled={disabled()}
                      onClick={() => {
                        setDuration("30");
                        setDeadline(
                          Date.now() + 30 * 86400000,
                        );
                        edit();
                        void saveEdit();
                      }}
                    >
                      <RotateCcw class="size-4" />
                      {t("automation.token_reset")}
                    </Button>
                  </div>
                </Show>
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
              </SettingSection>
            </form>
          }
        >
          <Show when={!endpoint()}>
            <p
              role="status"
              class="text-muted-foreground mb-2 text-sm"
            >
              {t("automation.token_endpoint_pending")}
            </p>
          </Show>
          <pre
            class="bg-muted max-h-64 select-all overflow-auto
              whitespace-pre-wrap break-all rounded-md p-3 text-xs"
          >
            {configuration()}
          </pre>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={creating()}
          onClick={() => void close()}
        >
          {t(
            created()
              ? "automation.hide"
              : props.client
                ? "common.action.close"
                : "common.action.cancel",
          )}
        </Button>
        <Show when={created()}>
          <Button
            type="button"
            disabled={copying()}
            onClick={() => void copy()}
          >
            <Copy class="size-4" />
            {t("common.action.copy")}
          </Button>
        </Show>
        <Show when={!created() && !props.client}>
          <Button
            type="submit"
            form={formId}
            disabled={disabled() || !valid()}
          >
            {t("automation.create_client")}
          </Button>
        </Show>
      </DialogFooter>
    </>
  );
}
