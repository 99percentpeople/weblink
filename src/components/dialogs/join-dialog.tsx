import { createStore, reconcile } from "solid-js/store";
import { setClientProfile } from "@/libs/state/profile-store";
import { createDialog } from "./dialog";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { optional } from "@/libs/domain/utils/optional";
import { createMemo, createSignal, Show } from "solid-js";
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
import { generateStrongPassword } from "@/libs/domain/utils/encrypt/strong-password";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { appState } from "@/libs/state/app-state";

export const createRoomDialog = () => {
  const [draft, setDraft] = createStore({
    ...appState.profile,
  });
  const [step, setStep] = createSignal<"profile" | "room">(
    "profile",
  );
  const [showPassword, setShowPassword] =
    createSignal(false);
  let profileForm: HTMLFormElement | undefined;
  let roomForm: HTMLFormElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;

  const goToRoomStep = () => {
    profileForm?.requestSubmit();
  };

  const {
    open: openDialog,
    close,
    submit,
  } = createDialog({
    class: "h-[32rem] [&_[data-slot=dialog-body]]:flex-1",
    title: () => t("common.join_form.title"),
    description: () =>
      t(
        step() === "profile"
          ? "common.join_form.profile_description"
          : "common.join_form.room_description",
      ),
    content: () => (
      <div class="flex min-h-0 flex-col gap-5 p-1">
        <div class="flex items-center px-1">
          <button
            type="button"
            class="group flex min-w-0 items-center gap-2 text-left"
            aria-current={
              step() === "profile" ? "step" : undefined
            }
            onClick={() => setStep("profile")}
          >
            <span
              class="border-border text-muted-foreground flex size-7 shrink-0
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

          <div class="bg-border mx-3 h-px min-w-6 flex-1">
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
            onClick={goToRoomStep}
          >
            <span
              class="border-border text-muted-foreground flex size-7 shrink-0
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
        </div>

        <form
          ref={profileForm}
          class="grid gap-4"
          classList={{ hidden: step() !== "profile" }}
          onSubmit={(ev) => {
            ev.preventDefault();
            setStep("room");
          }}
        >
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.name")}
            </span>
            <Input
              required
              value={draft.name}
              onInput={(ev) =>
                setDraft("name", ev.currentTarget.value)
              }
            />
          </label>

          <div class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.avatar")}
            </span>
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="ring-offset-background focus-visible:ring-ring shrink-0
                  rounded-full focus-visible:ring-2
                  focus-visible:ring-offset-2 focus-visible:outline-none"
                aria-label={t(
                  "common.join_form.upload_avatar",
                )}
                onClick={() => avatarFileInput?.click()}
              >
                <Avatar class="size-14">
                  <AvatarImage
                    src={draft.avatar ?? undefined}
                  />
                  <AvatarFallback seed={draft.name}>
                    {getInitials(draft.name)}
                  </AvatarFallback>
                </Avatar>
              </button>

              <div class="min-w-0 flex-1">
                <InputGroup>
                  <InputGroupInput
                    placeholder={t(
                      "common.join_form.avatar_placeholder",
                    )}
                    type="url"
                    value={draft.avatar ?? ""}
                    onInput={(ev) =>
                      setDraft(
                        "avatar",
                        optional(ev.currentTarget.value),
                      )
                    }
                  />
                  <InputGroupButton
                    type="button"
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
                <p class="muted mt-1.5">
                  {t("common.join_form.avatar_description")}
                </p>
              </div>

              <Input
                ref={avatarFileInput}
                type="file"
                multiple={false}
                accept="image/*"
                class="hidden"
                onChange={async (ev) => {
                  const file =
                    ev.currentTarget.files?.item(0);
                  if (!file) return;

                  const url =
                    await imageFileToFilledSquareAvatar(
                      file,
                      128,
                    );
                  setDraft("avatar", url);
                  ev.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          <div
            class="border-border/60 bg-muted/30 flex items-center gap-3
              rounded-md border px-3 py-2.5"
          >
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
                      focus-visible:ring-2 focus-visible:outline-none"
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
                title={draft.clientId}
              >
                {draft.clientId}
              </p>
            </div>
            <button
              type="button"
              class="text-muted-foreground hover:bg-accent
                hover:text-accent-foreground focus-visible:ring-ring
                inline-flex size-8 shrink-0 items-center justify-center
                rounded-md transition-colors focus-visible:ring-2
                focus-visible:outline-none"
              aria-label={t("common.action.copy")}
              onClick={() =>
                navigator.clipboard.writeText(
                  draft.clientId,
                )
              }
            >
              <IconContentCopy class="size-4" />
            </button>
          </div>
        </form>

        <form
          ref={roomForm}
          class="grid gap-4"
          classList={{ hidden: step() !== "room" }}
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!profileForm?.checkValidity()) {
              setStep("profile");
              queueMicrotask(() =>
                profileForm?.reportValidity(),
              );
              return;
            }
            setClientProfile({
              ...draft,
              initalJoin: false,
            });
            submit({ ...draft, initalJoin: false });
          }}
        >
          <label class="flex flex-col gap-2">
            <span class="input-label">
              {t("common.join_form.room_id.title")}
            </span>
            <Input
              required
              value={draft.roomId}
              onInput={(ev) =>
                setDraft("roomId", ev.currentTarget.value)
              }
            />
          </label>

          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-1">
              <span class="input-label">
                {t("common.join_form.password.title")}
              </span>
              <Tooltip>
                <TooltipTrigger
                  as="button"
                  type="button"
                  class="text-muted-foreground hover:text-foreground
                    focus-visible:ring-ring inline-flex size-4 items-center
                    justify-center rounded-full transition-colors
                    focus-visible:ring-2 focus-visible:outline-none"
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
                type={showPassword() ? "text" : "password"}
                autocomplete="off"
                placeholder={t(
                  "common.join_form.password.placeholder",
                )}
                value={draft.password ?? ""}
                onInput={(ev) =>
                  setDraft(
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
                onClick={async () => {
                  const password =
                    await generateStrongPassword();
                  setDraft("password", password);
                }}
              >
                <IconCasino class="size-4" />
                <span class="hidden sm:inline">
                  {t("common.join_form.password.generate")}
                </span>
              </InputGroupButton>
            </InputGroup>
          </div>

          <Switch
            class="flex items-center justify-between"
            checked={draft.autoJoin}
            onChange={(isChecked) =>
              setDraft("autoJoin", isChecked)
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
      </div>
    ),
    confirm: (
      <Show
        when={step() === "profile"}
        fallback={
          <Button
            type="button"
            onClick={() => roomForm?.requestSubmit()}
          >
            {t("common.action.confirm")}
          </Button>
        }
      >
        <Button type="button" onClick={goToRoomStep}>
          {t("common.action.continue")}
        </Button>
      </Show>
    ),
    cancel: (
      <Button
        type="button"
        variant="destructive"
        onClick={() => close()}
      >
        {t("common.action.cancel")}
      </Button>
    ),
  });

  const open = () => {
    setDraft(reconcile({ ...appState.profile }));
    setStep(draft.initalJoin ? "profile" : "room");
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
