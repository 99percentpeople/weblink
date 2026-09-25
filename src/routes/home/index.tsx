import "./index.css";
import { createWindowSize } from "@solid-primitives/resize-observer";
import { SharedFilesPanel } from "@/components/files/shared-files-panel";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import {
  useSearchParams,
  useLocation,
  useNavigate,
} from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js";
import {
  Circle,
  FolderOpen,
  ArrowLeft,
  Columns2,
  Minimize2,
  PanelRightClose,
  Info,
  MessageSquare,
  PanelRightOpen,
  ShieldAlert,
  Users,
  X,
} from "lucide-solid";
import { AccountMenu } from "@/components/app/account-menu";
import { useRoomActions } from "@/components/app/room-actions";
import { createMediaHashRoute } from "@/components/conversations/media-hash-route";
import { t } from "@/i18n";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import {
  createMotionLayout,
  MotionLayout,
} from "@/components/ui/motion-layout";
import { createRoomInfoDialog } from "@/components/dialogs/room-info-dialog";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { directConversationId } from "@/libs/domain/conversation";
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
import { MeetingChatPanel } from "./components/meeting-chat-panel";
import { MeetingInfoPanel } from "./components/meeting-info-panel";
import { MeetingMembersPanel } from "./components/meeting-members-panel";

const tabs = ["chat", "files", "members", "info"] as const;
type PanelTab = (typeof tabs)[number];
type DockedPanelMode = "compact" | "wide";
type PanelMode = "closed" | DockedPanelMode;
type HomeRouteState = {
  panelDetail?: true;
};

export default function Home() {
  let page: HTMLElement | undefined;
  let stage: MeetingStageHandle | undefined;
  const layout = createMotionLayout({
    root: () => page,
    afterUpdate: () => stage?.measure(),
  });
  const transitionLayout = layout.transition;
  const state = useAppState();
  const roomActions = useRoomActions();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const routeLocation = useLocation<HomeRouteState>();
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
    toolbarCollapsed,
    setToolbarCollapsed,
  } = meeting;
  const displayedToolbarCollapsed = layout.value(
    toolbarCollapsed,
  );
  const viewport = createWindowSize();
  const isMobile = createIsMobile(viewport);
  const canDockExpanded = () => viewport.width >= 1280;
  const param = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const routePanel = () => {
    const value = param(search.panel);
    return tabs.includes(value as PanelTab)
      ? (value as PanelTab)
      : undefined;
  };
  const initialPanel = routePanel();
  const initialMode =
    initialPanel || (!isMobile() && canDockExpanded())
      ? "compact"
      : "closed";
  const [panelMode, setPanelMode] =
    createSignal<PanelMode>(initialMode);
  let dockedMode: DockedPanelMode = "compact";
  const rightOpen = () => panelMode() !== "closed";
  // Preserve the exiting panel's width until its fade-out finishes.
  const displayedPanelMode = createMemo<
    Exclude<PanelMode, "closed">
  >((previous) => {
    const mode = panelMode();
    return mode === "closed" ? previous : mode;
  }, dockedMode);
  const panelFillsWorkspace = () =>
    isMobile() ||
    (displayedPanelMode() === "wide" && !canDockExpanded());
  const fullPanel = () =>
    rightOpen() && panelFillsWorkspace();
  const initialFileMember =
    initialPanel === "files"
      ? param(search.member)
      : undefined;
  const [fileMember, setFileMember] = createSignal<
    string | undefined
  >(initialFileMember);
  const [fileBrowsing, setFileBrowsing] = createSignal(
    !initialFileMember,
  );
  const [tab, setTab] = createSignal<PanelTab>(
    initialPanel ?? "chat",
  );
  const expanded = () => displayedPanelMode() !== "compact";
  const initialConversation =
    initialPanel === "chat"
      ? param(search.conversation)
      : undefined;
  const [browsing, setBrowsing] = createSignal(
    !initialConversation,
  );
  const splitChat = () => expanded() && !isMobile();
  const [selectedId, setSelectedId] = createSignal<
    string | undefined
  >(initialConversation);
  const activeConversationId = () =>
    selectedId() ??
    state.activeRoomConversationId() ??
    undefined;
  const activeFileMember = () =>
    fileMember() ?? appState.profile.clientId;
  const finishChatDetailExit = () => {
    if (browsing()) setSelectedId(undefined);
  };
  const finishFileDetailExit = () => {
    if (fileBrowsing()) setFileMember(undefined);
  };

  const applyPanelOpen = (open: boolean) => {
    if ((panelMode() !== "closed") === open) return;
    transitionLayout(() =>
      setPanelMode(open ? dockedMode : "closed"),
    );
  };
  const setPanelOpen = (open: boolean) => {
    if (rightOpen() === open) return;
    applyPanelOpen(open);
    if (open) {
      setSelectedId(undefined);
      setBrowsing(true);
      setFileMember(undefined);
      setFileBrowsing(true);
    }
    setSearch(
      open
        ? {
            panel: param(search.panel) ?? tab(),
            conversation: undefined,
            member: undefined,
          }
        : {
            panel: undefined,
            conversation: undefined,
            member: undefined,
          },
    );
  };
  const closePanel = () => setPanelOpen(false);
  const popPanelDetail = () => {
    if (routeLocation.state?.panelDetail) {
      if (tab() === "chat") setBrowsing(true);
      if (tab() === "files") setFileBrowsing(true);
      navigate(-1);
      return;
    }
    if (tab() === "files") {
      setFileBrowsing(true);
      setSearch(
        {
          panel: "files",
          member: undefined,
          conversation: undefined,
        },
        { replace: true },
      );
      return;
    }
    setBrowsing(true);
    setSearch(
      {
        panel: "chat",
        conversation: undefined,
        member: undefined,
      },
      { replace: true },
    );
  };
  const showConversation = (id: string) => {
    setSelectedId(id);
    setBrowsing(false);
    setFileMember(undefined);
    setFileBrowsing(true);
    setTab("chat");
    applyPanelOpen(true);
  };
  const selectConversation = (
    id: string,
    options?: { replace?: boolean },
  ) => {
    showConversation(id);
    setSearch(
      {
        panel: "chat",
        conversation: id,
        member: undefined,
      },
      {
        ...options,
        state: options?.replace
          ? undefined
          : ({
              panelDetail: true,
            } satisfies HomeRouteState),
      },
    );
  };
  const selectFileMember = (
    id?: string,
    options?: { replace?: boolean },
  ) => {
    setFileMember(id);
    setFileBrowsing(!id);
    setSelectedId(undefined);
    setBrowsing(true);
    setTab("files");
    applyPanelOpen(true);
    setSearch(
      {
        panel: "files",
        member: id,
        conversation: undefined,
      },
      {
        ...options,
        state:
          id && !options?.replace
            ? ({
                panelDetail: true,
              } satisfies HomeRouteState)
            : undefined,
      },
    );
  };
  const openTab = (value: PanelTab) => {
    if (tab() === value && rightOpen()) return;
    setTab(value);
    setSelectedId(undefined);
    setBrowsing(true);
    setFileMember(undefined);
    setFileBrowsing(true);
    applyPanelOpen(true);
    setSearch({
      panel: value,
      conversation: undefined,
      member: undefined,
    });
  };
  // Width transitions feed the stage's existing ResizeObserver. An explicit
  // FLIP here would measure before the CSS width has reached its destination.
  const togglePanelSize = () => {
    const mode = panelMode();
    if (mode === "closed") return;
    const next = mode === "compact" ? "wide" : "compact";
    dockedMode = next;
    setPanelMode(next);
  };
  const panelSizeAction = () =>
    expanded()
      ? "meeting.collapse_chat"
      : "meeting.expand_chat";

  onMount(() => {
    if (initialPanel || isMobile() || !canDockExpanded())
      return;
    setSearch(
      {
        panel: "chat",
        conversation: undefined,
        member: undefined,
      },
      { replace: true },
    );
  });
  createEffect(
    on(
      () => search.panel,
      () => {
        const panel = routePanel();
        if (!panel) {
          applyPanelOpen(false);
          return;
        }
        setTab(panel);
        if (panel === "chat") {
          const id = param(search.conversation);
          setBrowsing(!id);
          if (id) setSelectedId(id);
          else if (splitChat()) setSelectedId(undefined);
        } else if (panel === "files") {
          const id = param(search.member);
          setFileBrowsing(!id);
          if (id) setFileMember(id);
          else if (splitChat()) setFileMember(undefined);
        }
        applyPanelOpen(true);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => search.conversation,
      (value) => {
        if (routePanel() !== "chat") return;
        const id = param(value);
        setBrowsing(!id);
        if (id) {
          setSelectedId(id);
          applyPanelOpen(true);
        } else if (splitChat()) {
          setSelectedId(undefined);
        }
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => search.member,
      (value) => {
        if (routePanel() !== "files") return;
        const id = param(value);
        setFileBrowsing(!id);
        if (id) {
          setFileMember(id);
          applyPanelOpen(true);
        } else if (splitChat()) {
          setFileMember(undefined);
        }
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => state.activeRoomConversationId(),
      () => {
        setFileMember(undefined);
        setFileBrowsing(true);
        if (search.panel === "files")
          setSearch(
            { member: undefined },
            { replace: true },
          );
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => {
        const id = appState.options.redirectToClient;
        return id && appState.session.clientViewData[id]
          ? id
          : undefined;
      },
      (id) => {
        if (id)
          selectConversation(
            directConversationId(
              appState.profile.clientId,
              id,
            ),
            { replace: true },
          );
      },
    ),
  );
  const mediaRoute = createMediaHashRoute(
    () => routeLocation.hash,
  );
  createEffect(
    on(mediaRoute, (route) => {
      // The media route already owns this history entry. Updating search params
      // here would write the router's stale hash over the gallery's new hash.
      if (route) showConversation(route.conversationId);
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
  return (
    <MotionLayout value={layout}>
      <main
        ref={page}
        class="meeting"
        classList={{
          "is-controls-collapsed":
            displayedToolbarCollapsed(),
        }}
        data-testid="meeting-page"
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented
          )
            return;
          closePanel();
        }}
      >
        <header
          class="meeting-header bg-background/80 max-md:bg-background
            md:border-border/50 flex min-h-[68px] items-center gap-3
            px-5 py-2.5 backdrop-blur-sm transition-all
            max-md:min-h-[58px] max-md:gap-2 max-md:px-3 max-md:py-2
            md:border-b"
        >
          <button
            type="button"
            class="meeting-heading min-w-0 text-left"
            classList={{
              "max-md:sr-only": media.sharing(),
            }}
            aria-label={t("room_dialog.open")}
            onClick={() =>
              void openRoomInfo(
                state.activeRoomConversationId(),
              )
            }
          >
            <h1 class="truncate text-[15px] font-semibold">
              {appState.roomStatus.roomId ??
                t("meeting.title")}
            </h1>
            <span
              class="text-muted-foreground mt-0.5 flex items-center gap-[5px]
                text-[11px]"
            >
              <Circle
                class="size-1.5 fill-current"
                classList={{
                  "text-success-foreground": Boolean(
                    appState.roomStatus.roomId,
                  ),
                }}
              />
              {appState.roomStatus.roomId
                ? t("meeting.in_room")
                : t("meeting.preview")}
            </span>
          </button>
          <div
            class="meeting-header-actions ml-auto flex min-w-0 shrink
              items-center gap-2.5 max-md:gap-1"
          >
            <Show when={media.sharing()}>
              <MeetingSharingStatus
                name={appState.profile.name}
                avatar={
                  appState.profile.avatar ?? undefined
                }
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
              class="meeting-icon-button meeting-panel-toggle"
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
              <Show
                when={rightOpen()}
                fallback={<PanelRightOpen />}
              >
                <PanelRightClose />
              </Show>
            </button>
            <AccountMenu />
          </div>
        </header>
        <div
          class="meeting-workspace"
          classList={{ "is-panel-full": fullPanel() }}
        >
          <div
            class="meeting-canvas"
            inert={fullPanel()}
            aria-hidden={fullPanel()}
          >
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
                  active={!fullPanel()}
                  ref={(value) => {
                    stage = value;
                  }}
                  transitionLayout={transitionLayout}
                  sources={sources()}
                  pinnedId={pinnedId()}
                  hideRailToggle={displayedToolbarCollapsed()}
                  railCollapsed={railCollapsed()}
                  onRailCollapsedChange={setRailCollapsed}
                  onPin={togglePin}
                  onVideoPipEnter={(id) => {
                    if (pinnedId() === id) return;
                    transitionLayout(() => setPinnedId(id));
                  }}
                  onStop={media.stopVideoTrack}
                >
                  <Show when={!appState.roomStatus.roomId}>
                    <div
                      class="text-muted-foreground bg-accent mb-3.5 flex flex-wrap
                        items-center justify-between gap-2 rounded-md px-3.5 py-2.5
                        text-xs leading-[1.6]"
                    >
                      <span>
                        {t("meeting.preview_hint")}
                      </span>
                      <div class="ml-auto flex flex-nowrap gap-2">
                        <button
                          type="button"
                          class="text-primary underline underline-offset-[3px]"
                          disabled={
                            roomActions.busy() ||
                            appState.session
                              .clientServiceStatus ===
                              "connecting"
                          }
                          onClick={() =>
                            void roomActions.join()
                          }
                        >
                          {t("meeting.join_room")}
                        </button>
                        <button
                          type="button"
                          class="text-primary underline underline-offset-[3px]"
                          disabled={
                            roomActions.busy() ||
                            appState.session
                              .clientServiceStatus ===
                              "connecting"
                          }
                          onClick={() =>
                            void roomActions.edit()
                          }
                        >
                          {t("client.index.edit_room")}
                        </button>
                      </div>
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
              classList={{
                "is-closing": !rightOpen(),
                "is-expanded": splitChat(),
                "is-full": panelFillsWorkspace(),
              }}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{
                duration: 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <Tabs
                as={Motion.aside}
                id="meeting-side-panel"
                class="meeting-side-panel"
                layout="height"
                layoutId="meeting-side-panel"
                aria-label={t("meeting.side_panel")}
                value={tab()}
                onChange={(value) =>
                  openTab(value as PanelTab)
                }
              >
                <div
                  class="meeting-panel-header flex shrink-0 items-center justify-end
                    gap-1 border-b p-2"
                >
                  <TabsList
                    class="w-full min-w-0 flex-1 gap-0.5 bg-transparent p-0 md:w-auto
                      md:flex-[0_1_auto]"
                    aria-label={t("meeting.side_panel")}
                  >
                    <For each={tabs}>
                      {(value) => (
                        <TabsTrigger
                          value={value}
                          class="text-muted-foreground data-selected:text-foreground h-9
                            min-w-0 flex-1 flex-row gap-1.5 px-2 py-1.5 text-xs
                            font-normal md:h-11.5 md:w-17 md:grow-0 md:basis-17
                            md:flex-col md:gap-1 md:px-1.25 md:text-[11px]
                            [&>svg]:size-3.75 [&>svg]:shrink-0"
                          id={`meeting-tab-${value}`}
                          aria-label={t(`meeting.${value}`)}
                          title={t(`meeting.${value}`)}
                        >
                          <Show when={value === "chat"}>
                            <MessageSquare />
                          </Show>
                          <Show when={value === "members"}>
                            <Users />
                          </Show>
                          <Show when={value === "files"}>
                            <FolderOpen />
                          </Show>
                          <Show when={value === "info"}>
                            <Info />
                          </Show>
                          <span class="truncate">
                            {t(`meeting.${value}`)}
                          </span>
                        </TabsTrigger>
                      )}
                    </For>
                    <TabsIndicator
                      class="bg-muted pointer-events-none rounded-sm shadow-none
                        data-[orientation=horizontal]:bottom-0
                        data-[orientation=horizontal]:h-full
                        data-[resizing=true]:transition-none
                        motion-reduce:transition-none"
                    />
                  </TabsList>
                  <Show when={!isMobile()}>
                    <button
                      type="button"
                      class="meeting-icon-button"
                      aria-label={t(panelSizeAction())}
                      title={t(panelSizeAction())}
                      aria-pressed={expanded()}
                      onClick={togglePanelSize}
                    >
                      <Show
                        when={
                          displayedPanelMode() === "compact"
                        }
                        fallback={<Minimize2 />}
                      >
                        <Columns2 />
                      </Show>
                    </button>
                  </Show>
                  <Show when={!isMobile()}>
                    <button
                      type="button"
                      class="meeting-icon-button"
                      aria-label={t(
                        isMobile()
                          ? "meeting.return_to_stage"
                          : "meeting.close_panels",
                      )}
                      title={t(
                        isMobile()
                          ? "meeting.return_to_stage"
                          : "meeting.close_panels",
                      )}
                      onClick={closePanel}
                    >
                      <X />
                    </button>
                  </Show>
                </div>
                <TabsContent
                  as={Motion.div}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18 }}
                  value="chat"
                  class="meeting-panel-content"
                  id="meeting-panel-chat"
                >
                  <MeetingChatPanel
                    conversationId={activeConversationId()}
                    split={splitChat()}
                    browsing={browsing()}
                    onBack={popPanelDetail}
                    onSelect={selectConversation}
                    onDetailExitComplete={
                      finishChatDetailExit
                    }
                  />
                </TabsContent>
                <TabsContent
                  as={Motion.div}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18 }}
                  value="files"
                  class="meeting-panel-content"
                  id="meeting-panel-files"
                >
                  <SharedFilesPanel
                    active={
                      rightOpen() && tab() === "files"
                    }
                    split={splitChat()}
                    member={activeFileMember()}
                    browsing={fileBrowsing()}
                    onBack={popPanelDetail}
                    onSelect={selectFileMember}
                    onDetailExitComplete={
                      finishFileDetailExit
                    }
                  />
                </TabsContent>
                <TabsContent
                  as={Motion.div}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18 }}
                  value="members"
                  class="meeting-panel-content"
                  id="meeting-panel-members"
                >
                  <MeetingMembersPanel
                    clients={clients()}
                    roomId={appState.roomStatus.roomId}
                    onOpenRoomChat={
                      state.activeRoomConversationId()
                        ? () => {
                            const id =
                              state.activeRoomConversationId();
                            if (id) selectConversation(id);
                          }
                        : undefined
                    }
                    onOpenChat={(id) =>
                      selectConversation(
                        directConversationId(
                          appState.profile.clientId,
                          id,
                        ),
                      )
                    }
                    onOpenFiles={selectFileMember}
                    isPinned={participantPinned}
                    onPin={pinParticipant}
                  />
                </TabsContent>
                <TabsContent
                  as={Motion.div}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18 }}
                  value="info"
                  class="meeting-panel-content"
                  id="meeting-panel-info"
                >
                  <MeetingInfoPanel
                    roomId={
                      appState.roomStatus.roomId ??
                      appState.profile.roomId
                    }
                    active={
                      !!state.activeRoomConversationId()
                    }
                    onOpenSettings={() =>
                      void openRoomInfo(
                        state.activeRoomConversationId(),
                      )
                    }
                  />
                </TabsContent>
              </Tabs>
            </Motion.div>
          </AnimatePresence>
        </div>
        <MeetingControls
          collapsed={displayedToolbarCollapsed()}
          onCollapsedChange={setToolbarCollapsed}
          pip={meeting.controls}
          media={media}
          devices={devices}
          playingAudio={audio.playState()}
          hasAudio={audio.hasAudio()}
          onToggleAudio={() =>
            audio.setPlay(!audio.playState())
          }
          spotlight={Boolean(pinnedId())}
          onToggleLayout={
            sources().length > 1
              ? () =>
                  transitionLayout(() =>
                    setPinnedId((current) =>
                      current
                        ? null
                        : (sources().find(
                            (source) =>
                              source.kind === "screen",
                          )?.id ??
                          sources().find(
                            (source) => !source.local,
                          )?.id ??
                          sources()[0]?.id ??
                          null),
                    ),
                  )
              : undefined
          }
          joined={Boolean(appState.roomStatus.roomId)}
          onLeave={meeting.leave}
          onJoin={() => void roomActions.join()}
          joining={
            roomActions.busy() ||
            appState.session.clientServiceStatus ===
              "connecting"
          }
        />
      </main>
    </MotionLayout>
  );
}
