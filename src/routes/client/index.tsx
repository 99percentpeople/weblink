import {
  Component,
  createEffect,
  createMemo,
  Show,
} from "solid-js";
import {
  downloadQRCode,
  QRCode,
} from "@/components/qrcode";
import { useColorMode } from "@kobalte/core";
import { clientProfile } from "@/libs/core/store";
import { useWebRTC } from "@/libs/core/rtc-context";
import { Button } from "@/components/ui/button";
import { CopyToClipboard } from "@/components/copy-to-clipboard";
import { t } from "@/i18n";
import { joinUrl } from "@/components/join-dialog";

const Client: Component = (props) => {
  const { colorMode } = useColorMode();
  const { roomStatus } = useWebRTC();

  return (
    <div class="relative h-full w-full">
      <Show
        when={roomStatus.roomId}
        fallback={
          <div
            class="absolute left-1/2 top-1/2 flex -translate-x-1/2
              -translate-y-1/2 flex-col items-center"
          ></div>
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
              colorMode() === "dark" ? "#71717a" : "#000000"
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
          <p class="muted">{t("chat.index.description")}</p>
        </div>
      </Show>
    </div>
  );
};

export default Client;
