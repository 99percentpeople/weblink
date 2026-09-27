import { createSignal, Show } from "solid-js";
import {
  Copy,
  Download,
  Link,
  LoaderCircle,
  QrCode,
} from "lucide-solid";
import { joinUrl } from "@/components/dialogs/join-dialog";
import { toast } from "solid-sonner";
import { createDialog } from "./dialog";
import {
  QRCode,
  downloadQRCode,
} from "@/components/common/qrcode";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { appState } from "@/libs/state/app-state";
import { getInitials } from "@/libs/utils/name";

export const createQRCodeDialog = () => {
  const [copying, setCopying] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const available = () => !!appState.profile.roomId.trim();
  const copyLink = async () => {
    if (copying() || !available()) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast.success(
        t("common.notification.link_copy_success"),
      );
    } catch {
      toast.error(
        t("common.notification.link_copy_failed"),
      );
    } finally {
      setCopying(false);
    }
  };
  const saveCode = async () => {
    if (saving() || !available()) return;
    setSaving(true);
    try {
      await downloadQRCode(joinUrl(), "weblink-room.svg");
    } catch {
      toast.error(
        t("common.scan_qrcode_dialog.save_failed"),
      );
    } finally {
      setSaving(false);
    }
  };
  const { open } = createDialog({
    class:
      "sm:max-w-sm [&_[data-slot=dialog-footer]:empty]:hidden",
    title: () => t("app_menu.room_qrcode"),
    description: () =>
      t("common.scan_qrcode_dialog.description"),
    content: () => (
      <div class="flex min-w-0 flex-col gap-4">
        <div class="flex min-w-0 flex-col items-center gap-3">
          <div class="w-full min-w-0 space-y-1 text-center">
            <p class="text-muted-foreground text-xs">
              {t("common.join_form.room_id.title")}
            </p>
            <p class="text-lg font-semibold [overflow-wrap:anywhere] select-text">
              {appState.profile.roomId || "—"}
            </p>
          </div>
          <div
            class="aspect-square w-full max-w-64 overflow-hidden rounded-2xl
              border bg-white shadow-sm"
            onContextMenu={(event) => {
              event.preventDefault();
              void copyLink();
            }}
          >
            <Show
              when={available()}
              fallback={
                <div
                  class="flex h-full flex-col items-center justify-center gap-3 px-4
                    text-center text-sm text-neutral-500"
                >
                  <QrCode class="size-12 opacity-50" />
                  <p>
                    {t("common.scan_qrcode_dialog.no_room")}
                  </p>
                </div>
              }
            >
              <Show when={joinUrl()} keyed>
                {(url) => (
                  <QRCode
                    value={url}
                    width={280}
                    dark="#000000"
                    light="#ffffff"
                    class="block aspect-square h-auto w-full"
                    role="img"
                    aria-label={t("app_menu.room_qrcode")}
                  />
                )}
              </Show>
            </Show>
          </div>
          <div
            class="text-muted-foreground flex max-w-full items-center gap-2
              text-xs"
          >
            <Avatar class="size-6">
              <AvatarImage
                src={appState.profile.avatar ?? undefined}
              />
              <AvatarFallback
                seed={appState.profile.name}
                class="text-[10px]"
              >
                {getInitials(appState.profile.name)}
              </AvatarFallback>
            </Avatar>
            <span
              class="min-w-0 truncate"
              title={appState.profile.name}
            >
              {t("common.scan_qrcode_dialog.shared_by", {
                name: appState.profile.name,
              })}
            </span>
          </div>
        </div>
        <label class="flex min-w-0 flex-col gap-2">
          <span class="text-muted-foreground text-xs font-medium">
            {t("common.scan_qrcode_dialog.link")}
          </span>
          <div class="relative min-w-0">
            <Link
              class="text-muted-foreground pointer-events-none absolute top-1/2
                left-3 size-4 -translate-y-1/2"
            />
            <Input
              class="h-9 min-w-0 pl-9 text-xs"
              type="url"
              readOnly
              value={available() ? joinUrl() : ""}
              onClick={(event) =>
                event.currentTarget.select()
              }
            />
          </div>
        </label>
        <div class="grid gap-2 sm:grid-cols-2">
          <Button
            disabled={copying() || !available()}
            onClick={() => void copyLink()}
          >
            <Show
              when={copying()}
              fallback={<Copy class="size-4" />}
            >
              <LoaderCircle class="size-4 animate-spin" />
            </Show>
            {t("common.action.copy_link")}
          </Button>
          <Button
            variant="outline"
            disabled={saving() || !available()}
            onClick={() => void saveCode()}
          >
            <Show
              when={saving()}
              fallback={<Download class="size-4" />}
            >
              <LoaderCircle class="size-4 animate-spin" />
            </Show>
            {t("common.scan_qrcode_dialog.save")}
          </Button>
        </div>
      </div>
    ),
  });
  return { open };
};
