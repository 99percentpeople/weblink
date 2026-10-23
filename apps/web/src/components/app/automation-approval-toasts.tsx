import {
  createEffect,
  mapArray,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { toast } from "solid-sonner";
import { permissionGroup } from "@weblink/automation";
import { sessionService } from "@/libs/application/session-service";
import type { NotificationService } from "@/libs/application/notifications/notification-service";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import {
  groupDescription,
  scopeLabel,
} from "@/libs/i18n/automation";
import { shortcutLabel } from "@/libs/domain/keyboard-shortcut";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { showRequestToast } from "@/components/ui/request-toast";
import { t } from "@/i18n";

/** Peer consent uses the shared notification channels; native authority validates every answer. */
export function AutomationApprovalToasts(props: {
  notifications: Pick<
    NotificationService,
    "show" | "dismiss"
  >;
  showApplication?(): void | Promise<void>;
}) {
  const { automation } = useAppState();
  const pending = () =>
    automation?.desktop &&
    automation.enabled() &&
    automation.ready()
      ? automation
          .snapshot()
          .pending.filter(
            (request) =>
              request.principal.kind === "peer" &&
              sessionService.canReceive(
                request.principal.id,
              ),
          )
      : [];
  const allowLabel = (minutes: number) =>
    t("automation.allow_minutes", { minutes });
  createEffect(
    mapArray(
      () => pending().map((request) => request.id),
      (requestId) => {
        const request = pending().find(
          (item) => item.id === requestId,
        )!;
        // Capture identity fields: reconciled snapshots can mutate their objects in place.
        const principal = { ...request.principal };
        const scope = request.scope;
        let active = true;
        const current = () =>
          pending().find(
            (item) =>
              item.id === requestId &&
              item.principal.id === principal.id &&
              item.principal.generation ===
                principal.generation &&
              item.scope === scope,
          );
        const isCurrent = () =>
          active &&
          (current()?.expiresAt ?? 0) > Date.now();
        const id = `automation-approval:${requestId}`;
        let answering = false;
        let answered = false;
        const decide = async (minutes: number) => {
          if (answering || answered || !isCurrent()) return;
          answering = true;
          try {
            await automation!.decide(requestId, minutes);
            answered = true;
          } finally {
            answering = false;
          }
        };
        const description = () => (
          <>
            <span class="block">
              {principal.label} · {scopeLabel(scope)}
            </span>
            <span class="block">
              {groupDescription(permissionGroup(scope))}
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
            <details>
              <summary class="cursor-pointer">
                {t("automation.arguments")}
              </summary>
              <code>{request.tool}</code>
              <Show when={request.source}>
                <p>
                  {t("automation.reported_source")}:{" "}
                  {request.source?.kind} ·{" "}
                  {request.source?.label}
                </p>
              </Show>
              <pre
                class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all
                  text-xs"
              >
                {JSON.stringify(request.arguments, null, 2)}
              </pre>
            </details>
          </>
        );
        untrack(
          () =>
            void props.notifications.show({
              category: "controlRequests",
              current: isCurrent,
              retryInAppOnError: true,
              notification: {
                id,
                title: t("automation.requests"),
                body: appState.options.notifications.preview
                  ? `${principal.label} · ${scopeLabel(scope)}`
                  : t("automation.requests"),
                expiresAt: request.expiresAt,
                actions: [
                  { id: "approve", title: allowLabel(15) },
                  {
                    id: "decline",
                    title: t("automation.deny"),
                  },
                ],
              },
              openInApp: () => props.showApplication?.(),
              async respond(action) {
                if (
                  action.action !== "approve" &&
                  action.action !== "decline"
                )
                  return;
                try {
                  await decide(
                    action.action === "approve" ? 15 : 0,
                  );
                } catch (error) {
                  toast.error(
                    t("automation.approval_failed"),
                  );
                  throw error;
                }
              },
              present: () =>
                showRequestToast({
                  id,
                  title: () => t("automation.requests"),
                  description,
                  acceptLabel: () => allowLabel(15),
                  declineLabel: () => t("automation.deny"),
                  isCurrent,
                  respond: (accepted) =>
                    decide(accepted ? 15 : 0),
                  choicesLabel: () =>
                    t("automation.duration"),
                  choices: [5, 60].map((minutes) => ({
                    label: () => allowLabel(minutes),
                    respond: () => decide(minutes),
                  })),
                  errorMessage: () =>
                    t("automation.approval_failed"),
                }),
            }),
        );
        onCleanup(() => {
          active = false;
          props.notifications.dismiss(id);
        });
      },
    ),
  );
  return null;
}
