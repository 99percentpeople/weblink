export type ApplicationCloseBehavior =
  | "ask"
  | "exit"
  | "tray";

export interface ApplicationOptions {
  automaticPictureInPicture: boolean;
  closeBehavior: ApplicationCloseBehavior;
  hideOnRemoteControl: boolean;
}

export const defaultApplicationOptions: ApplicationOptions =
  {
    automaticPictureInPicture: false,
    closeBehavior: "ask",
    hideOnRemoteControl: false,
  };

export function resolveApplicationOptions(
  value?: Partial<ApplicationOptions> | null,
): ApplicationOptions {
  return {
    automaticPictureInPicture:
      value?.automaticPictureInPicture === true,
    closeBehavior:
      value?.closeBehavior === "tray" ||
      value?.closeBehavior === "exit"
        ? value.closeBehavior
        : "ask",
    hideOnRemoteControl:
      value?.hideOnRemoteControl === true,
  };
}
