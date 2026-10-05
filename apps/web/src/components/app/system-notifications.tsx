import {
  createEffect,
  createMemo,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { messageStores } from "@/libs/application/messaging/message-store";
import { sessionService } from "@/libs/application/session-service";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { messageNotificationContent } from "@/libs/application/notifications/message-notification";
import { renderNotificationAvatar } from "@/libs/application/notifications/notification-avatar";
import { appendConversationDraft } from "@/libs/hooks/conversation-draft";
import { useAppDialogs } from "@/libs/state/app-dialogs-context";
import { requestClientInfoDialog } from "@/components/dialogs/client-info-dialog-events";
import { createClipboardTransferFeedback } from "@/libs/hooks/create-clipboard-transfer-feedback";
import { isClipboardTransferTask } from "@/libs/application/task-service";

export function SystemNotificationBridge() {
  const state = useAppState();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const openConversation = (id: string) => {
    navigate(
      `/?panel=chat&conversation=${encodeURIComponent(id)}`,
    );
    void platform.application
      ?.show()
      .catch((error) =>
        console.warn("Could not show application", error),
      );
  };
  const name = (id: string) =>
    appState.session.clientViewData[id]?.name ??
    messageStores.clients.find(
      (client) => client.clientId === id,
    )?.name ??
    id;
  const preferences = () => appState.options.notifications;
  const service =
    platform.notifications &&
    new NotificationService(
      platform.notifications,
      preferences,
      () =>
        document.visibilityState === "visible" &&
        document.hasFocus(),
      (error) =>
        console.warn("System notification failed", error),
    );
  createClipboardTransferFeedback({
    tasks: state.tasks.tasks,
    notifications: service,
    openTasks: () => {
      dialogs.openTasks();
      void platform.application
        ?.show()
        .catch((error) =>
          console.warn("Could not show application", error),
        );
    },
  });
  if (!service) return null;
  const unsubscribe = messageStores.onMessageStored(
    (message) => {
      const localId = appState.profile.clientId;
      const conversationId = message.conversationId;
      if (
        message.client === localId ||
        (!message.room && message.target !== localId) ||
        !conversationId
      )
        return;
      const conversation = messageStores.conversations.find(
        (item) => item.id === conversationId,
      );
      if (!conversation) return;
      const preview = preferences().preview;
      const sender =
        appState.session.clientViewData[message.client] ??
        (message.room
          ? undefined
          : messageStores.clients.find(
              (client) =>
                client.clientId === message.client,
            ));
      const content = messageNotificationContent(
        message,
        conversation,
        sender,
        preview,
        t("setting.notifications.new_message"),
      );
      const current = () =>
        appState.profile.clientId === localId &&
        preferences().preview === preview &&
        messageStores.conversations.some(
          (item) => item.id === conversationId,
        );
      void service.show({
        category: "messages",
        current,
        prepareIcon: content.avatar
          ? () => renderNotificationAvatar(content.avatar!)
          : undefined,
        notification: {
          id: `message:${message.id}`,
          title: content.title,
          body: content.body,
          expiresAt: Date.now() + 10 * 60_000,
          reply: {
            title: t("setting.notifications.reply"),
            placeholder: t(
              "setting.notifications.reply_placeholder",
            ),
          },
        },
        async respond(action) {
          if (action.action === "open") {
            openConversation(conversationId);
            return;
          }
          if (
            action.action !== "reply" ||
            !action.text?.trim() ||
            !current()
          )
            return;
          const text = action.text;
          try {
            const submission =
              await state.conversationMessaging.sendText(
                conversationId,
                text,
              );
            void submission.completion.then(({ error }) => {
              if (error)
                toast.error(
                  t(
                    "setting.notifications.delivery_failed",
                  ),
                  {
                    action: {
                      label: t(
                        "setting.notifications.open",
                      ),
                      onClick: () =>
                        openConversation(conversationId),
                    },
                  },
                );
            });
          } catch (error) {
            // Preserve another draft and retain this unsent reply in the same composer.
            appendConversationDraft(conversationId, text);
            openConversation(conversationId);
            toast.error(
              t("setting.notifications.reply_failed"),
            );
            console.warn(
              "Notification reply was not accepted",
              error,
            );
          }
        },
      });
    },
  );
  const consent = createMemo(
    () =>
      sessionService.remoteControl.status().pending
        ?.consentId,
  );
  createEffect(
    on(consent, () => {
      const pending =
        sessionService.remoteControl.status().pending;
      if (!pending) return;
      const consentId = pending.consentId;
      const id = `control:${consentId}`;
      untrack(() => {
        void service.show({
          category: "controlRequests",
          current: () =>
            sessionService.remoteControl.status().pending
              ?.consentId === consentId,
          notification: {
            id,
            title: t("remote_control.request_title"),
            body: preferences().preview
              ? t("remote_control.request_description", {
                  name: name(pending.clientId),
                })
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
          async respond(action) {
            if (
              action.action === "approve" ||
              action.action === "decline"
            ) {
              try {
                await sessionService.remoteControl.approve(
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
        });
      });
      onCleanup(() => service.dismiss(id));
    }),
  );
  createEffect(
    on(state.speedTestApproval, (request) => {
      if (!request) return;
      const id = `speed-test:${request.id}`;
      untrack(() => {
        void service.show({
          category: "speedTestRequests",
          current: () =>
            state.speedTestApproval()?.id === request.id,
          notification: {
            id,
            title: t("speed_test.phases.approval_incoming"),
            body: preferences().preview
              ? t("speed_test.request", {
                  name: request.name.slice(0, 160),
                })
              : t("speed_test.phases.approval_incoming"),
            expiresAt: request.expiresAt,
            actions: [
              {
                id: "approve",
                title: t("speed_test.accept"),
              },
              {
                id: "decline",
                title: t("speed_test.decline"),
              },
            ],
          },
          async respond(action) {
            if (action.action === "open") {
              requestClientInfoDialog(
                request.peerId,
                "speed",
              );
              void platform.application
                ?.show()
                .catch((error) =>
                  console.warn(
                    "Could not show application",
                    error,
                  ),
                );
            } else if (
              action.action === "approve" ||
              action.action === "decline"
            ) {
              request.respond(action.action === "approve");
            }
          },
        });
      });
      onCleanup(() => service.dismiss(id));
    }),
  );
  let previousTasks = new Map<string, string>();
  createEffect(() => {
    const tasks = state.tasks.tasks();
    for (const task of tasks) {
      const previous = previousTasks.get(task.id);
      if (
        (task.kind === "file-send" ||
          task.kind === "file-receive") &&
        !isClipboardTransferTask(task) &&
        previous &&
        previous !== "completed" &&
        task.status === "completed"
      ) {
        untrack(() => {
          void service.show({
            category: "transfers",
            current: () =>
              state.tasks
                .tasks()
                .some(
                  (item) =>
                    item.id === task.id &&
                    item.status === "completed",
                ),
            notification: {
              id: `transfer:${task.id}:${task.statusChangedAt}`,
              title: t(
                "setting.notifications.transfer_completed",
              ),
              body: preferences().preview
                ? task.fileName
                : t(
                    "setting.notifications.transfer_completed",
                  ),
              expiresAt: Date.now() + 10 * 60_000,
            },
            async respond() {
              dialogs.openTasks();
            },
          });
        });
      }
    }
    previousTasks = new Map(
      tasks.map((task) => [task.id, task.status]),
    );
  });
  let previousPreferences = JSON.stringify(preferences());
  createEffect(() => {
    const next = JSON.stringify(preferences());
    if (next !== previousPreferences) {
      service.clear();
      previousPreferences = next;
    }
  });
  const cleanup = setInterval(
    () => service.reconcile(),
    15_000,
  );
  onCleanup(() => {
    clearInterval(cleanup);
    unsubscribe();
    service.close();
  });
  return null;
}
