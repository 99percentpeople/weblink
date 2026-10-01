import { reconcile } from "solid-js/store";
import { appState, setAppState } from "./app-state";
import {
  defaultClientConfig,
  defaultRoomConfig,
  resolveClientConfig,
  resolveRoomConfig,
  type ClientConfig,
  type RoomConfig,
} from "./app-options";

export const getClientConfig = (
  clientId: string,
): ClientConfig =>
  resolveClientConfig(appState.options, clientId);

export const setClientConfig = (
  clientId: string,
  patch: Partial<ClientConfig>,
) => {
  setAppState("options", "clientConfigs", clientId, {
    ...getClientConfig(clientId),
    name:
      appState.session.clientViewData[clientId]?.name ??
      getClientConfig(clientId).name,
    ...patch,
  });
};

export const setRoomConfig = (
  conversationId: string,
  patch: Partial<RoomConfig>,
) => {
  setAppState("options", "roomConfigs", conversationId, {
    ...resolveRoomConfig(appState.options, conversationId),
    name:
      appState.message.conversations.find(
        (room) => room.id === conversationId,
      )?.title ??
      appState.options.roomConfigs[conversationId]?.name,
    ...patch,
  });
};

export const forgetClientConfig = (clientId: string) => {
  const visible = appState.session.clientViewData[clientId];
  setAppState(
    "options",
    "clientConfigs",
    clientId,
    visible
      ? reconcile({
          ...defaultClientConfig,
          name: visible.name,
        })
      : undefined,
  );
  if (appState.options.redirectToClient === clientId)
    setAppState("options", "redirectToClient", undefined);
};

export const forgetRoomConfig = (
  conversationId: string,
  activeId: string | null | undefined,
) => {
  setAppState(
    "options",
    "roomConfigs",
    conversationId,
    conversationId === activeId
      ? reconcile({
          ...defaultRoomConfig,
          name: appState.options.roomConfigs[conversationId]
            ?.name,
        })
      : undefined,
  );
};
