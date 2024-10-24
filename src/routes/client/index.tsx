import { Component, Match, Show, Switch } from "solid-js";
import {
  downloadQRCode,
  QRCode,
} from "@/components/qrcode";
import { useColorMode } from "@kobalte/core";
import { CopyToClipboard } from "@/components/copy-to-clipboard";
import { t } from "@/i18n";
import { joinUrl } from "@/components/join-dialog";
import { sessionService } from "@/libs/services/session-service";
import { Input } from "@/components/ui/input";
import { toast } from "solid-sonner";

const Client: Component = (props) => {
  const { colorMode } = useColorMode();

  return (
    <div class="relative h-full w-full">
      <Switch>
        <Match
          when={
            sessionService.clientServiceStatus() ===
            "connected"
          }
        >
          <div
            class="absolute left-1/2 top-1/2 flex -translate-x-1/2
              -translate-y-1/2 flex-col items-center gap-2 rounded-lg
              bg-background/50 p-4 shadow-inner backdrop-blur"
          >
            <QRCode
              value={joinUrl()}
              width={200}
              dark={
                colorMode() === "dark"
                  ? "#cbd5e1"
                  : "#000000"
              }
              light="#00000000"
              onContextMenu={(e) => {
                e.preventDefault();
                downloadQRCode(joinUrl(), "qr-code.svg");
              }}
            />

            <p class="flex w-full items-center gap-2">
              <Input
                class="h-8 w-full select-all whitespace-pre-wrap break-all
                  text-center text-xs hover:underline"
                onContextMenu={async (e) => {
                  e.preventDefault();
                  await navigator.clipboard.writeText(
                    joinUrl(),
                  );
                  toast.success(
                    t("chat.index.copy_success"),
                  );
                }}
                value={joinUrl()}
              />
            </p>
            <p class="text-sm">
              {t("chat.index.description")}
            </p>
          </div>
        </Match>
        <Match
          when={
            sessionService.clientServiceStatus() ===
            "disconnected"
          }
        >
          <div
            class="absolute left-1/2 top-1/2 flex -translate-x-1/2
              -translate-y-1/2 flex-col items-center text-center"
          >
            <div class="flex flex-col items-center gap-2">
              <p class="large">
                {t("chat.index.guide_title")}
              </p>
              <p class="text-sm">
                {t("chat.index.guide_description")}
              </p>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
};

export default Client;
