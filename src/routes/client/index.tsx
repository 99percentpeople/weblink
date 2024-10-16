import {
  Component,
  createEffect,
  createMemo,
  Show,
} from "solid-js";
import QRCode from "qrcode";
import { useColorMode } from "@kobalte/core";
import { clientProfile } from "@/libs/core/store";
import { useWebRTC } from "@/libs/core/rtc-context";
import { Button } from "@/components/ui/button";
import { CopyToClipboard } from "@/components/copy-to-clipboard";
import { t } from "@/i18n";
const Client: Component = (props) => {
  const { colorMode } = useColorMode();
  const { roomStatus } = useWebRTC();

  const url = createMemo(() => {
    const url = new URL(location.origin);
    url.searchParams.append("id", clientProfile.roomId);
    if (clientProfile.password)
      url.searchParams.append(
        "pwd",
        clientProfile.password,
      );
    url.searchParams.append("join", "true");
    return url.toString();
  });
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
          <canvas
            class="hover:cursor-pointer"
            onClick={async (ev) => {
              const svg = await QRCode.toString(url());
              const blob = new Blob([svg], {
                type: "image/svg+xml",
              });

              const dataurl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = dataurl;
              a.download = "qr-code.svg";
              a.click();
            }}
            ref={(ref) => {
              createEffect(() => {
                QRCode.toCanvas(ref, url(), {
                  width: 200,
                  color: {
                    dark:
                      colorMode() === "dark"
                        ? "#71717a"
                        : "#000000",
                    light: "#00000000",
                  },
                });
              });
            }}
          />
          <p class="flex items-center gap-2">
            <CopyToClipboard>
              <a class="select-all hover:underline">
                {url()}
              </a>
            </CopyToClipboard>
          </p>
          <p class="muted">
            {t("chat.index.description")}
          </p>
        </div>
      </Show>
    </div>
  );
};

export default Client;
