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
              -translate-y-1/2 flex-col items-center gap-2 text-nowrap
              text-muted-foreground"
          >
            <QRCode
              value={joinUrl()}
              width={200}
              dark={
                colorMode() === "dark"
                  ? "#71717a"
                  : "#000000"
              }
              light="#00000000"
              onClick={() => {
                downloadQRCode(joinUrl(), "qr-code.svg");
              }}
            />

            <p class="flex items-center gap-2">
              <CopyToClipboard>
                <a class="select-all hover:underline">
                  {joinUrl()}
                </a>
              </CopyToClipboard>
            </p>
            <p class="muted">
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
              <p class="muted">
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
