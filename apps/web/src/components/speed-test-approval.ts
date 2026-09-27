import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { SPEED_TEST_APPROVAL_MS } from "@/libs/domain/speed-test-protocol";
import type { ClientID } from "@/libs/domain/ids";
import {
  CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT,
  requestClientInfoDialog,
  type ClientInfoDialogTabVisibleDetail,
} from "@/components/dialogs/client-info-dialog-events";

export interface SpeedTestApprovalController {
  request: (
    peerId: ClientID,
    name: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  accept: (peerId: ClientID) => boolean;
  decline: (peerId: ClientID) => boolean;
}

/**
 * One approval request is surfaced as a clickable toast entry point.
 * The toast actions and the peer speed-test UI settle the same promise.
 */
export function createSpeedTestApproval(): SpeedTestApprovalController {
  let current:
    | {
        peerId: ClientID;
        finish: (accepted: boolean) => void;
      }
    | undefined;

  const request: SpeedTestApprovalController["request"] = (
    peerId,
    name,
    signal,
  ) => {
    if (signal.aborted) return Promise.resolve(false);

    // Defensive only: SpeedTestService already prevents overlapping tests.
    current?.finish(false);

    return new Promise((resolve) => {
      let settled = false;
      let requestToast: string | number | undefined;
      let ignoreRequestToastDismiss = false;

      const removeToastEntryListeners = () => {
        document.removeEventListener("click", onToastClick);
        document.removeEventListener(
          "keydown",
          onToastKeyDown,
        );
        window.removeEventListener(
          CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT,
          onClientInfoTabVisible,
        );
      };

      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        removeToastEntryListeners();
        if (current?.peerId === peerId) current = undefined;
        if (requestToast !== undefined)
          toast.dismiss(requestToast);

        resolve(accepted && !signal.aborted);
      };

      const dismissRequestToast = () => {
        if (settled || ignoreRequestToastDismiss) return;
        ignoreRequestToastDismiss = true;
        removeToastEntryListeners();
        if (requestToast !== undefined) {
          toast.dismiss(requestToast);
        }
      };

      const openSpeedTest = () => {
        if (settled || ignoreRequestToastDismiss) return;
        ignoreRequestToastDismiss = true;
        removeToastEntryListeners();
        requestClientInfoDialog(peerId, "speed");
        if (requestToast !== undefined) {
          toast.dismiss(requestToast);
        }
      };

      const respondFromToast = (accepted: boolean) => {
        if (settled) return;
        ignoreRequestToastDismiss = true;
        requestClientInfoDialog(peerId, "speed");
        finish(accepted);
      };

      function isRequestToastTarget(
        target: EventTarget | null,
      ) {
        return (
          target instanceof Element &&
          target.closest(".speed-test-request-toast") !==
            null
        );
      }

      function onToastClick(event: MouseEvent) {
        if (!isRequestToastTarget(event.target)) return;
        if (
          event.target instanceof Element &&
          event.target.closest("button")
        ) {
          return;
        }
        openSpeedTest();
      }

      function onToastKeyDown(event: KeyboardEvent) {
        if (!isRequestToastTarget(event.target)) return;
        if (
          event.target instanceof Element &&
          event.target.closest("button")
        ) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ")
          return;
        event.preventDefault();
        openSpeedTest();
      }

      function onClientInfoTabVisible(event: Event) {
        const detail = (
          event as CustomEvent<ClientInfoDialogTabVisibleDetail>
        ).detail;
        if (
          detail?.clientId === peerId &&
          detail.tab === "speed"
        ) {
          dismissRequestToast();
        }
      }

      const onAbort = () => finish(false);
      const timer = setTimeout(
        () => finish(false),
        SPEED_TEST_APPROVAL_MS,
      );

      current = { peerId, finish };
      signal.addEventListener("abort", onAbort, {
        once: true,
      });
      document.addEventListener("click", onToastClick);
      document.addEventListener("keydown", onToastKeyDown);
      window.addEventListener(
        CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT,
        onClientInfoTabVisible,
      );

      requestToast = toast.info(
        t("speed_test.request", { name }),
        {
          duration: SPEED_TEST_APPROVAL_MS,
          className:
            "speed-test-request-toast cursor-pointer",
          action: {
            label: t("speed_test.accept"),
            onClick: () => respondFromToast(true),
          },
          cancel: {
            label: t("speed_test.decline"),
            onClick: () => respondFromToast(false),
          },
          onDismiss: () => {
            if (!ignoreRequestToastDismiss) finish(false);
          },
          onAutoClose: () => finish(false),
        },
      );
    });
  };

  const respond = (
    peerId: ClientID,
    accepted: boolean,
  ): boolean => {
    if (!current || current.peerId !== peerId) return false;
    current.finish(accepted);
    return true;
  };

  return {
    request,
    accept: (peerId) => respond(peerId, true),
    decline: (peerId) => respond(peerId, false),
  };
}
