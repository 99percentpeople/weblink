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

export const resetClientConfig = (clientId: string) => {
  setAppState(
    "options",
    "clientConfigs",
    clientId,
    reconcile({
      ...defaultClientConfig,
      name:
        appState.session.clientViewData[clientId]?.name ??
        appState.options.clientConfigs[clientId]?.name,
    }),
  );
  if (appState.options.redirectToClient === clientId)
    setAppState("options", "redirectToClient", undefined);
};

export const resetRoomConfig = (conversationId: string) => {
  setAppState(
    "options",
    "roomConfigs",
    conversationId,
    reconcile({
      ...defaultRoomConfig,
      name: appState.options.roomConfigs[conversationId]
        ?.name,
    }),
  );
};

export const forgetClientConfig = (clientId: string) => {
  if (appState.session.clientViewData[clientId]) {
    resetClientConfig(clientId);
    return;
  }
  setAppState(
    "options",
    "clientConfigs",
    clientId,
    undefined,
  );
  if (appState.options.redirectToClient === clientId)
    setAppState("options", "redirectToClient", undefined);
};

export const forgetRoomConfig = (
  conversationId: string,
  activeId: string | null | undefined,
) => {
  if (conversationId === activeId) {
    resetRoomConfig(conversationId);
    return;
  }
  setAppState(
    "options",
    "roomConfigs",
    conversationId,
    undefined,
  );
};
