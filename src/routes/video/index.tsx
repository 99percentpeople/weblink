import "./index.css";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { A, useLocation } from "@solidjs/router";
import {
  createEffect,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import {
  Circle,
  Info,
  List,
  MessageSquare,
  PanelRightOpen,
  Pin,
  ShieldAlert,
  Users,
  X,
} from "lucide-solid";
import { ClientAvatar } from "@/components/common/client-avatar";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { createMediaHashRoute } from "@/components/conversations/media-hash-route";
import { ConversationView } from "@/components/conversations/conversation-view";
import { t } from "@/i18n";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import { createLayoutTransition } from "@/libs/hooks/layout-transition";
import { createRoomInfoDialog } from "@/components/dialogs/room-info-dialog";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { useAudioPlayer } from "./components/audio-player";
import { MeetingControls } from "./components/meeting-controls";
import {
  MeetingStage,
  type MeetingStageHandle,
} from "./components/meeting-stage";
import { useMeetingSession } from "./components/meeting-session-context";
import { MeetingSharingStatus } from "./components/meeting-sharing-status";
import { MeetingPipPlaceholder } from "./components/meeting-pip-placeholder";

const tabs = [
  "conversations",
  "chat",
  "members",
  "info",
] as const;
type PanelTab = (typeof tabs)[number];

export default function Video() {
  let page: HTMLElement | undefined;
  let stage: MeetingStageHandle | undefined;
  const transitionLayout = createLayoutTransition(
    () => page,
    ".meeting-stage [data-motion-layout], .meeting-canvas-placeholder[data-motion-layout]",
    () => stage?.measure(),
  );
  const state = useAppState();
  const audio = useAudioPlayer();
  const { media, devices } = useMeetingMedia();
  const { open: openRoomInfo } = createRoomInfoDialog();
  const meeting = useMeetingSession();
  const {
    clients,
    sources,
    pinnedId,
    setPinnedId,
    railCollapsed,
    setRailCollapsed,
    toolbarFollowsRail,
  } = meeting;
  const controlsCollapsed = () =>
    !meeting.pip.active() &&
    railCollapsed() &&
    toolbarFollowsRail();
  const isMobile = createIsMobile();
  const [rightOpen, setRightOpen] = createSignal(
    window.innerWidth >= 1280,
  );
  const [tab, setTab] = createSignal<PanelTab>("chat");
  const [selectedId, setSelectedId] =
    createSignal<string>();
  const activeConversationId = () =>
    selectedId() ??
    state.activeRoomConversationId() ??
    undefined;
  createEffect(() => {
    if (isMobile()) setRightOpen(false);
  });
  const setPanelOpen = (open: boolean) => {
    if (rightOpen() === open) return;
    transitionLayout(() => setRightOpen(open));
  };
  const closePanel = () => setPanelOpen(false);
  const selectConversation = (id: string) => {
    setSelectedId(id);
    setTab("chat");
    setPanelOpen(true);
  };
  const routeLocation = useLocation();
  const mediaRoute = createMediaHashRoute(
    () => routeLocation.hash,
  );
  createEffect(
    on(mediaRoute, (route) => {
      if (route) selectConversation(route.conversationId);
    }),
  );
  const togglePin = (id: string) =>
    transitionLayout(() =>
      setPinnedId((current) =>
        current === id ? null : id,
      ),
    );
  const participantSource = (id: string) =>
    sources().find((source) => source.participantId === id);
  const participantPinned = (id: string) =>
    sources().some(
      (source) =>
        source.participantId === id &&
        source.id === pinnedId(),
    );
  const pinParticipant = (id: string) => {
    const source = participantSource(id);
    if (source)
      transitionLayout(() =>
        setPinnedId(
          participantPinned(id) ? null : source.id,
        ),
      );
  };
  const openTab = (value: PanelTab) => {
    setTab(value);
    setPanelOpen(true);
  };

  return (
    <main
      ref={page}
      class="meeting"
      classList={{
        "is-controls-collapsed": controlsCollapsed(),
      }}
      data-testid="meeting-page"
      onKeyDown={(event) => {
        if (event.key === "Escape") closePanel();
      }}
    >
      <header
        class="meeting-header"
        classList={{ "is-sharing": media.sharing() }}
      >
        <button
          type="button"
          class="meeting-heading text-left"
          aria-label={t("room_dialog.open")}
          onClick={() =>
            void openRoomInfo(
              state.activeRoomConversationId(),
            )
          }
        >
          <h1>
            {appState.roomStatus.roomId ??
              t("meeting.title")}
          </h1>
          <span>
            <Circle
              classList={{
                "is-connected": Boolean(
                  appState.roomStatus.roomId,
                ),
              }}
            />
            {appState.roomStatus.roomId
              ? t("meeting.in_room")
              : t("meeting.preview")}
          </span>
        </button>
        <div class="meeting-header-actions">
          <Show when={media.sharing()}>
            <MeetingSharingStatus
              name={appState.profile.name}
              avatar={appState.profile.avatar ?? undefined}
              count={
                sources().filter(
                  (source) =>
                    source.local &&
                    source.kind === "screen",
                ).length
              }
              onStop={() => void media.toggleSharing()}
              audioAvailable={media.sharingAudioAvailable()}
              audioOn={media.sharingAudioOn()}
              onAudioChange={media.setSharingAudioEnabled}
            />
          </Show>
          <Show when={devices.access.needsPermission()}>
            <button
              type="button"
              class="meeting-icon-button meeting-permission-button"
              aria-label={t("meeting.get_permission")}
              title={t("meeting.get_permission")}
              onClick={() =>
                void openRoomInfo(
                  state.activeRoomConversationId(),
                  "devices",
                )
              }
            >
              <ShieldAlert />
              <span>{t("meeting.get_permission")}</span>
            </button>
          </Show>
          <button
            type="button"
            class="meeting-icon-button meeting-member-count"
            onClick={() => openTab("members")}
            aria-label={t("meeting.members")}
            title={t("meeting.members")}
          >
            <Users />
            <span>{clients().length + 1}</span>
          </button>
          <button
            type="button"
            class="meeting-icon-button"
            aria-expanded={rightOpen()}
            aria-controls="meeting-side-panel"
            aria-label={
              rightOpen()
                ? t("meeting.hide_panel")
                : t("meeting.show_panel")
            }
            title={
              rightOpen()
                ? t("meeting.hide_panel")
                : t("meeting.show_panel")
            }
            onClick={() => setPanelOpen(!rightOpen())}
          >
            <PanelRightOpen />
          </button>
        </div>
      </header>
      <div class="meeting-workspace">
        <Show when={rightOpen()}>
          <button
            type="button"
            class="meeting-panel-backdrop"
            onClick={closePanel}
            aria-label={t("meeting.close_panels")}
          />
        </Show>
        <div class="meeting-canvas">
          <AnimatePresence when={!meeting.pip.active()}>
            <Motion.div
              class="meeting-canvas-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.22,
                ease: "easeOut",
              }}
            >
              <MeetingStage
                ref={(value) => {
                  stage = value;
                }}
                transitionLayout={transitionLayout}
                sources={sources()}
                pinnedId={pinnedId()}
                railCollapsed={railCollapsed()}
                onRailCollapsedChange={setRailCollapsed}
                toolbarFollowsRail={toolbarFollowsRail()}
                onPin={togglePin}
                onStop={media.stopVideoTrack}
              >
                <Show when={!appState.roomStatus.roomId}>
                  <div class="meeting-notice">
                    <span>{t("meeting.preview_hint")}</span>
                    <A href="/">{t("meeting.join_room")}</A>
                  </div>
                </Show>
              </MeetingStage>
            </Motion.div>
          </AnimatePresence>
          <AnimatePresence when={meeting.pip.active()}>
            <Motion.div
              class="meeting-canvas-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.22,
                ease: "easeOut",
              }}
            >
              <Motion.div
                class="meeting-canvas-placeholder"
                layout
                layoutId="meeting-pip-placeholder"
              >
                <MeetingPipPlaceholder
                  onReturn={
                    meeting.controls.returnToMeeting
                  }
                />
              </Motion.div>
            </Motion.div>
          </AnimatePresence>
        </div>
        <AnimatePresence when={rightOpen()}>
          <Motion.div
            class="meeting-panel-slot"
            classList={{ "is-closing": !rightOpen() }}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{
              duration: 0.28,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <Tabs
              as="aside"
              id="meeting-side-panel"
              class="meeting-side-panel"
              data-motion-layout-height="meeting-side-panel"
              aria-label={t("meeting.side_panel")}
              value={tab()}
              onChange={(value) =>
                setTab(value as PanelTab)
              }
            >
              <div class="meeting-panel-header">
                <TabsList
                  class="meeting-tabs"
                  aria-label={t("meeting.side_panel")}
                >
                  <For each={tabs}>
                    {(value) => (
                      <TabsTrigger
                        value={value}
                        id={`meeting-tab-${value}`}
                        aria-label={t(`meeting.${value}`)}
                        title={t(`meeting.${value}`)}
                      >
                        <Show
                          when={value === "conversations"}
                        >
                          <List />
                        </Show>
                        <Show when={value === "chat"}>
                          <MessageSquare />
                        </Show>
                        <Show when={value === "members"}>
                          <Users />
                        </Show>
                        <Show when={value === "info"}>
                          <Info />
                        </Show>
                        <span>{t(`meeting.${value}`)}</span>
                      </TabsTrigger>
                    )}
                  </For>
                  <TabsIndicator
                    class="meeting-tabs-indicator data-[resizing=true]:transition-none
                      motion-reduce:transition-none"
                  />
                </TabsList>
                <button
                  type="button"
                  class="meeting-icon-button"
                  aria-label={t("meeting.hide_panel")}
                  onClick={closePanel}
                >
                  <X />
                </button>
              </div>
              <TabsContent
                value="conversations"
                class="meeting-panel-content"
                id="meeting-panel-conversations"
              >
                <ConversationSidebar
                  selectedId={activeConversationId()}
                  onSelect={selectConversation}
                />
              </TabsContent>
              <TabsContent
                value="chat"
                class="meeting-panel-content"
                id="meeting-panel-chat"
              >
                <Show
                  when={activeConversationId()}
                  fallback={
                    <div class="meeting-empty">
                      <MessageSquare />
                      <p>
                        {t("meeting.select_conversation")}
                      </p>
                    </div>
                  }
                >
                  {(id) => (
                    <ConversationView
                      conversationId={id()}
                      embedded
                    />
                  )}
                </Show>
              </TabsContent>
              <TabsContent
                value="members"
                class="meeting-panel-content"
                id="meeting-panel-members"
              >
                <div class="meeting-members">
                  <p class="meeting-panel-caption">
                    {t("meeting.members_hint")}
                  </p>
                  <div class="meeting-member">
                    <ClientAvatar
                      name={appState.profile.name}
                      avatar={
                        appState.profile.avatar ?? undefined
                      }
                    />
                    <div>
                      <strong>
                        {appState.profile.name}
                      </strong>
                      <span>{t("meeting.you")}</span>
                    </div>
                  </div>
                  <For each={clients()}>
                    {(client) => (
                      <div class="meeting-member">
                        <ClientAvatar
                          name={client.name}
                          avatar={
                            client.avatar ?? undefined
                          }
                        />
                        <div>
                          <strong>{client.name}</strong>
                          <span>
                            {t(
                              `meeting.status_${client.onlineStatus}`,
                            )}
                          </span>
                        </div>
                        <button
                          type="button"
                          class="meeting-icon-button"
                          onClick={() =>
                            pinParticipant(client.clientId)
                          }
                          aria-pressed={participantPinned(
                            client.clientId,
                          )}
                          aria-label={
                            participantPinned(
                              client.clientId,
                            )
                              ? t("meeting.unpin")
                              : t("meeting.pin")
                          }
                          title={
                            participantPinned(
                              client.clientId,
                            )
                              ? t("meeting.unpin")
                              : t("meeting.pin")
                          }
                        >
                          <Pin />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </TabsContent>
              <TabsContent
                value="info"
                class="meeting-panel-content"
                id="meeting-panel-info"
              >
                <div class="meeting-info">
                  <h2>{t("meeting.room_info")}</h2>
                  <button
                    type="button"
                    class="meeting-room-chat"
                    onClick={() =>
                      void openRoomInfo(
                        state.activeRoomConversationId(),
                      )
                    }
                  >
                    <Info />
                    {t("room_dialog.open")}
                  </button>
                  <dl>
                    <dt>{t("meeting.room_name")}</dt>
                    <dd>
                      {appState.roomStatus.roomId ??
                        t("meeting.not_joined")}
                    </dd>
                    <dt>{t("meeting.message_history")}</dt>
                    <dd>{t("meeting.local_history")}</dd>
                  </dl>
                  <p>{t("meeting.history_hint")}</p>
                  <p>{t("meeting.leave_hint")}</p>
                  <Show
                    when={state.activeRoomConversationId()}
                  >
                    {(id) => (
                      <button
                        type="button"
                        class="meeting-room-chat"
                        onClick={() =>
                          selectConversation(id())
                        }
                      >
                        <MessageSquare />
                        {t("meeting.open_room_chat")}
                      </button>
                    )}
                  </Show>
                </div>
              </TabsContent>
            </Tabs>
          </Motion.div>
        </AnimatePresence>
      </div>
      <MeetingControls
        collapsed={controlsCollapsed()}
        pip={meeting.controls}
        media={media}
        devices={devices}
        playingAudio={audio.playState()}
        hasAudio={audio.hasAudio()}
        onToggleAudio={() =>
          audio.setPlay(!audio.playState())
        }
        spotlight={Boolean(pinnedId())}
        onToggleLayout={() =>
          transitionLayout(() =>
            setPinnedId((current) =>
              current
                ? null
                : (sources().find(
                    (source) => source.kind === "screen",
                  )?.id ??
                  sources().find((source) => !source.local)
                    ?.id ??
                  sources()[0]?.id ??
                  null),
            ),
          )
        }
        joined={Boolean(appState.roomStatus.roomId)}
        onLeave={meeting.leave}
      />
    </main>
  );
}
