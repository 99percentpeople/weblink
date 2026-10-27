// Replaces only the context lookup in the isolated browser UI fixture.
// The real task service, speed-test driver, dialogs and tabs are used unchanged.
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { clipboardFixture } from "./clipboard-context";
import { createScreenSharing } from "@/libs/application/screen-sharing";
let context: AppStateContextProps;
export const setTaskTestContext = (
  value: Omit<
    AppStateContextProps,
    "remoteClipboard" | "remoteFileDrop" | "screenSharing"
  >,
) => {
  context = {
    screenSharing: createScreenSharing({
      stream: value.localStream,
      publish: value.replaceLocalStream,
    }),
    remoteFileDrop: {
      drop: async () => {
        throw new Error("Unexpected file drop");
      },
    },
    ...value,
    remoteClipboard: clipboardFixture,
  };
};
export const useAppState = () => context;
