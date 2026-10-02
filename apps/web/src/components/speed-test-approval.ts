import { toast } from "solid-sonner";
import { createSignal, type Accessor } from "solid-js";
import { t } from "@/i18n";
import { SPEED_TEST_APPROVAL_MS } from "@/libs/domain/speed-test-protocol";
import {
  createUuid,
  type ClientID,
} from "@/libs/domain/ids";
import {
  CLIENT_INFO_DIALOG_TAB_VISIBLE_EVENT,
  requestClientInfoDialog,
  type ClientInfoDialogTabVisibleDetail,
} from "@/components/dialogs/client-info-dialog-events";

export interface SpeedTestApprovalRequest {
  readonly id: string;
  readonly peerId: ClientID;
  readonly name: string;
  readonly expiresAt: number;
  /** Respond only to this exact request, including when a peer requests again. */
  respond(accepted: boolean): boolean;
}

export interface SpeedTestApprovalController {
  pending: Accessor<SpeedTestApprovalRequest | undefined>;
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
 * Toast, panel and system notification actions settle the same promise.
 */
export function createSpeedTestApproval(): SpeedTestApprovalController {
  const [pending, setPending] =
    createSignal<SpeedTestApprovalRequest>();
  let current:
    | {
        id: string;
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
      const id = createUuid();
      const expiresAt = Date.now() + SPEED_TEST_APPROVAL_MS;
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
        if (current?.id === id) {
          current = undefined;
          setPending(undefined);
        }
        if (requestToast !== undefined)
          toast.dismiss(requestToast);

        resolve(
          accepted &&
            !signal.aborted &&
            Date.now() < expiresAt,
        );
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
        if (accepted)
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

      current = { id, peerId, finish };
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
      setPending({
        id,
        peerId,
        name,
        expiresAt,
        respond(accepted) {
          if (settled || current?.id !== id) return false;
          const live =
            !signal.aborted && Date.now() < expiresAt;
          finish(accepted && live);
          return live;
        },
      });
    });
  };

  const respond = (
    peerId: ClientID,
    accepted: boolean,
  ): boolean => {
    const request = pending();
    if (!request || request.peerId !== peerId) return false;
    return request.respond(accepted);
  };

  return {
    pending,
    request,
    accept: (peerId) => respond(peerId, true),
    decline: (peerId) => respond(peerId, false),
  };
}
