import { setClientProfile } from "@/libs/core/store";
import { createDialog } from "./dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { optional } from "@/libs/core/utils/optional";
import { useAppState } from "@/libs/state/app-state-context";
import {
  ComponentProps,
  createMemo,
  Show,
  splitProps,
} from "solid-js";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  IconCasino,
  IconLogin,
  IconLogout,
} from "@/components/icons";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { getDefaultAppOptions } from "@/options";
import { getInitials } from "@/libs/utils/name";
import { generateStrongPassword } from "@/libs/core/utils/encrypt/strong-password";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/common/spinner";
import { appState } from "@/libs/state/app-state";

export const createRoomDialog = () => {
  const { open, close, submit } = createDialog({
    title: () => t("common.join_form.title"),
    description: () => t("common.join_form.description"),
    content: () => (
      <>
        <form
          id="join-room"
          class="grid gap-4 p-1"
          onSubmit={(ev) => {
            ev.preventDefault();
            setClientProfile("initalJoin", false);
            submit(appState.profile);
          }}
        >
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.client_id.title")}
            </span>

            <Input
              required
              readonly
              value={appState.profile.clientId}
              readOnly={true}
            />

            <p class="muted">
              {t("common.join_form.client_id.description")}
            </p>
          </label>
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.room_id.title")}
            </span>
            <Input
              required
              value={appState.profile.roomId}
              onInput={(ev) =>
                setClientProfile(
                  "roomId",
                  ev.currentTarget.value,
                )
              }
            />
          </label>
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.password.title")}
            </span>
            <div class="flex gap-1">
              <Input
                placeholder={t(
                  "common.join_form.password.placeholder",
                )}
                value={appState.profile.password ?? ""}
                onInput={(ev) =>
                  setClientProfile(
                    "password",
                    optional(ev.currentTarget.value),
                  )
                }
              />
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  const password =
                    await generateStrongPassword();
                  setClientProfile("password", password);
                }}
              >
                <IconCasino class="size-6" />
              </Button>
            </div>
            <p class="muted">
              {t("common.join_form.password.description")}
            </p>
          </label>
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.name")}
            </span>
            <Input
              required
              value={appState.profile.name}
              onInput={(ev) =>
                setClientProfile(
                  "name",
                  ev.currentTarget.value,
                )
              }
            />
          </label>
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.avatar_url")}
            </span>
            <Input
              placeholder="Enter a link or upload an image"
              type="url"
              value={appState.profile.avatar ?? ""}
              onInput={(ev) =>
                setClientProfile(
                  "avatar",
                  optional(ev.currentTarget.value),
                )
              }
            />
            <div class="flex items-center gap-2">
              <Input
                type="file"
                multiple={false}
                accept="image/*"
                onChange={async (ev) => {
                  const file =
                    ev.currentTarget.files?.item(0);
                  if (!file) return;

                  const url =
                    await imageFileToFilledSquareAvatar(
                      file,
                      128,
                    );
                  setClientProfile("avatar", url);
                }}
              />
              <Avatar>
                <AvatarImage
                  src={appState.profile.avatar ?? undefined}
                />
                <AvatarFallback>
                  {getInitials(appState.profile.name)}
                </AvatarFallback>
              </Avatar>
            </div>
          </label>
          <Switch
            class="flex items-center justify-between"
            checked={appState.profile.autoJoin}
            onChange={(isChecked) =>
              setClientProfile("autoJoin", isChecked)
            }
          >
            <SwitchLabel>
              {t("common.join_form.auto_join")}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </form>
      </>
    ),
    confirm: (
      <Button type="submit" form="join-room">
        {t("common.action.confirm")}
      </Button>
    ),
    cancel: (
      <Button variant="destructive" onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
  });
  return { open };
};

export const joinUrl = createMemo(() => {
  const url = new URL(location.origin);
  url.searchParams.append("id", appState.profile.roomId);
  if (appState.profile.password)
    url.searchParams.append(
      "pwd",
      appState.profile.password,
    );

  if (appState.options.shareServersWithOthers) {
    // compare if user's appOptions is different from defaultAppOptions
    const defaultAppOptions = getDefaultAppOptions();
    if (
      appState.options.servers.stuns.length !==
        defaultAppOptions.servers.stuns.length &&
      appState.options.servers.stuns.some(
        (server, index) =>
          server !== defaultAppOptions.servers.stuns[index],
      )
    ) {
      url.searchParams.append(
        "stun",
        JSON.stringify(appState.options.servers.stuns),
      );
    }
    if (
      appState.options.servers.turns.length !==
        defaultAppOptions.servers.turns.length &&
      appState.options.servers.turns.some(
        (server, index) =>
          server.url !==
          defaultAppOptions.servers.turns[index].url,
      )
    ) {
      url.searchParams.append(
        "turn",
        JSON.stringify(appState.options.servers.turns),
      );
    }
  }
  url.searchParams.append("join", "true");
  return url.toString();
});

// const createRoomStatus = () => {
//   const { joinRoom, roomStatus, leaveRoom } = useAppState();
//   const [joinStatus, setJoinStatus] = createSignal<
//     "connecting" | "connected" | "disconnected"
//   >("disconnected");
// };

export function JoinRoomButton(
  props: ComponentProps<"button">,
) {
  const { joinRoom, leaveRoom } = useAppState();
  const { open } = createRoomDialog();
  const [local, other] = splitProps(props, ["class"]);
  return (
    <Show
      when={
        appState.session.clientServiceStatus ===
        "disconnected"
      }
      fallback={
        <Tooltip>
          <TooltipTrigger
            as={Button}
            class={local.class}
            disabled={
              appState.session.clientServiceStatus !==
              "connected"
            }
            onClick={() => leaveRoom()}
            variant="outline"
            size="icon"
          >
            <Show
              when={
                appState.session.clientServiceStatus ===
                "connecting"
              }
              fallback={<IconLogout class="size-6" />}
            >
              <Spinner />
            </Show>
          </TooltipTrigger>
          <TooltipContent>
            {t("common.nav.leave_room")}
          </TooltipContent>
        </Tooltip>
      }
    >
      <Tooltip>
        <TooltipTrigger
          as={Button}
          class={local.class}
          size="icon"
          disabled={
            appState.session.clientServiceStatus !==
            "disconnected"
          }
          onClick={async () => {
            const result = await open();
            if (result.cancel) return;

            await joinRoom().catch((err) => {
              console.error(err);
              toast.error(err.message);
            });
          }}
          {...props}
        >
          <IconLogin class="size-6" />
        </TooltipTrigger>
        <TooltipContent>
          {t("common.nav.join_room")}
        </TooltipContent>
      </Tooltip>
    </Show>
  );
}

/**
 * Convert the image file to a dataURL that fills the entire square avatar
 * @param file - The image file uploaded by the user
 * @param size - The target avatar size (square size)
 * @returns Promise<string> Returns the dataURL of the cropped and filled image
 */
function imageFileToFilledSquareAvatar(
  file: File,
  size: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      return reject(
        new Error("Please upload a valid image file"),
      );
    }

    const reader = new FileReader();

    reader.onload = (event: ProgressEvent<FileReader>) => {
      const img = new Image();
      img.src = event.target?.result as string;

      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return reject(
            new Error("Failed to get Canvas context"),
          );
        }

        canvas.width = size;
        canvas.height = size;

        const imgAspectRatio = img.width / img.height;
        const canvasAspectRatio = 1;
        let sx = 0,
          sy = 0,
          sWidth = img.width,
          sHeight = img.height;

        if (imgAspectRatio > canvasAspectRatio) {
          sWidth = img.height * canvasAspectRatio;
          sx = (img.width - sWidth) / 2;
        } else {
          sHeight = img.width / canvasAspectRatio;
          sy = (img.height - sHeight) / 2;
        }

        ctx.drawImage(
          img,
          sx,
          sy,
          sWidth,
          sHeight,
          0,
          0,
          size,
          size,
        );

        const dataURL = canvas.toDataURL("image/png");
        resolve(dataURL);
      };

      img.onerror = () => {
        reject(new Error("Failed to load image"));
      };
    };

    reader.onerror = () => {
      reject(new Error("Failed to read image file"));
    };

    reader.readAsDataURL(file);
  });
}
