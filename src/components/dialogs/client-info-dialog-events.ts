import type { ClientID } from "@/libs/core/ids";

export type ClientInfoDialogTab =
  | "session"
  | "speed"
  | "raw"
  | "settings";

export const OPEN_CLIENT_INFO_DIALOG_EVENT =
  "weblink:open-client-info-dialog";
export const CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT =
  "weblink:client-info-dialog-tab-visible";

export interface OpenClientInfoDialogDetail {
  clientId: ClientID;
  tab: ClientInfoDialogTab;
}

export interface ClientInfoDialogTabVisibleDetail {
  clientId: ClientID;
  tab: ClientInfoDialogTab;
}

export function requestClientInfoDialog(
  clientId: ClientID,
  tab: ClientInfoDialogTab = "session",
) {
  window.dispatchEvent(
    new CustomEvent<OpenClientInfoDialogDetail>(
      OPEN_CLIENT_INFO_DIALOG_EVENT,
      {
        detail: { clientId, tab },
      },
    ),
  );
}

export function notifyClientInfoDialogTabVisible(
  clientId: ClientID,
  tab: ClientInfoDialogTab,
) {
  window.dispatchEvent(
    new CustomEvent<ClientInfoDialogTabVisibleDetail>(
      CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT,
      {
        detail: { clientId, tab },
      },
    ),
  );
}
