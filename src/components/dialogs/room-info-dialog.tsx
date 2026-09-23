import {
  createMemo,
  createSignal,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { createDialog } from "./dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { IconSync } from "@/components/icons";
import { appState } from "@/libs/state/app-state";
import type { Conversation } from "@/libs/domain/conversation";
import { useAppState } from "@/libs/state/app-state-context";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import { MeetingDeviceField } from "@/routes/video/components/meeting-device-menu";
import { t } from "@/i18n";
import { RoomSettings } from "./room-settings";
import { RoomMembersPanel } from "./room-members-panel";

type RoomInfoTab =
  | "info"
  | "devices"
  | "settings"
  | "members";

function Metric(props: {
  label: string;
  children: JSX.Element;
}) {
  return (
    <div class="min-w-0 rounded-lg border p-3">
      <dt class="text-muted-foreground text-xs">
        {props.label}
      </dt>
      <dd class="mt-1 text-sm [overflow-wrap:anywhere] tabular-nums">
        {props.children}
      </dd>
    </div>
  );
}

/** Settings save preferences; explicit permission probes never publish capture. */
export function RoomDeviceSettings() {
  const { media, devices } = useMeetingMedia();
  onMount(devices.refresh);
  return (
    <div class="space-y-5" data-slot="room-device-settings">
      <div class="flex items-start justify-between gap-3">
        <p class="text-muted-foreground text-xs">
          {t("room_dialog.devices_hint")}
        </p>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          class="shrink-0"
          disabled={devices.refreshing()}
          aria-label={t("meeting.refresh_devices")}
          onClick={devices.refresh}
        >
          <IconSync class="size-4" />
        </Button>
      </div>
      <MeetingDeviceField
        variant="dialog"
        devices={devices}
        kind="audioinput"
        selected={devices.microphoneId()}
        busy={false}
        onSelect={media.setMicrophonePreference}
      />
      <MeetingDeviceField
        variant="dialog"
        devices={devices}
        kind="videoinput"
        selected={devices.cameraId()}
        busy={false}
        onSelect={media.setCameraPreference}
      />
      <MeetingDeviceField
        variant="dialog"
        devices={devices}
        kind="audiooutput"
        selected={devices.outputId()}
        busy={devices.outputBusy()}
        onSelect={devices.selectOutput}
      />
    </div>
  );
}

export function RoomInfoPanel(props: {
  conversationId: string | null;
  tab: RoomInfoTab;
  onTabChange(tab: RoomInfoTab): void;
}) {
  const state = useAppState();
  const conversation = () =>
    appState.message.conversations.find(
      (
        item,
      ): item is Extract<Conversation, { kind: "room" }> =>
        item.id === props.conversationId &&
        item.kind === "room",
    );
  const active = () =>
    !!props.conversationId &&
    props.conversationId ===
      state.activeRoomConversationId();
  const preview = () =>
    !props.conversationId &&
    !state.activeRoomConversationId();
  const peers = createMemo(() =>
    active()
      ? Object.values(
          appState.session.clientViewData,
        ).filter(
          (peer) =>
            peer?.onlineStatus === "online" &&
            peer.messageChannel,
        )
      : [],
  );
  const supported = (kind: "text" | "file") =>
    peers().filter(
      (peer) =>
        (kind === "text"
          ? state.roomChatCapabilities()
          : state.roomFileCapabilities())[peer.clientId] ===
        "supported",
    ).length;
  const roomId = () => {
    const room = conversation();
    return room?.kind === "room"
      ? room.roomId
      : active() || preview()
        ? appState.roomStatus.roomId
        : undefined;
  };
  return (
    <div
      class="flex min-h-0 min-w-0 flex-col gap-4"
      data-slot="room-info-panel"
    >
      <div
        class="bg-muted/50 flex min-w-0 flex-wrap items-center
          justify-between gap-2 rounded-lg p-3"
      >
        <p class="min-w-0 font-medium [overflow-wrap:anywhere]">
          {conversation()?.title ??
            roomId() ??
            t("meeting.title")}
        </p>
        <span class="text-muted-foreground text-xs">
          {t(
            active()
              ? "meeting.in_room"
              : preview()
                ? "meeting.preview"
                : "conversations.local_history",
          )}
        </span>
      </div>
      <Tabs
        value={props.tab}
        onChange={(value) =>
          props.onTabChange(value as RoomInfoTab)
        }
        class="min-w-0"
      >
        <TabsList aria-label={t("room_dialog.sections")}>
          <TabsTrigger
            value="info"
            class="h-auto min-h-8 min-w-0 flex-1 px-2 text-xs whitespace-normal
              sm:text-sm"
          >
            {t("room_dialog.info")}
          </TabsTrigger>
          <TabsTrigger
            value="devices"
            class="h-auto min-h-8 min-w-0 flex-1 px-2 text-xs whitespace-normal
              sm:text-sm"
          >
            {t("room_dialog.devices")}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            class="h-auto min-h-8 min-w-0 flex-1 px-2 text-xs whitespace-normal
              sm:text-sm"
          >
            {t("room_dialog.settings")}
          </TabsTrigger>
          <TabsTrigger
            value="members"
            class="h-auto min-h-8 min-w-0 flex-1 px-2 text-xs whitespace-normal
              sm:text-sm"
          >
            {t("room_dialog.members")}
          </TabsTrigger>
          <TabsIndicator />
        </TabsList>
        <TabsContent value="info" class="space-y-4 pt-2">
          <label class="flex min-w-0 flex-col gap-2 text-sm">
            {t("meeting.room_name")}
            <Input
              readOnly
              value={roomId() ?? t("meeting.not_joined")}
            />
          </label>
          <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Metric label={t("meeting.message_history")}>
              {t("meeting.local_history")}
            </Metric>
            <Metric label={t("room_dialog.online_members")}>
              {active() ? peers().length + 1 : "—"}
            </Metric>
            <Show when={active()}>
              <Metric label={t("room_dialog.chat_support")}>
                {supported("text")} / {peers().length}
              </Metric>
              <Metric label={t("room_dialog.file_support")}>
                {supported("file")} / {peers().length}
              </Metric>
            </Show>
          </dl>
          <p class="text-muted-foreground text-sm">
            {t("meeting.history_hint")}
          </p>
          <p class="text-muted-foreground text-sm">
            {t("room_dialog.file_hint")}
          </p>
        </TabsContent>
        <TabsContent value="devices" class="pt-2">
          <Show
            when={active() || preview()}
            fallback={
              <p class="text-muted-foreground py-4 text-sm">
                {t("room_dialog.inactive_devices")}
              </p>
            }
          >
            <RoomDeviceSettings />
          </Show>
        </TabsContent>
        <TabsContent value="settings" class="pt-2">
          <Show
            when={props.conversationId}
            fallback={
              <p class="text-muted-foreground py-4 text-sm">
                {t("room_dialog.settings_unavailable")}
              </p>
            }
          >
            {(id) => <RoomSettings conversationId={id()} />}
          </Show>
        </TabsContent>
        <TabsContent value="members" class="pt-2">
          <RoomMembersPanel
            room={conversation()}
            activeRoomId={state.activeRoomConversationId()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function createRoomInfoDialog() {
  const [target, setTarget] = createSignal<string | null>(
    null,
  );
  const [active, setActive] = createSignal(false);
  const [tab, setTab] = createSignal<RoomInfoTab>("info");
  const dialog = createDialog({
    class:
      "h-[min(42rem,calc(100dvh-2rem))] [&_[data-slot=dialog-body]]:min-h-0 [&_[data-slot=dialog-body]]:flex-1",
    title: () => t("room_dialog.title"),
    description: () => t("room_dialog.description"),
    onCancel: () => setActive(false),
    content: () => (
      <Show when={active()}>
        <RoomInfoPanel
          conversationId={target()}
          tab={tab()}
          onTabChange={setTab}
        />
      </Show>
    ),
  });
  return {
    open: (
      conversationId: string | null,
      initialTab: RoomInfoTab = "info",
    ) => {
      setTarget(conversationId);
      setTab(initialTab);
      setActive(true);
      return dialog.open();
    },
    close: dialog.close,
  };
}
