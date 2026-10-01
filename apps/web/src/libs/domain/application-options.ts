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

/** Import the former meeting preference only when no new value was saved. */
export function resolveApplicationOptions(
  value?: Partial<ApplicationOptions> | null,
  legacyPictureInPicture?: string | null,
): ApplicationOptions {
  return {
    automaticPictureInPicture:
      typeof value?.automaticPictureInPicture === "boolean"
        ? value.automaticPictureInPicture
        : legacyPictureInPicture === "true",
    closeBehavior:
      value?.closeBehavior === "tray" ||
      value?.closeBehavior === "exit"
        ? value.closeBehavior
        : "ask",
    hideOnRemoteControl:
      value?.hideOnRemoteControl === true,
  };
}
