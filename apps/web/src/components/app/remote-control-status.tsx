import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import {
  createEffect,
  createMemo,
  on,
  onCleanup,
} from "solid-js";
import { showRequestToast } from "@/components/ui/request-toast";
import { sessionService } from "@/libs/application/session-service";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";
export function RemoteControlStatus() {
  const host = sessionService.remoteControl;
  const pending = () => host.status().pending;
  const consent = createMemo(() => pending()?.consentId);
  const name = (id: string) =>
    appState.session.clientViewData[id]?.name ?? id;
  createEffect(
    on(consent, (consentId) => {
      const request = pending();
      if (!consentId || !request) return;
      const notice = showRequestToast({
        id: `remote-control:${consentId}`,
        title: () => t("remote_control.request_title"),
        description: () => (
          <>
            {t("remote_control.request_description", {
              name: name(request.clientId),
            })}
            <span class="block">
              {"sharing" in request
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
        ),
        acceptLabel: () => t("remote_control.allow"),
        declineLabel: () => t("remote_control.decline"),
        isCurrent: () => pending()?.consentId === consentId,
        respond: (accepted) =>
          host.approve(consentId, accepted),
        choicesLabel: () =>
          t("remote_control.more_choices"),
        choices: [
          {
            label: () => t("remote_control.allow_remember"),
            respond: () =>
              host.approve(consentId, true, true),
          },
          {
            label: () => t("remote_control.deny_remember"),
            respond: () =>
              host.approve(consentId, false, true),
          },
        ],
        errorMessage: () =>
          t("remote_control.approval_failed"),
        onError: (error) =>
          console.warn(
            "Local remote-control confirmation failed",
            error,
          ),
      });
      onCleanup(notice.dismiss);
    }),
  );
  return null;
}
