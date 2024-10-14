import {
  clientProfile,
  getDefaultProfile,
  setClientProfile,
} from "@/libs/core/store";
import { createDialog } from "./dialogs/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { v4 } from "uuid";
import { optional } from "@/libs/core/utils/optional";
import { useWebRTC } from "@/libs/core/rtc-context";
import { onMount, Show } from "solid-js";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "./ui/avatar";
import { getInitials } from "./chat/userlist";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "./ui/switch";
import { IconCasino, IconLogin, IconLogout } from "./icons";

export const createRoomDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: "Edit profile",
    description:
      "Make changes to your profile here. Click submit when you're done.",
    content: (props) => (
      <>
        <div class="h-0"></div>
        <form
          id="join-room"
          class="grid gap-4 py-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            setClientProfile("firstTime", false);
            props.submit(clientProfile);
          }}
        >
          <label class="flex flex-col gap-2">
            <span>Client ID</span>
            <div class="col-span-2 flex gap-1 md:col-span-3">
              <Input
                required
                value={clientProfile.clientId}
                readOnly={true}
                class="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  setClientProfile(getDefaultProfile());
                }}
              >
                <IconCasino />
              </Button>
            </div>
          </label>
          <label class="flex flex-col gap-2">
            <span>Room ID</span>
            <Input
              required
              value={clientProfile.roomId}
              onInput={(ev) =>
                setClientProfile(
                  "roomId",
                  ev.currentTarget.value,
                )
              }
              class="col-span-2 md:col-span-3"
            />
          </label>
          <label class="flex flex-col gap-2">
            <span>Name</span>
            <Input
              required
              value={clientProfile.name}
              onInput={(ev) =>
                setClientProfile(
                  "name",
                  ev.currentTarget.value,
                )
              }
              class="col-span-2 md:col-span-3"
            />
          </label>
          <label class="flex flex-col gap-2">
            <span>Avatar Url</span>
            <Input
              placeholder="Enter a link or upload an image"
              type="url"
              value={clientProfile.avatar ?? ""}
              onInput={(ev) =>
                setClientProfile(
                  "avatar",
                  optional(ev.currentTarget.value),
                )
              }
              class="col-span-2 md:col-span-3"
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
                  src={clientProfile.avatar ?? undefined}
                />
                <AvatarFallback>
                  {getInitials(clientProfile.name)}
                </AvatarFallback>
              </Avatar>
            </div>
          </label>
          <label class="flex flex-col gap-2">
            <span>Password</span>
            <Input
              value={clientProfile.password ?? ""}
              onInput={(ev) =>
                setClientProfile(
                  "password",
                  optional(ev.currentTarget.value),
                )
              }
              class="col-span-2 md:col-span-3"
            />
          </label>
          <Switch
            class="flex items-center justify-between"
            checked={clientProfile.autoJoin}
            onChange={(isChecked) =>
              setClientProfile("autoJoin", isChecked)
            }
          >
            <SwitchLabel>Auto join</SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </form>
      </>
    ),
    confirm: (
      <Button type="submit" form="join-room">
        Confirm
      </Button>
    ),
    cancel: (
      <Button variant="destructive" onClick={() => close()}>
        Cancel
      </Button>
    ),
  });
  return { open, Component };
};

export default function JoinRoom() {
  const { joinRoom, roomStatus, leaveRoom } = useWebRTC();
  const { open, Component } = createRoomDialog();
  onMount(async () => {
    if (!roomStatus.roomId) {
      if (clientProfile.autoJoin) {
        await joinRoom();
      }
    }
  });
  return (
    <>
      <Component />
      <Show
        when={!roomStatus.roomId}
        fallback={
          <Button
            onClick={() => leaveRoom()}
            variant="destructive"
            size="icon"
          >
            <IconLogout />
          </Button>
        }
      >
        <Button
          size="icon"
          onClick={async () => {
            // if (clientProfile.firstTime) {
            const result = await open();
            if (result.cancel) return;
            // }

            joinRoom();
          }}
          disabled={!!roomStatus.roomId}
        >
          <IconLogin />
        </Button>
      </Show>
    </>
  );
}

/**
 * 将图片文件转换为填充整个正方形头像的 dataURL
 * @param file - 用户上传的图片文件
 * @param size - 目标头像尺寸（正方形大小）
 * @returns Promise<string> 返回裁剪并填充后的图片的 dataURL
 */
function imageFileToFilledSquareAvatar(
  file: File,
  size: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      return reject(new Error("请上传一个有效的图片文件"));
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
            new Error("无法获取 Canvas 上下文"),
          );
        }

        // 设置目标尺寸为正方形
        canvas.width = size;
        canvas.height = size;

        // 计算缩放比例，以保证图片能完全覆盖整个正方形区域
        const imgAspectRatio = img.width / img.height;
        const canvasAspectRatio = 1; // 因为 canvas 是正方形
        let sx = 0,
          sy = 0,
          sWidth = img.width,
          sHeight = img.height;

        if (imgAspectRatio > canvasAspectRatio) {
          // 图片宽比高长，以高度为基准裁剪
          sWidth = img.height * canvasAspectRatio;
          sx = (img.width - sWidth) / 2; // 水平居中裁剪
        } else {
          // 图片高比宽长，以宽度为基准裁剪
          sHeight = img.width / canvasAspectRatio;
          sy = (img.height - sHeight) / 2; // 垂直居中裁剪
        }

        // 在 canvas 上绘制裁剪并缩放后的图片
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

        // 将 canvas 转换为 dataURL
        const dataURL = canvas.toDataURL("image/png");
        resolve(dataURL);
      };

      img.onerror = () => {
        reject(new Error("加载图片失败"));
      };
    };

    reader.onerror = () => {
      reject(new Error("读取图片文件失败"));
    };

    // 开始读取文件
    reader.readAsDataURL(file);
  });
}