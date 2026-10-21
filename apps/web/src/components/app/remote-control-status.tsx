import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import {
  createEffect,
  mapArray,
  onCleanup,
  untrack,
} from "solid-js";
import { showRequestToast } from "@/components/ui/request-toast";
import { sessionService } from "@/libs/application/session-service";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import type { NotificationService } from "@/libs/application/notifications/notification-service";

export function RemoteControlStatus(props: {
  notifications: Pick<
    NotificationService,
    "show" | "dismiss"
  >;
  showApplication?(): void;
}) {
  const host = sessionService.remoteControl;
  const pending = () => host.status().pending;
  const name = (id: string) =>
    appState.session.clientViewData[id]?.name ?? id;
  const description = (
    request: ReturnType<typeof pending>[number] | undefined,
  ) => (
    <>
      {t("remote_control.request_description", {
        name: name(request?.clientId ?? ""),
      })}
      <span class="block">
        {request && "sharing" in request
          ? t("remote_control.share_first_screen")
          : ""}
      </span>
      <span class="block">
        {t("remote_control.revoke_hint", {
          shortcut: shortcutLabel(
            resolveRemoteKeyboardOptions(
              appState.options.remoteKeyboard,
            ).emergencyShortcut,
          ),
        })}
      </span>
    </>
  );
  createEffect(
    mapArray(
      () => pending().map((p) => p.consentId),
      (consentId) => {
        const request = pending().find(
          (p) => p.consentId === consentId,
        );
        if (!consentId || !request) return;
        const id = `control:${consentId}`;
        const isCurrent = () =>
          pending().some(
            (item) => item.consentId === consentId,
          );
        untrack(
          () =>
            void props.notifications.show({
              category: "controlRequests",
              current: isCurrent,
              notification: {
                id,
                title: t("remote_control.request_title"),
                body: appState.options.notifications.preview
                  ? t(
                      "remote_control.request_description",
                      { name: name(request.clientId) },
                    )
                  : t("remote_control.request_title"),
                expiresAt: Date.now() + 5 * 60_000,
                actions: [
                  {
                    id: "approve",
                    title: t("remote_control.allow"),
                  },
                  {
                    id: "decline",
                    title: t("remote_control.decline"),
                  },
                ],
              },
              openInApp: () => props.showApplication?.(),
              async respond(action) {
                if (
                  action.action === "approve" ||
                  action.action === "decline"
                ) {
                  try {
                    await host.approve(
                      consentId,
                      action.action === "approve",
                    );
                  } catch (error) {
                    toast.error(
                      t("remote_control.approval_failed"),
                    );
                    throw error;
                  }
                }
              },
              present: () =>
                showRequestToast({
                  id: `remote-control:${consentId}`,
                  title: () =>
                    t("remote_control.request_title"),
                  description: () => description(request),
                  acceptLabel: () =>
                    t("remote_control.allow"),
                  declineLabel: () =>
                    t("remote_control.decline"),
                  isCurrent,
                  respond: (accepted) =>
                    host.approve(consentId, accepted),
                  choicesLabel: () =>
                    t("remote_control.more_choices"),
                  choices: [
                    {
                      label: () =>
                        t("remote_control.allow_remember"),
                      respond: () =>
                        host.approve(consentId, true, true),
                    },
                    {
                      label: () =>
                        t("remote_control.deny_remember"),
                      respond: () =>
                        host.approve(
                          consentId,
                          false,
                          true,
                        ),
                    },
                  ],
                  errorMessage: () =>
                    t("remote_control.approval_failed"),
                  onError: (error) =>
                    console.warn(
                      "Local remote-control confirmation failed",
                      error,
                    ),
                }),
            }),
        );
        onCleanup(() => props.notifications.dismiss(id));
      },
    ),
  );
  return null;
}
