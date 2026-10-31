import {
  createEffect,
  mapArray,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { toast } from "solid-sonner";
import {
  permissionGroup,
  type Approval,
  type Scope,
} from "@weblink/automation";
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

/** Peer consent uses the shared notification channels and connection-scoped authority. */
export function AutomationApprovalToasts(props: {
  notifications: Pick<
    NotificationService,
    "show" | "dismiss"
  >;
  showApplication?(): void | Promise<void>;
}) {
  const { automation } = useAppState();
  const needsReview = (request: Approval) => {
    const policy =
      appState.options.clientConfigs[request.principal.id]
        ?.automation;
    const required: readonly Scope[] =
      request.tool === "control.acquire" &&
      typeof request.arguments.sourceId === "string"
        ? ["input.control", "screen.manage"]
        : [request.scope];
    const decisions = required.map(
      (scope) => policy?.[scope] ?? "ask",
    );
    // A policy edit can precede the next native snapshot. Do not display its
    // obsolete request. Emergency revocation writes the saved decision to ask.
    return (
      !decisions.includes("deny") &&
      decisions.includes("ask")
    );
  };
  const pending = () =>
    automation?.ready()
      ? automation
          .snapshot()
          .pending.filter(
            (request) =>
              request.principal.kind === "peer" &&
              sessionService.canReceive(
                request.principal.id,
              ) &&
              needsReview(request),
          )
      : [];
  const allowLabel = () => t("common.action.allow_session");
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
        const decide = async (
          accepted: boolean,
          remember = false,
        ) => {
          if (answering || answered || !isCurrent()) return;
          answering = true;
          try {
            if (remember)
              await automation!.decide(
                requestId,
                accepted,
                true,
              );
            else
              await automation!.decide(requestId, accepted);
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
            <Show when={automation?.desktop}>
              <span class="block">
                {t("remote_control.revoke_hint", {
                  shortcut: shortcutLabel(
                    resolveRemoteKeyboardOptions(
                      appState.options.remoteKeyboard,
                    ).emergencyShortcut,
                  ),
                })}
              </span>
            </Show>
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
                  { id: "approve", title: allowLabel() },
                  {
                    id: "decline",
                    title: t("common.action.deny"),
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
                  await decide(action.action === "approve");
                } catch (error) {
                  toast.error(
                    t(
                      "common.notification.approval_failed",
                    ),
                  );
                  throw error;
                }
              },
              present: () =>
                showRequestToast({
                  id,
                  title: () => t("automation.requests"),
                  description,
                  acceptLabel: allowLabel,
                  declineLabel: () =>
                    t("common.action.deny"),
                  isCurrent,
                  respond: decide,
                  choicesLabel: () =>
                    t(
                      "common.action.more_approval_options",
                    ),
                  choices: [
                    {
                      label: () =>
                        t("common.action.always_allow"),
                      respond: () => decide(true, true),
                    },
                    {
                      label: () =>
                        t("common.action.always_deny"),
                      respond: () => decide(false, true),
                    },
                  ],
                  errorMessage: () =>
                    t(
                      "common.notification.approval_failed",
                    ),
                }),
            }),
        );
        // End both notification channels at the approval deadline rather than
        // waiting for another native snapshot or the shared cleanup interval.
        const expiry = setTimeout(
          () => {
            active = false;
            props.notifications.dismiss(id);
          },
          Math.max(0, request.expiresAt - Date.now()),
        );
        onCleanup(() => {
          clearTimeout(expiry);
          active = false;
          props.notifications.dismiss(id);
        });
      },
    ),
  );
  return null;
}
