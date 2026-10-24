import {
  createEffect,
  createMemo,
  on,
  onCleanup,
  untrack,
  useContext,
  type ParentProps,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { toast } from "solid-sonner";
import { t, isDictLoaded } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { messageStores } from "@/libs/application/messaging/message-store";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { messageNotificationContent } from "@/libs/application/notifications/message-notification";
import { renderNotificationAvatar } from "@/libs/application/notifications/notification-avatar";
import { appendConversationDraft } from "@/libs/hooks/conversation-draft";
import { useAppDialogs } from "@/libs/state/app-dialogs-context";
import { NotificationsContext } from "@/libs/state/notifications-context";
import { createRemoteTransferFeedback } from "@/libs/hooks/create-remote-transfer-feedback";
import { isRemoteContentTransferTask } from "@/libs/application/task-service";
import { createUpdateFeedback } from "@/libs/hooks/create-update-feedback";
import { createMessageFeedback } from "@/libs/hooks/create-message-feedback";
import { createPresentationVisible } from "@/libs/hooks/presentation-visible";
import { createRecordingFeedback } from "@/libs/hooks/create-recording-feedback";
import { MeetingMediaContext } from "@/libs/state/meeting-media-context";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { createCacheManager } from "@/libs/application/cache-service";
import { fileOpenLabel } from "@/libs/utils/open-file";
import { RemoteControlStatus } from "./remote-control-status";
import { AutomationApprovalToasts } from "./automation-approval-toasts";

export function SystemNotificationBridge(
  props: ParentProps,
) {
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
  const preferences = () => appState.options.notifications;
  const visible = createPresentationVisible();
  const service = new NotificationService(
    platform.notifications,
    preferences,
    visible,
    (error) =>
      console.warn("System notification failed", error),
  );
  const recording = useContext(
    MeetingMediaContext,
  )?.recording;
  if (recording) {
    const preview = createPreviewDialog();
    createRecordingFeedback({
      recording,
      notifications: service,
      preview: () => preferences().preview,
      openLabel: fileOpenLabel,
      readFile: async (id) => {
        const cache = createCacheManager().getCache(id);
        const info = await cache?.getInfo();
        return info?.isComplete
          ? (info.file ?? null)
          : null;
      },
      openFile: preview.open,
      showApplication: async () => {
        await platform.application?.show();
      },
    });
  }
  createRemoteTransferFeedback({
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
  if (state.updates) {
    createUpdateFeedback({
      updates: state.updates,
      enabled: () => appState.options.autoCheckUpdates,
      ready: isDictLoaded,
      notifications: service,
      openUpdates: () => {
        void dialogs.openSettings("about");
        void platform.application
          ?.show()
          .catch((error) =>
            console.warn(
              "Could not show application",
              error,
            ),
          );
      },
    });
  }
  const showMessage = createMessageFeedback({
    preferences,
    visible,
    notifications: service,
  });
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
      void showMessage({
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
            title: t("common.action.send"),
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
  onCleanup(unsubscribe);
  createEffect(
    on(state.speedTestApproval, (request) => {
      if (!request) return;
      const id = `speed-test:${request.id}`;
      untrack(() => {
        void service.show({
          category: "speedTestRequests",
          current: () =>
            state.speedTestApproval()?.id === request.id,
          present: () => request.present(),
          openInApp: () => platform.application?.show(),
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
                title: t("common.action.deny"),
              },
            ],
          },
          async respond(action) {
            if (
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
        !isRemoteContentTransferTask(task) &&
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
    visible();
    // Delivery is imperative; pending records must not become reactive dependencies.
    untrack(() => service.reconcile());
  });
  const cleanup = setInterval(
    () => service.reconcile(),
    15_000,
  );
  onCleanup(() => {
    clearInterval(cleanup);
    service.close();
  });
  return (
    <NotificationsContext.Provider value={service}>
      {props.children}
      <AutomationApprovalToasts
        notifications={service}
        showApplication={() => platform.application?.show()}
      />
      <RemoteControlStatus
        notifications={service}
        showApplication={() => {
          void platform.application
            ?.show()
            .catch((error) =>
              console.warn(
                "Could not show application",
                error,
              ),
            );
        }}
      />
    </NotificationsContext.Provider>
  );
}
