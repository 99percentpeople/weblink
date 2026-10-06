// Only replace the application context: chat, history, layout and observers are real.
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { clipboardFixture } from "./clipboard-context";
let context: AppStateContextProps;
export const setChatTestContext = (
  value: Omit<
    AppStateContextProps,
    | "conversationMessaging"
    | "remoteClipboard"
    | "remoteFileDrop"
  > &
    Partial<
      Pick<
        AppStateContextProps,
        | "conversationMessaging"
        | "remoteClipboard"
        | "remoteFileDrop"
      >
    >,
) => {
  const peer = (id: string) =>
    JSON.parse(id.slice(7)).find(
      (client: string) => client !== "self",
    );
  context = {
    remoteFileDrop: {
      drop: async () => {
        throw new Error("Unexpected file drop");
      },
    },
    remoteClipboard: clipboardFixture,
    ...value,
    conversationMessaging: value.conversationMessaging ?? {
      sendText: async (id, text) => {
        if (id.startsWith("room:"))
          await value.sendRoomText(text);
        else await value.sendText(text, peer(id));
        return {
          messageId: "fixture",
          completion: Promise.resolve({}),
        };
      },
      sendFile: async (id, file) => {
        if (id.startsWith("room:"))
          await value.sendRoomFile(file);
        else await value.sendFile(file, peer(id));
        return {
          messageId: "fixture",
          completion: Promise.resolve({}),
        };
      },
    },
  };
};
export const useAppState = () => context;
