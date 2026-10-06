import { userErrorMessage } from "@/libs/user-error";
import { setClientProfile } from "@/libs/state/profile-store";
import { createDialog } from "./dialog";
import { Input } from "@/components/ui/input";
import DropArea from "@/components/drop-area";
import { FileDropOverlay } from "@/components/file-drop-overlay";
import {
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { optional } from "@/libs/domain/utils/optional";
import {
  createMemo,
  createSignal,
  createUniqueId,
  Show,
} from "solid-js";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { SettingSwitch } from "@/components/settings/setting-controls";
import { SettingSection } from "@/components/settings/setting-layout";
import {
  IconCasino,
  IconContentCopy,
  IconInfo,
  IconUploadFile,
  IconVisibility,
  IconVisibilityOff,
} from "@/components/icons";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { getDefaultAppOptions } from "@/options";
import { getInitials } from "@/libs/utils/name";
import { generateRoomPassword } from "@/libs/domain/utils/encrypt/room-password";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { appState } from "@/libs/state/app-state";
import { getRoomJoinHistory } from "@/libs/application/messaging/room-join-history";
import { messageStores } from "@/libs/application/messaging/message-store";
import { getRoomNamespace } from "@/libs/application/room-identity";
import { RoomJoinHistoryList } from "./room-join-history-list";
import { ArrowLeft } from "lucide-solid";

export const createRoomDialog = () => {
  const namespace = getRoomNamespace();
  const rooms = createMemo(() =>
    getRoomJoinHistory(
      appState.message.conversations,
      namespace,
    ),
  );
  const [step, setStep] = createSignal<"profile" | "room">(
    "profile",
  );
  const [showPassword, setShowPassword] =
    createSignal(false);
  const [uploadingAvatar, setUploadingAvatar] =
    createSignal(false);
  const [roomFormVisible, setRoomFormVisible] =
    createSignal(true);
  const [selectedRoomId, setSelectedRoomId] = createSignal<
    string | null
  >(null);
  const showRoomHistory = () =>
    !roomFormVisible() && rooms().length > 0;
  const selectedRoom = () =>
    rooms().find(
      (room) => room.roomId === selectedRoomId(),
    ) ?? rooms()[0];
  const avatarInputId = createUniqueId();
  const passwordInputId = createUniqueId();
  let profileForm: HTMLFormElement | undefined;
  let roomForm: HTMLFormElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;

  const uploadAvatar = async (file?: File) => {
    if (!file || uploadingAvatar()) return;
    setUploadingAvatar(true);
    try {
      const url = await imageFileToFilledSquareAvatar(
        file,
        128,
      );
      setClientProfile("avatar", url);
    } catch (error) {
      toast.error(
        userErrorMessage(error, "errors.avatar_failed"),
      );
    } finally {
      setUploadingAvatar(false);
    }
  };

  const goToRoomStep = () => {
    profileForm?.requestSubmit();
  };

  const submitRoom = () => {
    if (uploadingAvatar()) return;
    if (!profileForm?.checkValidity()) {
      setStep("profile");
      queueMicrotask(() => profileForm?.reportValidity());
      return;
    }
    if (showRoomHistory()) {
      const room = selectedRoom();
      if (!room) return;
      const password =
        room.joinPassword !== undefined
          ? room.joinPassword
          : appState.profile.roomId === room.roomId
            ? appState.profile.password
            : null;
      setClientProfile({ roomId: room.roomId, password });
      // Legacy rooms have no saved credentials. Let the user supply or confirm them.
      if (room.joinPassword === undefined) {
        setRoomFormVisible(true);
        return;
      }
    }
    submit({ ...appState.profile });
  };
  const addRoom = () => {
    setClientProfile({ roomId: "", password: null });
    setRoomFormVisible(true);
    setShowPassword(false);
  };
  const removeRoom = (roomId: string) => {
    const room = rooms().find(
      (item) => item.roomId === roomId,
    );
    if (room)
      messageStores.hideRoomFromJoinHistory(room.id);
    if (selectedRoomId() === roomId)
      setSelectedRoomId(rooms()[0]?.roomId ?? null);
    if (!rooms().length) addRoom();
  };

  const {
    open: openDialog,
    close,
    submit,
  } = createDialog({
    class: "gap-3 p-4 sm:max-w-md",
    title: () => t("common.join_form.title"),
    description: () =>
      t(
        step() === "profile"
          ? "common.join_form.profile_description"
          : showRoomHistory()
            ? "common.join_form.history.description"
            : "common.join_form.room_description",
      ),
    content: () => (
      <div class="flex min-h-0 flex-col gap-3 p-1">
        <nav
          class="flex items-center px-1"
          aria-label={t("common.join_form.title")}
        >
          <button
            type="button"
            class="group flex min-w-0 items-center gap-2 text-left"
            aria-current={
              step() === "profile" ? "step" : undefined
            }
            onClick={() => setStep("profile")}
          >
            <span
              class="border-border text-muted-foreground flex size-6 shrink-0
                items-center justify-center rounded-full border text-xs
                font-semibold transition-colors"
              classList={{
                "border-primary bg-primary text-primary-foreground":
                  step() === "profile",
                "border-primary/60 text-primary":
                  step() === "room",
              }}
            >
              1
            </span>
            <span
              class="text-muted-foreground truncate text-sm font-medium
                transition-colors"
              classList={{
                "text-foreground": step() === "profile",
              }}
            >
              {t("common.join_form.steps.profile")}
            </span>
          </button>
          <div
            class="bg-border mx-3 h-px min-w-6 flex-1"
            aria-hidden="true"
          >
            <div
              class="bg-primary h-full origin-left transition-transform"
              classList={{
                "scale-x-0": step() === "profile",
                "scale-x-100": step() === "room",
              }}
            />
          </div>
          <button
            type="button"
            class="group flex min-w-0 items-center gap-2 text-left"
            aria-current={
              step() === "room" ? "step" : undefined
            }
            onClick={() => setStep("room")}
          >
            <span
              class="border-border text-muted-foreground flex size-6 shrink-0
                items-center justify-center rounded-full border text-xs
                font-semibold transition-colors"
              classList={{
                "border-primary bg-primary text-primary-foreground":
                  step() === "room",
              }}
            >
              2
            </span>
            <span
              class="text-muted-foreground truncate text-sm font-medium
                transition-colors"
              classList={{
                "text-foreground": step() === "room",
              }}
            >
              {t("common.join_form.steps.room")}
            </span>
          </button>
        </nav>

        <form
          ref={profileForm}
          class="grid gap-3"
          classList={{ hidden: step() !== "profile" }}
          onSubmit={(ev) => {
            ev.preventDefault();
            setStep("room");
          }}
        >
          <label class="flex flex-col gap-1.5">
            <span class="input-label">
              {t("common.join_form.name")}
            </span>
            <Input
              required
              pattern={".*\\S.*"}
              autocomplete="nickname"
              value={appState.profile.name}
              onInput={(ev) =>
                setClientProfile(
                  "name",
                  ev.currentTarget.value,
                )
              }
            />
          </label>

          <DropArea
            class="relative flex flex-col gap-1.5"
            disabled={uploadingAvatar()}
            onDrop={(event) => {
              const files = Array.from(
                event.dataTransfer?.files ?? [],
              );
              void uploadAvatar(
                files.find((file) =>
                  file.type.startsWith("image/"),
                ) ?? files[0],
              );
            }}
            overlay={(state) => (
              <FileDropOverlay
                compact
                state={state}
                title={t("common.join_form.drop_avatar")}
                unavailableTitle={t(
                  "common.file_drop.busy",
                )}
              />
            )}
          >
            <label for={avatarInputId} class="input-label">
              {t("common.join_form.avatar")}
            </label>
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="ring-offset-background focus-visible:ring-ring shrink-0
                  rounded-full focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-offset-2"
                aria-label={t(
                  "common.join_form.upload_avatar",
                )}
                disabled={uploadingAvatar()}
                onClick={() => avatarFileInput?.click()}
              >
                <Avatar class="size-12">
                  <AvatarImage
                    src={
                      appState.profile.avatar ?? undefined
                    }
                  />
                  <AvatarFallback
                    seed={appState.profile.name}
                  >
                    {getInitials(appState.profile.name)}
                  </AvatarFallback>
                </Avatar>
              </button>

              <div class="min-w-0 flex-1">
                <InputGroup>
                  <InputGroupInput
                    id={avatarInputId}
                    placeholder={t(
                      "common.join_form.avatar_placeholder",
                    )}
                    type="url"
                    value={appState.profile.avatar ?? ""}
                    onInput={(ev) =>
                      setClientProfile(
                        "avatar",
                        optional(ev.currentTarget.value),
                      )
                    }
                  />
                  <InputGroupButton
                    type="button"
                    disabled={uploadingAvatar()}
                    aria-label={t(
                      "common.join_form.upload_avatar",
                    )}
                    title={t(
                      "common.join_form.upload_avatar",
                    )}
                    onClick={() => avatarFileInput?.click()}
                  >
                    <IconUploadFile class="size-4" />
                    <span class="hidden sm:inline">
                      {t("common.join_form.upload_avatar")}
                    </span>
                  </InputGroupButton>
                </InputGroup>
                <p class="muted mt-1">
                  {t("common.join_form.avatar_description")}
                </p>
              </div>

              <Input
                ref={avatarFileInput}
                type="file"
                multiple={false}
                accept="image/*"
                class="hidden"
                onChange={(ev) => {
                  const input = ev.currentTarget;
                  const file = input.files?.[0];
                  input.value = "";
                  void uploadAvatar(file);
                }}
              />
            </div>
          </DropArea>

          <div class="bg-muted/40 flex items-center gap-2 rounded-lg px-2.5 py-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1">
                <p class="text-muted-foreground text-xs font-medium">
                  {t("common.join_form.client_id.title")}
                </p>
                <Tooltip>
                  <TooltipTrigger
                    as="button"
                    type="button"
                    class="text-muted-foreground hover:text-foreground
                      focus-visible:ring-ring inline-flex size-4 items-center
                      justify-center rounded-full transition-colors
                      focus-visible:outline-none focus-visible:ring-2"
                    aria-label={t(
                      "common.join_form.client_id.description",
                    )}
                  >
                    <IconInfo class="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t(
                      "common.join_form.client_id.description",
                    )}
                  </TooltipContent>
                </Tooltip>
              </div>
              <p
                class="text-foreground/80 mt-0.5 truncate font-mono text-xs"
                title={appState.profile.clientId}
              >
                {appState.profile.clientId}
              </p>
            </div>
            <button
              type="button"
              class="text-muted-foreground hover:bg-accent
                hover:text-accent-foreground focus-visible:ring-ring
                inline-flex size-8 shrink-0 items-center justify-center
                rounded-md transition-colors focus-visible:outline-none
                focus-visible:ring-2"
              aria-label={t("common.action.copy")}
              onClick={() =>
                navigator.clipboard.writeText(
                  appState.profile.clientId,
                )
              }
            >
              <IconContentCopy class="size-4" />
            </button>
          </div>
        </form>

        <Show when={step() === "room" && showRoomHistory()}>
          <RoomJoinHistoryList
            rooms={rooms()}
            selected={selectedRoom()?.roomId ?? null}
            onSelect={setSelectedRoomId}
            onDelete={removeRoom}
            onAdd={addRoom}
          />
        </Show>
        <form
          ref={roomForm}
          class="grid gap-3"
          hidden={step() !== "room" || showRoomHistory()}
          classList={{
            hidden: step() !== "room" || showRoomHistory(),
          }}
          onSubmit={(ev) => {
            ev.preventDefault();
            submitRoom();
          }}
        >
          <Show when={rooms().length > 0}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-7 justify-self-start px-2 text-xs"
              onClick={() => setRoomFormVisible(false)}
            >
              <ArrowLeft />
              {t("common.join_form.history.back")}
            </Button>
          </Show>
          <label class="flex flex-col gap-1.5">
            <span class="input-label">
              {t("common.join_form.room_id.title")}
            </span>
            <Input
              required
              pattern={".*\\S.*"}
              value={appState.profile.roomId}
              onInput={(ev) =>
                setClientProfile(
                  "roomId",
                  ev.currentTarget.value,
                )
              }
            />
          </label>

          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-1">
              <label
                for={passwordInputId}
                class="input-label"
              >
                {t("common.join_form.password.title")}
              </label>
              <Tooltip>
                <TooltipTrigger
                  as="button"
                  type="button"
                  class="text-muted-foreground hover:text-foreground
                    focus-visible:ring-ring inline-flex size-4 items-center
                    justify-center rounded-full transition-colors
                    focus-visible:outline-none focus-visible:ring-2"
                  aria-label={t(
                    "common.join_form.password.description",
                  )}
                >
                  <IconInfo class="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>
                  {t(
                    "common.join_form.password.description",
                  )}
                </TooltipContent>
              </Tooltip>
            </div>

            <InputGroup>
              <InputGroupInput
                id={passwordInputId}
                type={showPassword() ? "text" : "password"}
                autocomplete="off"
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
              <InputGroupButton
                type="button"
                aria-label={t(
                  showPassword()
                    ? "common.join_form.password.hide"
                    : "common.join_form.password.show",
                )}
                title={t(
                  showPassword()
                    ? "common.join_form.password.hide"
                    : "common.join_form.password.show",
                )}
                onClick={() =>
                  setShowPassword((value) => !value)
                }
              >
                <Show
                  when={showPassword()}
                  fallback={
                    <IconVisibility class="size-4" />
                  }
                >
                  <IconVisibilityOff class="size-4" />
                </Show>
              </InputGroupButton>
              <InputGroupButton
                type="button"
                aria-label={t(
                  "common.join_form.password.generate",
                )}
                title={t(
                  "common.join_form.password.generate",
                )}
                onClick={() => {
                  const password = generateRoomPassword();
                  setClientProfile("password", password);
                }}
              >
                <IconCasino class="size-4" />
                <span class="hidden sm:inline">
                  {t("common.join_form.password.generate")}
                </span>
              </InputGroupButton>
            </InputGroup>
          </div>
        </form>
        <Show when={step() === "room"}>
          <SettingSection class="border-t">
            <SettingSwitch
              label={t("common.join_form.auto_join")}
              checked={appState.profile.autoJoin}
              onChange={(isChecked) =>
                setClientProfile("autoJoin", isChecked)
              }
            />
          </SettingSection>
        </Show>
        <p class="text-muted-foreground text-xs leading-4">
          {t(
            showRoomHistory() && step() === "room"
              ? "common.join_form.history.hint"
              : "common.join_form.autosave_hint",
          )}
        </p>
      </div>
    ),
    confirm: (
      <Show
        when={step() === "profile"}
        fallback={
          <Button
            type="button"
            size="sm"
            class="min-w-20"
            disabled={
              uploadingAvatar() ||
              (showRoomHistory() && !selectedRoom())
            }
            onClick={() =>
              showRoomHistory()
                ? submitRoom()
                : roomForm?.requestSubmit()
            }
          >
            {t("client.menu.connect")}
          </Button>
        }
      >
        <Button
          type="button"
          size="sm"
          class="min-w-20"
          disabled={uploadingAvatar()}
          onClick={goToRoomStep}
        >
          {t("common.action.continue")}
        </Button>
      </Show>
    ),
    cancel: (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => close()}
      >
        {t("common.action.close")}
      </Button>
    ),
  });

  const open = (options: { retry?: boolean } = {}) => {
    setRoomFormVisible(
      options.retry || appState.profile.initalJoin,
    );
    setSelectedRoomId(
      rooms().find(
        (room) => room.roomId === appState.profile.roomId,
      )?.roomId ??
        rooms()[0]?.roomId ??
        null,
    );
    setStep(
      !options.retry && appState.profile.initalJoin
        ? "profile"
        : "room",
    );
    setShowPassword(false);
    return openDialog();
  };

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
      JSON.stringify(appState.options.servers.turns) !==
      JSON.stringify(defaultAppOptions.servers.turns)
    ) {
      url.searchParams.append(
        "turn",
        JSON.stringify(appState.options.servers.turns),
      );
    }
  }
  return url.toString();
});

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
