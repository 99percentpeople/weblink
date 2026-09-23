import { MeetingSessionProvider } from "@/routes/home/components/meeting-session-context";
import { createRoot, type ParentProps } from "solid-js";
import { render } from "solid-js/web";
import {
  Route,
  Router,
  useNavigate,
} from "@solidjs/router";
import { MeetingMediaProvider } from "@/libs/hooks/meeting-media-context";
import { RoomActionsProvider } from "@/components/app/room-actions";
import { AppDialogsProvider } from "@/components/app/app-dialogs";
import { ColorModeProvider } from "@kobalte/core";
import { ModalProvider } from "@/components/dialogs/base";
import Video from "@/routes/home";
import Home from "../../support/chat-workspace";
import ConversationPage from "../../support/conversation-page";
import { AudioPlayerProvider } from "@/routes/home/components/audio-player";
import { createLocalStreamService } from "@/libs/application/local-stream-service";
import { createMessageStores } from "@/libs/application/messaging/message-store";
import type {
  MessageRepository,
  MessageRepositorySnapshot,
} from "@/libs/application/messaging/message-repository";
import { createTaskService } from "@/libs/application/task-service";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { ClientInfo } from "@/libs/state/app-state";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import type {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";
import type { ActiveFileTransfer } from "@/libs/application/transfer/file-transfer-state";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import { setChatTestContext } from "./chat-context";
import { t } from "@/i18n";
import "@/global.css";
import {
  checkMessageGallery,
  checkGalleryHistory,
  createGalleryVideo,
  createGalleryAudio,
} from "./message-gallery";

const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve()),
  );
function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
async function until(
  check: () => boolean,
  description = "UI condition",
) {
  for (let i = 0; i < 240; i++) {
    if (check()) return;
    await frame();
  }
  throw new Error(`${description} did not settle`);
}
const labels = [
  { id: "work", name: "Work" },
  { id: "design", name: "Design" },
  { id: "personal", name: "Personal" },
];
const namespace =
  "websocket:wss://signal.example.test/ws/team%20design";
const roomId = "Design stand-up";
const room = roomConversationId(namespace, roomId);
const historyRoom = roomConversationId(
  namespace,
  "Friday catch-up",
);
const direct = directConversationId("self", "alice");
const now = Date.now();
const peers: ClientInfo[] = [
  {
    clientId: "alice",
    name: "Alice Lin",
    avatar: null,
    createdAt: now,
    onlineStatus: "online",
    messageChannel: true,
  },
  {
    clientId: "ben",
    name: "Ben Cooper",
    avatar: null,
    createdAt: now,
    onlineStatus: "online",
    messageChannel: true,
  },
  {
    clientId: "kai",
    name: "Kai Nakamura",
    avatar: null,
    createdAt: now,
    onlineStatus: "online",
    messageChannel: true,
  },
];
const conversations: Conversation[] = [
  {
    id: room,
    kind: "room",
    namespace: namespace,
    roomId,
    title: roomId,
    labelIds: ["work", "design"],
    createdAt: now - 900_000,
  },
  {
    id: direct,
    kind: "direct",
    peerId: "alice",
    title: "Alice Lin",
    labelIds: ["work"],
    createdAt: now - 800_000,
  },
  {
    id: historyRoom,
    kind: "room",
    namespace: namespace,
    roomId: "Friday catch-up",
    title: "Friday catch-up",
    labelIds: ["personal"],
    createdAt: now - 700_000,
  },
];
function roomMessage(
  id: string,
  sender: string,
  data: string,
  time: number,
): TextMessage {
  return {
    id,
    type: "text",
    conversationId: room,
    client: sender,
    target: roomId,
    data,
    createdAt: time,
    status: "received",
    room: {
      roomId,
      senderName:
        sender === "self"
          ? "Alex Chen"
          : peers.find((peer) => peer.clientId === sender)!
              .name,
      senderAvatar: null,
    },
    ...(sender === "self"
      ? {
          deliveries: {
            alice: "delivered" as const,
            ben: "delivered" as const,
            kai: "delivered" as const,
          },
        }
      : {}),
  };
}
const initial: MessageRepositorySnapshot = {
  clients: peers.map(({ clientId, name, avatar }) => ({
    clientId,
    name,
    avatar,
  })),
  conversations,
  labels,
  messages: [
    ...Array.from({ length: 36 }, (_, index) =>
      roomMessage(
        `room-history-${index}`,
        index % 2 ? "alice" : "ben",
        `Earlier design note ${index + 1}. ` +
          "Keep room chat inside its scrolling panel while the meeting controls stay visible. ".repeat(
            3,
          ),
        now - 600_000 + index * 1000,
      ),
    ),
    ...Array.from(
      { length: 30 },
      (_, index): TextMessage => ({
        id: `direct-history-${index}`,
        type: "text",
        conversationId: direct,
        client: index % 2 ? "alice" : "self",
        target: index % 2 ? "self" : "alice",
        data:
          `Private note ${index + 1}. ` +
          "The conversation should scroll without moving the room controls or expanding the document. ".repeat(
            3,
          ),
        createdAt: now - 500_000 + index * 1000,
        status: "received",
      }),
    ),
    roomMessage(
      "room-welcome",
      "alice",
      "Morning everyone! Ready for a quick design review?",
      now - 300_000,
    ),
    roomMessage(
      "room-agenda",
      "self",
      "Yes — let's review the meeting layout and the shared conversation list.",
      now - 240_000,
    ),
    roomMessage(
      "room-note",
      "ben",
      "The room chat looks good. I like keeping the call visible while we talk.",
      now - 210_000,
    ),
    roomMessage(
      "room-ready",
      "kai",
      "I've added the notes to our Design label. We can start whenever you're ready.",
      now - 180_000,
    ),
    {
      id: "alice-private",
      type: "text",
      conversationId: direct,
      client: "alice",
      target: "self",
      data: "I will share the updated mockups after the call.",
      createdAt: now - 120_000,
      status: "received",
    },
  ],
};
class MemoryRepository implements MessageRepository {
  messages = new Map(
    initial.messages.map((message) => [
      message.id,
      message,
    ]),
  );
  async load() {
    return initial;
  }
  async putMessage(message: StoreMessage) {
    this.messages.set(message.id, message);
  }
  async removeMessage(id: string) {
    this.messages.delete(id);
  }
  async removeMessages(ids: string[]) {
    ids.forEach((id) => this.messages.delete(id));
  }
  async putClient() {}
  async removeClient() {}
  async putConversation() {}
  async removeConversation() {}
  async putLabel() {}
  async removeLabel() {}
}
const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>("button"),
];
function click(key: string, role = "button") {
  const label = t(key);
  const candidates =
    role === "tab"
      ? [
          ...document.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
          ),
        ]
      : buttons();
  const button = candidates.find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );
  assert(button, `Missing ${role}: ${label}`);
  assert(!button.disabled, `Disabled ${role}: ${label}`);
  button.click();
}
const sidebar = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="conversation-sidebar"]',
  );
const conversationRows = (id?: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      "[data-conversation-id]",
    ),
  ].filter(
    (element) =>
      !id || element.dataset.conversationId === id,
  );
async function showConversations() {
  if (!document.querySelector("#meeting-side-panel"))
    click("meeting.show_panel");
  if (!sidebar()) click("meeting.chat", "tab");
  if (!sidebar()) click("conversations.back_to_list");
  await until(() => Boolean(sidebar()));
  assert(
    document
      .querySelector("#meeting-panel-chat")
      ?.contains(sidebar()!) &&
      !document.querySelector("#meeting-conversations"),
    "conversation list must live in the right panel tab",
  );
}
async function selectConversation(id: string) {
  await showConversations();
  const panel = document.querySelector(
    "#meeting-side-panel",
  );
  const stage = document.querySelector(".meeting-stage");
  const button =
    conversationRows(
      id,
    )[0]?.querySelector<HTMLButtonElement>("button");
  assert(button, `Conversation missing: ${id}`);
  button.click();
  await frame();
  assert(
    !sidebar() &&
      document
        .querySelector("#meeting-tab-chat")
        ?.getAttribute("aria-selected") === "true" &&
      document.querySelector("#meeting-side-panel") ===
        panel &&
      document.querySelector(".meeting-stage") === stage,
    "selecting a conversation must switch to chat within the same panel and preserve the stage",
  );
}
function input(selector: string, value: string) {
  const field = document.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >(selector);
  assert(field, `Missing field ${selector}`);
  field.value = value;
  field.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }),
  );
}
function noOverflow(name: string) {
  const page = document.querySelector<HTMLElement>(
    '[data-testid="meeting-page"]',
  )!;
  const bounds = page.getBoundingClientRect();
  const panel = document.querySelector<HTMLElement>(
    "#meeting-side-panel",
  );
  if (panel) {
    assert(
      panel.scrollHeight <= panel.clientHeight + 1 &&
        panel.scrollWidth <= panel.clientWidth + 1,
      `${name}: side panel overflow`,
    );
    const panelHeader = panel.querySelector<HTMLElement>(
      ".meeting-panel-header",
    )!;
    assert(
      panelHeader.scrollWidth <=
        panelHeader.clientWidth + 1,
      `${name}: four-tab header overflow`,
    );
    for (const button of panelHeader.querySelectorAll(
      "button",
    )) {
      const rect = button.getBoundingClientRect();
      const area = panelHeader.getBoundingClientRect();
      assert(
        rect.width > 0 &&
          rect.left >= area.left &&
          rect.right <= area.right + 1,
        `${name}: tab or close button escaped the panel`,
      );
    }
  }
  for (const composer of document.querySelectorAll<HTMLElement>(
    '[data-slot="chat-composer"]',
  )) {
    const area = composer.getBoundingClientRect();
    assert(
      composer.scrollWidth <= composer.clientWidth + 1,
      `${name}: composer overflow`,
    );
    for (const control of composer.querySelectorAll(
      "label[title], button, textarea",
    )) {
      const rect = control.getBoundingClientRect();
      assert(
        rect.width > 0 &&
          rect.left >= area.left &&
          rect.right <= area.right + 1,
        `${name}: composer attachment or text control escaped its panel`,
      );
    }
  }
  const stage = document.querySelector<HTMLElement>(
    ".meeting-stage",
  )!;
  assert(
    stage.scrollWidth <= stage.clientWidth + 1,
    `${name}: stage horizontal overflow ${stage.scrollWidth}/${stage.clientWidth}`,
  );
  assert(
    stage.scrollHeight <= stage.clientHeight + 1,
    `${name}: stage vertical overflow ${stage.scrollHeight}/${stage.clientHeight}`,
  );
  for (const tile of stage.querySelectorAll(
    ".meeting-tile",
  )) {
    const picture = tile.getBoundingClientRect();
    assert(
      picture.width > 0 &&
        picture.height > 0 &&
        Math.abs(
          (picture.width * 9) / 16 - picture.height,
        ) <= 1,
      `${name}: picture must be 16:9, received ${picture.width}x${picture.height}`,
    );
  }
  const controls = document.querySelector<HTMLElement>(
    ".meeting-controls",
  )!;
  assert(
    controls.scrollWidth <= controls.clientWidth + 1,
    `${name}: control horizontal overflow ${controls.scrollWidth}/${controls.clientWidth}`,
  );
  const header = document.querySelector<HTMLElement>(
    ".meeting-header",
  )!;
  const headerBounds = header.getBoundingClientRect();
  assert(
    header.scrollWidth <= header.clientWidth + 1,
    `${name}: header horizontal overflow`,
  );
  for (const button of header.querySelectorAll("button")) {
    const bounds = button.getBoundingClientRect();
    assert(
      bounds.width > 0 &&
        bounds.left >= headerBounds.left &&
        bounds.right <= headerBounds.right + 1,
      `${name}: header action escaped viewport`,
    );
  }

  const footer = document
    .querySelector<HTMLElement>(".meeting-controls")!
    .getBoundingClientRect();
  assert(
    document.documentElement.scrollWidth <= innerWidth + 1,
    `${name}: horizontal document overflow ${document.documentElement.scrollWidth}/${innerWidth}`,
  );
  assert(
    document.documentElement.scrollHeight <=
      innerHeight + 1,
    `${name}: vertical document overflow ${document.documentElement.scrollHeight}/${innerHeight}`,
  );
  assert(
    bounds.width <= innerWidth + 1 &&
      bounds.height <= innerHeight + 1,
    `${name}: meeting overflow`,
  );
  assert(
    footer.bottom <= innerHeight + 1 && footer.top >= 0,
    `${name}: controls escaped viewport`,
  );
}
async function checkFocusLayout(name: string) {
  await frame();
  await frame();
  const stage = document.querySelector<HTMLElement>(
    ".meeting-stage",
  )!;
  const feature = document.querySelector<HTMLElement>(
    ".meeting-tile.is-featured",
  )!;
  assert(feature, `${name}: missing main picture`);
  assert(
    stage.scrollHeight <= stage.clientHeight + 1 &&
      stage.scrollWidth <= stage.clientWidth + 1,
    `${name}: stage overflow ${stage.scrollWidth}x${stage.scrollHeight}/${stage.clientWidth}x${stage.clientHeight}`,
  );
  const area = stage.getBoundingClientRect();
  const picture = feature.getBoundingClientRect();
  assert(
    picture.width > 0 &&
      picture.height > 0 &&
      picture.top >= area.top &&
      picture.bottom <= area.bottom + 1,
    `${name}: main picture escaped its available height`,
  );
  for (const video of stage.querySelectorAll("video"))
    assert(
      getComputedStyle(video).objectFit === "contain",
      `${name}: video frame was cropped`,
    );
  noOverflow(name);
}
async function checkGridResizing() {
  const hadRight = Boolean(
    document.querySelector("#meeting-side-panel"),
  );
  if (hadRight) click("meeting.hide_panel");
  const shell = document.getElementById(
    "meeting-test-shell",
  )!;
  const originalStyle = shell.style.cssText;
  const workspace = document.querySelector<HTMLElement>(
    ".meeting-workspace",
  )!;
  const originalWorkspaceStyle = workspace.style.cssText;
  const grid =
    document.querySelector<HTMLElement>(".meeting-grid")!;
  const loopErrors: string[] = [];
  const onError = (event: ErrorEvent) => {
    if (event.message.includes("ResizeObserver"))
      loopErrors.push(event.message);
  };
  window.addEventListener("error", onError);
  const check = async (name: string) => {
    // Allow one observation delivery and its scheduled layout frame.
    for (let i = 0; i < 4; i++) await frame();
    const samples: string[] = [];
    for (let i = 0; i < 6; i++) {
      await frame();
      samples.push(
        getComputedStyle(grid).gridTemplateColumns,
      );
      noOverflow(name);
      const area = grid.getBoundingClientRect();
      for (const tile of grid.querySelectorAll(
        ".meeting-tile",
      )) {
        const bounds = tile.getBoundingClientRect();
        assert(
          bounds.left >= area.left - 1 &&
            bounds.right <= area.right + 1 &&
            bounds.top >= area.top - 1 &&
            bounds.bottom <= area.bottom + 1,
          `${name}: grid picture escaped its available space`,
        );
      }
    }
    assert(
      new Set(samples).size === 1,
      `${name}: columns oscillated after container settled`,
    );
  };
  try {
    shell.style.minHeight = "0";
    for (const [width, height] of [
      [1120, 360],
      [520, 700],
      [820, 420],
      [1120, 700],
      [520, 360],
      [1120, 360],
      [820, 700],
      [1120, 700],
    ]) {
      // Resize the stage's available space, as side panels do, without
      // changing the viewport breakpoint used by the independent toolbar.
      workspace.style.width = `${Math.min(workspace.parentElement!.clientWidth, width)}px`;
      shell.style.height = `${height}px`;
      await check(`grid container ${width}x${height}`);
    }
    for (let index = 0; index < 9; index++) {
      const clientId = `grid-extra-${index}`;
      setAppState("session", "clientViewData", clientId, {
        clientId,
        name: clientId,
        avatar: null,
        createdAt: now,
        onlineStatus: "online",
        messageChannel: true,
      });
    }
    await check("more sources without a container resize");
    for (let index = 0; index < 9; index++)
      setAppState(
        "session",
        "clientViewData",
        `grid-extra-${index}`,
        undefined!,
      );
    await check(
      "sources removed without a container resize",
    );
    shell.style.cssText = originalStyle;
    workspace.style.cssText = originalWorkspaceStyle;
    if (hadRight) click("meeting.show_panel");
    await check("grid after restoring side panels");
    assert(
      loopErrors.length === 0,
      `grid resize feedback: ${loopErrors.join("; ")}`,
    );
  } finally {
    shell.style.cssText = originalStyle;
    workspace.style.cssText = originalWorkspaceStyle;
    window.removeEventListener("error", onError);
  }
}
async function checkFocusedThumbnails() {
  const hadRight = Boolean(
    document.querySelector("#meeting-side-panel"),
  );
  if (hadRight) click("meeting.hide_panel");
  click("meeting.focus_layout");
  await checkFocusLayout("expanded focus stage");
  const extraIds = Array.from(
    { length: 12 },
    (_, index) => `focus-extra-${index}`,
  );
  for (const clientId of extraIds)
    setAppState("session", "clientViewData", clientId, {
      clientId,
      name: `Guest ${clientId.slice(-2)}`,
      avatar: null,
      createdAt: now,
      onlineStatus: "online",
      messageChannel: true,
    });
  await checkFocusLayout("many focused thumbnails");
  const rail = document.querySelector<HTMLElement>(
    ".meeting-thumbnails",
  )!;
  assert(
    rail && rail.scrollWidth > rail.clientWidth,
    "many thumbnails must scroll in their own rail",
  );
  const feature = document.querySelector<HTMLElement>(
    ".meeting-tile.is-featured",
  )!;
  const before = feature.getBoundingClientRect();
  rail.scrollLeft = rail.scrollWidth;
  await frame();
  const after = feature.getBoundingClientRect();
  assert(
    rail.scrollLeft > 0 &&
      Math.abs(before.left - after.left) < 1 &&
      Math.abs(before.top - after.top) < 1,
    "scrolling thumbnails moved the main picture",
  );
  const shell = document.getElementById(
    "meeting-test-shell",
  )!;
  shell.style.minHeight = "0";
  shell.style.height = "420px";
  await checkFocusLayout("compact actual stage height");
  for (const id of [
    ...extraIds,
    ...peers.map((peer) => peer.clientId),
  ])
    setAppState(
      "session",
      "clientViewData",
      id,
      undefined!,
    );
  await checkFocusLayout("compact solo focus stage");
  click("meeting.grid_layout");
  await frame();
  await frame();
  noOverflow("compact solo grid stage");
  const soloStage = document.querySelector<HTMLElement>(
    ".meeting-stage",
  )!;
  assert(
    soloStage.scrollHeight <= soloStage.clientHeight + 1,
    "single picture overflowed compact stage height",
  );
  for (const peer of peers)
    setAppState(
      "session",
      "clientViewData",
      peer.clientId,
      peer,
    );
  shell.style.minHeight = "";
  shell.style.height = "";
  if (hadRight) click("meeting.show_panel");
  await frame();
}

async function checkChatScroll(name: string) {
  await until(
    () =>
      document
        .querySelector('[data-slot="chat-viewport"] ul')
        ?.getAttribute("aria-busy") === "false",
    `${name} positioning`,
  );
  const viewport = document.querySelector<HTMLElement>(
    '[data-slot="chat-viewport"]',
  )!;
  const footer = document.querySelector<HTMLElement>(
    ".meeting-controls",
  )!;
  noOverflow(name);
  const viewportRect = viewport.getBoundingClientRect();
  for (const receipts of viewport.querySelectorAll<HTMLElement>(
    '[data-slot="room-deliveries"]',
  )) {
    const bubble =
      receipts.parentElement!.querySelector<HTMLElement>(
        '[data-slot="message-bubble"]',
      )!;
    const bubbleRect = bubble.getBoundingClientRect();
    const receiptRect = receipts.getBoundingClientRect();
    const outgoing =
      receipts
        .closest("[data-side]")
        ?.getAttribute("data-side") === "outgoing";
    const towardCenter = outgoing
      ? receiptRect.right <= bubbleRect.left + 1
      : receiptRect.left >= bubbleRect.right - 1;
    assert(
      towardCenter &&
        receiptRect.top < bubbleRect.bottom &&
        receiptRect.bottom > bubbleRect.top,
      `${name}: delivery avatars must be toward the page center on the same row as the bubble`,
    );
    assert(
      receiptRect.left >= viewportRect.left - 1 &&
        receiptRect.right <= viewportRect.right + 1,
      `${name}: delivery avatars overflowed the chat viewport`,
    );
  }
  const roomChat = Boolean(
    viewport.closest('[data-slot="room-conversation"]'),
  );
  for (const row of viewport.querySelectorAll<HTMLElement>(
    "[data-chat-message]",
  )) {
    const avatar = row.querySelector<HTMLElement>(
      '[data-slot="message-sender-avatar"]',
    );
    assert(
      Boolean(avatar) === roomChat,
      `${name}: sender avatars must appear only in room chat`,
    );
    if (!avatar) continue;
    const bubbleRect = row
      .querySelector<HTMLElement>(
        '[data-slot="message-bubble"]',
      )!
      .getBoundingClientRect();
    const avatarRect = avatar.getBoundingClientRect();
    const outgoing = row.dataset.side === "outgoing";
    assert(
      outgoing
        ? avatarRect.left >= bubbleRect.right - 1
        : avatarRect.right <= bubbleRect.left + 1,
      `${name}: sender avatar must remain on the outer side of the bubble`,
    );
  }
  assert(
    viewport.clientHeight > 100 &&
      viewport.scrollHeight > viewport.clientHeight + 100,
    `${name}: chat did not establish an internal scrollport ${viewport.scrollHeight}/${viewport.clientHeight}`,
  );
  const bottom = footer.getBoundingClientRect().bottom;
  viewport.scrollTop = Math.max(
    0,
    viewport.scrollTop - 160,
  );
  viewport.dispatchEvent(new Event("scroll"));
  await frame();
  await frame();
  assert(
    Math.abs(
      footer.getBoundingClientRect().bottom - bottom,
    ) < 1,
    `${name}: scrolling chat moved meeting controls`,
  );
  assert(
    (document.scrollingElement?.scrollTop ?? 0) === 0,
    `${name}: chat scrolled the document`,
  );
  viewport.scrollTop = viewport.scrollHeight;
  viewport.dispatchEvent(new Event("scroll"));
  await frame();
}

let navigate!: ReturnType<typeof useNavigate>;
function Shell(props: ParentProps) {
  navigate = useNavigate();
  return (
    <AudioPlayerProvider>
      <MeetingMediaProvider>
        <RoomActionsProvider>
          <MeetingSessionProvider>
            <AppDialogsProvider>
              <ColorModeProvider>
                <ModalProvider>
                  <div
                    id="meeting-test-shell"
                    class="flex h-full min-h-full w-full flex-col md:flex-row"
                  >
                    <nav
                      aria-label="App navigation fixture"
                      class="bg-background text-foreground flex
                        h-[var(--mobile-header-height)]
                        w-[var(--desktop-header-width)] shrink-0 items-center
                        justify-center border-r font-semibold"
                    >
                      W
                    </nav>
                    <div class="min-h-0 min-w-0 flex-1">
                      {props.children}
                    </div>
                  </div>
                </ModalProvider>
              </ColorModeProvider>
            </AppDialogsProvider>
          </MeetingSessionProvider>
        </RoomActionsProvider>
      </MeetingMediaProvider>
    </AudioPlayerProvider>
  );
}

async function main() {
  sessionStorage.clear();
  setAppState("profile", "clientId", "self");
  setAppState("profile", "name", "Alex Chen");
  setAppState("options", "locale", "en-us");
  setAppState("options", "redirectToClient", undefined);
  setAppState("roomStatus", { roomId, profile: null });
  setAppState(
    "session",
    "clientViewData",
    Object.fromEntries(
      peers.map((peer) => [peer.clientId, peer]),
    ),
  );
  const repository = new MemoryRepository();
  const stores = createMessageStores(repository);
  await stores.initialize();
  const local = createLocalStreamService();
  const tasks = createRoot(() =>
    createTaskService({
      clientId: () => "self",
      messages: () => appState.message.messages,
      caches: () => appState.cache.cacheInfo,
      transfers: () => ({}),
    }),
  );
  let sentCount = 0;
  let sentFiles = 0;
  let requestedFiles = 0;
  const attachment = new File(
    [new Uint8Array([0, 255, 83, 42])],
    "meeting-data.bin",
    { type: "application/octet-stream" },
  );
  const photo = new File(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#5599cc"/></svg>',
    ],
    "meeting-photo.svg",
    { type: "image/svg+xml" },
  );
  const fileOffer = (
    id: string,
    sender: string,
    file: File,
  ): FileTransferMessage => ({
    id,
    type: "file",
    conversationId: room,
    client: sender,
    target: "self",
    createdAt: Date.now(),
    status: "received",
    fid: `file-${id}`,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    chunkSize: 512,
    lastModified: file.lastModified,
    room: {
      roomId,
      senderName:
        sender === "self" ? "Alex Chen" : "Alice Lin",
      senderAvatar: null,
    },
    ...(sender === "self"
      ? {
          deliveries: {
            alice: "delivered" as const,
            ben: "delivered" as const,
          },
        }
      : {}),
  });
  const cacheFile = (
    offer: FileTransferMessage,
    file: File,
  ) =>
    setAppState("cache", "cacheInfo", offer.fid!, {
      id: offer.fid!,
      fileName: file.name,
      fileSize: file.size,
      mimetype: file.type,
      chunkSize: offer.chunkSize,
      lastModified: file.lastModified,
      file,
      isComplete: true,
      roomAttachment: true,
      roomOfferId: offer.id,
      from: offer.client,
    });
  let leftCount = 0;
  const unexpected = async () => {
    throw new Error(
      "Unexpected network or file operation in meeting smoke test",
    );
  };
  setChatTestContext({
    conversationHistory: {
      cacheLocalTextBatch: unexpected,
    },
    tasks,
    getSpeedTestState: tasks.latestSpeedTest,
    speedTestState: () => ({
      status: "idle",
      peerId: null,
      direction: null,
    }),
    startSpeedTest: unexpected,
    cancelSpeedTest: () => {},
    approveSpeedTest: () => {},
    declineSpeedTest: () => {},
    localStream: local.stream,
    replaceLocalStream: local.replace,
    clearLocalStream: local.clear,
    joinRoom: unexpected,
    leaveRoom: () => {
      leftCount++;
    },
    activeRoomConversationId: () => room,
    roomChatCapabilities: () => ({
      alice: "supported",
      ben: "supported",
      kai: "supported",
    }),
    roomFileCapabilities: () => ({
      alice: "supported",
      ben: "supported",
      kai: "supported",
    }),
    sendRoomFile: async (file) => {
      if (!(file instanceof File))
        throw new Error(
          "This fixture accepts local files only",
        );
      sentFiles++;
      const offer = fileOffer(
        `sent-file-${sentFiles}`,
        "self",
        file,
      );
      cacheFile(offer, file);
      await stores.putRoomMessage(offer);
    },
    requestRoomFile: async (offer) => {
      requestedFiles++;
      cacheFile(
        offer,
        offer.mimeType?.startsWith("image/")
          ? photo
          : attachment,
      );
    },
    sendRoomText: async (text) => {
      sentCount++;
      await stores.putRoomMessage(
        roomMessage(
          `sent-${sentCount}`,
          "self",
          text,
          Date.now(),
        ),
      );
    },
    requestFile: unexpected,
    sendText: unexpected,
    sendFile: unexpected,
    sendClipboard: unexpected,
    catalog: {
      watch: () => {
        throw new Error("Unexpected directory query");
      },
    },
    retryMessage: unexpected,
    shareFile: unexpected,
    resumeFile: unexpected,
    pauseFile: unexpected,
    roomStatus: appState.roomStatus,
  });
  // Synthetic browser-native tracks exercise the controls without camera,
  // microphone, screen-picker permissions or any external network traffic.
  const audioContext = new AudioContext();
  const captureRequests: MediaStreamConstraints[] = [];
  const capturedStreams: MediaStream[] = [];
  const permission = () =>
    Object.assign(new EventTarget(), {
      state: "prompt" as PermissionState,
    });
  const permissions = {
    microphone: permission(),
    camera: permission(),
    "speaker-selection": permission(),
  };
  const setPermission = (
    name: keyof typeof permissions,
    state: PermissionState,
  ) => {
    permissions[name].state = state;
    permissions[name].dispatchEvent(new Event("change"));
  };
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: async ({ name }: PermissionDescriptor) =>
        permissions[name as keyof typeof permissions],
    },
  });
  const displayCaptures: {
    video: MediaStreamTrack;
    audio: MediaStreamTrack;
  }[] = [];
  const microphoneTrack = () =>
    local
      .stream()
      ?.getAudioTracks()
      .find((track) => track.contentHint === "speech");
  const selectDevice = async (key: string, id: string) => {
    const select =
      document.querySelector<HTMLButtonElement>(
        `[role="combobox"][aria-label="${t(key)}"]`,
      )!;
    assert(select, `Missing device selector: ${key}`);
    await until(() => !select.disabled, `${key} ready`);
    select.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        button: 0,
      }),
    );
    const option = () =>
      document
        .getElementById(
          select.getAttribute("aria-controls") ?? "",
        )
        ?.querySelector<HTMLElement>(
          `[role="option"][data-device-id="${id}"]`,
        );
    await until(() => !!option(), `${key} device options`);
    option()!.click();
    await until(
      () => select.dataset.deviceId === id,
      `${key} selection applied`,
    );
  };
  const outputSelections: string[] = [];
  const device = (
    kind: MediaDeviceKind,
    deviceId: string,
    label: string,
  ) =>
    ({
      kind,
      deviceId,
      label,
      groupId: "test",
      toJSON: () => ({}),
    }) as MediaDeviceInfo;
  Object.defineProperty(
    navigator.mediaDevices,
    "enumerateDevices",
    {
      configurable: true,
      value: async () =>
        [
          device(
            "audioinput",
            "default",
            "Default microphone",
          ),
          device(
            "audioinput",
            "mic-1",
            "Built-in microphone",
          ),
          device("audioinput", "mic-2", "Desk microphone"),
          device(
            "videoinput",
            "camera-1",
            "Built-in camera",
          ),
          device(
            "videoinput",
            "camera-2",
            "External camera",
          ),
          device(
            "audiooutput",
            "speaker-1",
            "Built-in speakers",
          ),
          device("audiooutput", "speaker-2", "Headphones"),
        ].map((item) => {
          const allowed =
            item.kind === "audioinput"
              ? permissions.microphone.state === "granted"
              : item.kind === "videoinput"
                ? permissions.camera.state === "granted"
                : permissions["speaker-selection"].state ===
                    "granted" ||
                  permissions.microphone.state ===
                    "granted";
          return allowed ? item : device(item.kind, "", "");
        }),
    },
  );
  Object.defineProperty(
    navigator.mediaDevices,
    "selectAudioOutput",
    {
      configurable: true,
      value: async () => {
        setPermission("speaker-selection", "granted");
        return device(
          "audiooutput",
          "speaker-1",
          "Built-in speakers",
        );
      },
    },
  );
  Object.defineProperty(
    HTMLMediaElement.prototype,
    "setSinkId",
    {
      configurable: true,
      value: async (id: string) => {
        outputSelections.push(id);
      },
    },
  );
  function videoStream(label: string) {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(
      0,
      0,
      960,
      600,
    );
    gradient.addColorStop(0, "#244358");
    gradient.addColorStop(1, "#193a3c");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 960, 600);
    context.fillStyle = "#d8e6f4";
    context.font = "500 34px Inter, sans-serif";
    context.textAlign = "center";
    context.fillText(label, 480, 290);
    context.fillStyle = "#9db4c4";
    context.font = "18px Inter, sans-serif";
    context.fillText("Meeting preview", 480, 329);
    return canvas.captureStream(2);
  }
  Object.defineProperty(
    navigator.mediaDevices,
    "getUserMedia",
    {
      configurable: true,
      value: async (
        constraints: MediaStreamConstraints,
      ) => {
        captureRequests.push(constraints);
        setPermission(
          constraints.audio ? "microphone" : "camera",
          "granted",
        );
        const stream = constraints.audio
          ? audioContext.createMediaStreamDestination()
              .stream
          : videoStream("Alex Chen");
        capturedStreams.push(stream);
        return stream;
      },
    },
  );
  Object.defineProperty(
    navigator.mediaDevices,
    "getDisplayMedia",
    {
      configurable: true,
      value: async (
        options: DisplayMediaStreamOptions & {
          systemAudio?: string;
        },
      ) => {
        assert(
          options.audio === true &&
            options.systemAudio === "include",
          "screen picker did not request optional shared audio",
        );
        const stream = videoStream("Screen sharing");
        const audio = audioContext
          .createMediaStreamDestination()
          .stream.getAudioTracks()[0];
        stream.addTrack(audio);
        displayCaptures.push({
          video: stream.getVideoTracks()[0],
          audio,
        });
        return stream;
      },
    },
  );
  const scenarios: string[] = [];
  const query = location.search;
  history.replaceState({}, "", `/video${query}`);
  render(
    () => (
      <Router root={Shell}>
        <Route path="/video" component={Video} />
        <Route path="/" component={Home}>
          <Route
            path="/conversation/:id"
            component={ConversationPage}
          />
          <Route
            path="/"
            component={() => <p>Choose a conversation</p>}
          />
        </Route>
      </Router>
    ),
    document.getElementById("root")!,
  );
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-testid="meeting-page"]',
        ),
      ),
    "meeting mount",
  );
  await document.fonts.ready;
  if (!document.querySelector("#meeting-side-panel"))
    click("meeting.show_panel");
  await until(
    () =>
      document
        .querySelector('[data-slot="room-conversation"] ul')
        ?.getAttribute("aria-busy") === "false",
    "room chat initial layout",
  );
  await checkChatScroll(
    "long room history in actual app shell",
  );
  assert(
    document.querySelectorAll(".meeting-tile").length === 4,
    "missing room participants",
  );
  scenarios.push(
    "real room chat and four participant tiles",
  );
  const roomDialog = () =>
    document.querySelector<HTMLElement>('[role="dialog"]');
  const openRoomSettings = async () => {
    document
      .querySelector<HTMLButtonElement>(
        `[data-slot="room-conversation"] button[aria-label="${t("room_dialog.open")}"]`,
      )!
      .click();
    await until(
      () => !!roomDialog(),
      "room settings dialog",
    );
  };
  const closeRoomSettings = async () => {
    [
      ...roomDialog()!.querySelectorAll<HTMLButtonElement>(
        "button",
      ),
    ]
      .find(
        (button) => button.textContent?.trim() === "Close",
      )!
      .click();
    await until(
      () => !roomDialog(),
      "room settings closed",
    );
  };
  const permissionEntry = () =>
    document.querySelector<HTMLButtonElement>(
      ".meeting-header-actions .meeting-permission-button",
    );
  await until(
    () => !!permissionEntry(),
    "missing device access entry in right header",
  );
  const toolbarPermissionEntry = () =>
    document.querySelector<HTMLButtonElement>(
      "#meeting-device-menu .meeting-permission-button",
    );
  permissionEntry()!.click();
  await until(
    () =>
      !!roomDialog()?.querySelector(
        '[data-slot="room-device-settings"]',
      ),
    "permission entry opens device settings directly",
  );
  assert(
    captureRequests.length === 0 && !local.stream(),
    "opening permission settings started meeting capture",
  );
  const field = (kind: MediaDeviceKind) =>
    (roomDialog() ??
      document.getElementById(
        "meeting-device-menu",
      ))!.querySelector<HTMLElement>(
      `[data-device-kind="${kind}"]`,
    )!;
  const grant = async (kind: MediaDeviceKind) => {
    await until(() => {
      const action = field(
        kind,
      ).querySelector<HTMLButtonElement>(
        'button:not([role="combobox"])',
      );
      return !!action && !action.disabled;
    }, `${kind} permission action ready`);
    const button = field(
      kind,
    ).querySelector<HTMLButtonElement>(
      'button:not([role="combobox"])',
    );
    assert(
      button && !button.disabled,
      `permission action missing for ${kind}`,
    );
    button.click();
    await until(
      () =>
        !field(kind).querySelector(
          'button:not([role="combobox"])',
        ) &&
        !field(kind).querySelector<HTMLButtonElement>(
          '[role="combobox"]',
        )?.disabled,
      `${kind} list after granting access`,
    );
  };
  await grant("audiooutput");
  assert(
    captureRequests.length === 0 &&
      outputSelections.includes("speaker-1"),
    "speaker permission opened microphone capture or ignored selected output",
  );
  await closeRoomSettings();
  const grantInToolbar = async (kind: MediaDeviceKind) => {
    await until(() => {
      const button = toolbarPermissionEntry();
      return !!button && !button.disabled;
    }, `${kind} toolbar permission ready`);
    toolbarPermissionEntry()!.click();
    await until(
      () =>
        field(kind).querySelector<HTMLButtonElement>(
          '[role="combobox"]',
        )?.disabled === false,
      `${kind} granted from toolbar`,
    );
    assert(
      !roomDialog() && !local.stream(),
      "toolbar permission opened settings or published capture",
    );
  };
  click("meeting.audio_devices");
  await grantInToolbar("audioinput");
  click("meeting.camera_devices");
  setPermission("camera", "denied");
  await until(
    () =>
      field("videoinput").textContent?.includes(
        t("meeting.device_disabled"),
      ) === true,
    "blocked camera status",
  );
  assert(
    !field("videoinput").querySelector(
      'button:not([role="combobox"])',
    ) &&
      !toolbarPermissionEntry() &&
      field("videoinput").querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      )?.disabled,
    "blocked camera still offers usable device selection",
  );
  setPermission("camera", "prompt");
  await grantInToolbar("videoinput");
  await until(
    () =>
      capturedStreams.every((stream) =>
        stream
          .getTracks()
          .every((track) => track.readyState === "ended"),
      ),
    "temporary permission captures released",
  );
  assert(
    !local.stream() && !permissionEntry(),
    "permission grant published media or left a stale header action",
  );
  click("meeting.close_device_menu");
  scenarios.push(
    "header opens permission settings; toolbar requests input access directly; native speaker and temporary input grants populate lists without publishing; denied devices hide permission actions",
  );
  assert(
    !document.querySelector(
      '[data-slot="chat-composer"] [role="status"]',
    ),
    "room capability hints remain above the composer",
  );
  const capturesBeforeDialog = captureRequests.length;
  await openRoomSettings();
  assert(
    roomDialog()!.querySelector<HTMLInputElement>(
      "input[readonly]",
    )?.value === roomId,
    "room dialog displayed the wrong room",
  );
  click("room_dialog.devices", "tab");
  await until(
    () =>
      !!roomDialog()!.querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      ),
    "room device settings",
  );
  await selectDevice("meeting.microphone_device", "mic-2");
  assert(
    !roomDialog()!.querySelector('[role="switch"]'),
    "room settings must only select devices, without capture switches",
  );
  assert(
    captureRequests.length === capturesBeforeDialog,
    "opening settings or preselecting a disabled device started capture",
  );
  const dialogBounds =
    roomDialog()!.getBoundingClientRect();
  assert(
    dialogBounds.left >= -1 &&
      dialogBounds.right <= innerWidth + 1 &&
      dialogBounds.bottom <= innerHeight + 1,
    "room dialog escaped the viewport",
  );
  const dialogBody =
    roomDialog()!.querySelector<HTMLElement>(
      '[data-slot="dialog-body"]',
    )!;
  assert(
    dialogBody.scrollWidth <= dialogBody.clientWidth + 1,
    "room settings body overflowed horizontally",
  );
  await closeRoomSettings();
  click("meeting.audio_devices");
  await until(
    () =>
      document.querySelector<HTMLButtonElement>(
        `[role="combobox"][aria-label="${t("meeting.microphone_device")}"]`,
      )?.dataset.deviceId === "mic-2",
    "room selection shared with toolbar",
  );
  await selectDevice("meeting.microphone_device", "");
  click("meeting.close_device_menu");
  scenarios.push(
    "room dialog information and shared device preferences without automatic capture",
  );

  await showConversations();
  const work = [
    ...sidebar()!.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find((button) => button.textContent?.trim() === "Work");
  assert(work, "missing Work label");
  work.click();
  assert(
    conversationRows(historyRoom).length === 0,
    "label filter retained unrelated history",
  );
  input(
    '[data-slot="conversation-sidebar"] input',
    "Alice",
  );
  assert(
    conversationRows().length === 1 &&
      conversationRows(direct).length === 1,
    "search and label did not combine",
  );
  input('[data-slot="conversation-sidebar"] input', "");
  work.click();
  click("conversations.group_by_label");
  assert(
    conversationRows(room).length === 2,
    "multi-label room missing from one of its groups",
  );
  await frame();
  noOverflow("right panel conversation list");
  assert(
    sidebar()!.scrollHeight <= sidebar()!.clientHeight + 1,
    "conversation list expanded the panel instead of scrolling internally",
  );
  scenarios.push(
    "combined search and label filtering; multi-label grouping",
  );

  await selectConversation(direct);
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-chat-message="alice-private"]',
        ),
      ),
    "embedded direct conversation",
  );
  assert(
    location.pathname === "/video",
    "private conversation navigated away from meeting",
  );
  await checkChatScroll(
    "long private history in actual app shell",
  );
  await selectConversation(historyRoom);
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-slot="room-conversation"]',
        ),
      ) &&
      document.body.textContent!.includes(
        t("conversations.room_inactive"),
      ),
    "inactive room history",
  );
  await openRoomSettings();
  click("room_dialog.devices", "tab");
  assert(
    roomDialog()!.textContent?.includes(
      t("room_dialog.inactive_devices"),
    ) &&
      !roomDialog()!.querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      ),
    "historical room must not configure the active room's devices",
  );
  await closeRoomSettings();

  assert(
    appState.roomStatus.roomId === roomId &&
      leftCount === 0,
    "history selection changed current room",
  );
  await selectConversation(room);
  await until(
    () =>
      Boolean(
        document.querySelector(
          `textarea[aria-label="${t("conversations.room_message")}"]`,
        ),
      ),
    "current room composer",
  );
  input(
    `textarea[aria-label="${t("conversations.room_message")}"]`,
    "Ready to review — sending to everyone online.",
  );
  click("conversations.send");
  await until(
    () =>
      sentCount === 1 &&
      Boolean(
        document.querySelector(
          '[data-chat-message="sent-1"]',
        ),
      ),
    "room message send",
  );
  assert(
    stores.messages.filter(
      (message) => message.id === "sent-1",
    ).length === 1 && repository.messages.has("sent-1"),
    "room send duplicated or was not persisted",
  );
  scenarios.push(
    "embedded private and historical rooms preserve the meeting; one persisted room send",
  );

  const draftSelector = `textarea[aria-label="${t("conversations.room_message")}"]`;
  input(
    draftSelector,
    "Keep this draft while sharing a binary file.",
  );
  const picker = document.querySelector<HTMLInputElement>(
    '[data-slot="chat-composer"] input[data-attachment="file"]',
  )!;
  const selection = new DataTransfer();
  selection.items.add(attachment);
  picker.files = selection.files;
  picker.dispatchEvent(
    new Event("change", { bubbles: true }),
  );
  await until(
    () =>
      sentFiles === 1 &&
      Boolean(
        document.querySelector(
          '[data-chat-message="sent-file-1"]',
        ),
      ),
    "room file metadata offer",
  );
  assert(
    sentCount === 1 &&
      document.querySelector<HTMLTextAreaElement>(
        draftSelector,
      )?.value ===
        "Keep this draft while sharing a binary file.",
    "attaching a file sent or cleared the text draft",
  );
  assert(
    requestedFiles === 0 && tasks.tasks().length === 0,
    "publishing metadata started a binary task",
  );
  const sentFileCard = document.querySelector<HTMLElement>(
    '[data-chat-message="sent-file-1"]',
  )!;
  assert(
    !sentFileCard.querySelector(
      "[data-transfer-recipient]",
    ),
    "sender bubble exposed the download list",
  );
  sentFileCard
    .querySelector<HTMLButtonElement>(
      `button[aria-label="${t("conversations.room_file_details")}"]`,
    )!
    .click();
  await until(
    () => !!document.querySelector('[role="dialog"]'),
    "file transfer details dialog",
  );
  const fileDetails = document.querySelector<HTMLElement>(
    '[role="dialog"]',
  )!;
  assert(
    fileDetails.textContent?.includes(
      t("conversations.room_file_offer"),
    ),
    "empty file details lost the on-demand transfer explanation",
  );
  stores.updateTransferMessage("sent-file-1", (message) => {
    message.roomTransfers = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `recipient-${i}`,
        {
          status: i === 0 ? "complete" : "paused",
          progress: {
            received: i === 0 ? attachment.size : 2,
            total: attachment.size,
          },
        },
      ]),
    );
  });
  await until(
    () =>
      fileDetails.querySelectorAll(
        "[data-transfer-recipient]",
      ).length === 25,
    "live recipient details",
  );
  const fileDetailsBody =
    fileDetails.querySelector<HTMLElement>(
      '[data-slot="dialog-body"]',
    )!;
  assert(
    fileDetailsBody.scrollWidth <=
      fileDetailsBody.clientWidth + 1,
    "file details overflow horizontally",
  );
  assert(
    fileDetailsBody.scrollHeight >
      fileDetailsBody.clientHeight,
    "recipient list does not scroll inside the dialog",
  );
  assert(
    !sentFileCard.querySelector(
      "[data-transfer-recipient]",
    ),
    "opening details expanded the sender bubble",
  );
  [
    ...fileDetails.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ]
    .find(
      (button) => button.textContent?.trim() === "Close",
    )!
    .click();
  await until(
    () => !document.querySelector('[role="dialog"]'),
    "close file details",
  );
  assert(
    requestedFiles === 0,
    "viewing download details initiated a file transfer",
  );
  scenarios.push(
    "sender keeps download recipients in an on-demand details dialog with live progress and internal scrolling",
  );
  await stores.putRoomMessage(
    fileOffer("incoming-file", "alice", attachment),
  );
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-chat-message="incoming-file"]',
        ),
      ),
    "incoming file offer",
  );
  assert(
    requestedFiles === 0 &&
      !appState.cache.cacheInfo["file-incoming-file"],
    "rendering the file offer fetched binary bytes",
  );
  const incomingCard = document.querySelector<HTMLElement>(
    '[data-chat-message="incoming-file"] [data-slot="room-file-card"]',
  )!;
  stores.updateTransferMessage(
    "incoming-file",
    (message) => {
      message.transferStatus = "paused";
      message.progress = {
        received: 2,
        total: attachment.size,
      };
    },
  );
  await frame();
  const pausedHeight =
    incomingCard.getBoundingClientRect().height;
  setAppState("transfer", "transfers", "height-check", {
    id: "height-check",
    fileId: "file-incoming-file",
    messageId: "incoming-file",
    session: { clientId: "self", targetClientId: "alice" },
    transferer: { mode: TransferMode.Receive },
  } as unknown as ActiveFileTransfer);
  await until(
    () =>
      incomingCard
        .querySelector('[data-slot="file-transfer-status"]')
        ?.textContent?.includes("/s") === true,
    "speed replaces running status",
  );
  await frame();
  assert(
    Math.abs(
      incomingCard.getBoundingClientRect().height -
        pausedHeight,
    ) <= 1,
    "resuming added a speed line and changed bubble height",
  );
  setAppState(
    "transfer",
    "transfers",
    "height-check",
    undefined,
  );
  await frame();
  assert(
    Math.abs(
      incomingCard.getBoundingClientRect().height -
        pausedHeight,
    ) <= 1,
    "pausing changed bubble height",
  );
  stores.updateTransferMessage(
    "incoming-file",
    (message) => {
      message.transferStatus = undefined;
      message.progress = undefined;
    },
  );
  scenarios.push(
    "speed replaces the status in one line; pausing and resuming keep the same bubble height",
  );
  const transferButton = [
    ...incomingCard.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find((button) =>
    button.textContent?.includes(
      t("conversations.room_file_request"),
    ),
  );
  assert(
    transferButton && !transferButton.disabled,
    "uncached room file cannot be requested",
  );
  transferButton.click();
  await until(
    () =>
      requestedFiles === 1 &&
      incomingCard.textContent!.includes(
        t("common.action.download"),
      ),
    "explicit request offers local download",
  );
  assert(
    !incomingCard.textContent!.includes(
      t("conversations.room_file_request"),
    ),
    "completed file still offers binary transfer",
  );
  input(draftSelector, "");
  await checkChatScroll(
    "shared composer and room file metadata cards",
  );
  scenarios.push(
    "shared composer publishes binary metadata without sending its draft; received files transfer only after a click",
  );

  const photoSelection = new DataTransfer();
  photoSelection.items.add(photo);
  picker.files = photoSelection.files;
  picker.dispatchEvent(
    new Event("change", { bubbles: true }),
  );
  const outgoingPhoto = () =>
    document.querySelector<HTMLImageElement>(
      '[data-chat-message="sent-file-2"] img[alt="meeting-photo.svg"]',
    );
  await until(
    () =>
      !!outgoingPhoto()?.complete &&
      outgoingPhoto()!.naturalWidth === 320,
    "sender's local image preview",
  );
  assert(
    Number(requestedFiles) === 1,
    "sender image preview requested a transfer",
  );
  await stores.putRoomMessage(
    fileOffer("incoming-photo", "alice", photo),
  );
  const incomingPhoto = document.querySelector<HTMLElement>(
    '[data-chat-message="incoming-photo"]',
  )!;
  assert(
    incomingPhoto &&
      !incomingPhoto.querySelector(
        'img[alt="meeting-photo.svg"]',
      ),
    "receiver displayed image bytes before requesting them",
  );
  assert(
    !appState.cache.cacheInfo["file-incoming-photo"],
    "image offer created a cache before request",
  );
  const getPhoto = [
    ...incomingPhoto.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find((button) =>
    button.textContent?.includes(
      t("conversations.room_file_request"),
    ),
  )!;
  getPhoto.click();
  await until(() => {
    const image =
      incomingPhoto.querySelector<HTMLImageElement>(
        'img[alt="meeting-photo.svg"]',
      );
    return (
      requestedFiles === 2 &&
      !!image?.complete &&
      image.naturalWidth === 320
    );
  }, "receiver's image preview after explicit transfer");
  await checkChatScroll(
    "local image previews in room chat",
  );
  scenarios.push(
    "sender previews its local image immediately; receiver displays the image only after requesting bytes",
  );

  await checkMessageGallery(
    incomingPhoto.querySelector<HTMLAnchorElement>(
      "a[data-message-media]",
    )!,
  );
  await checkGalleryHistory(
    incomingPhoto.querySelector<HTMLAnchorElement>(
      "a[data-message-media]",
    )!,
  );
  click("meeting.members", "tab");
  location.hash =
    incomingPhoto.querySelector<HTMLAnchorElement>(
      "a[data-message-media]",
    )!.hash;
  await until(
    () =>
      !!(
        window as Window & {
          pswp?: import("photoswipe").default;
        }
      ).pswp?.opener.isOpen,
    "meeting media hash restores chat panel",
  );
  assert(
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.includes(t("meeting.chat")),
    "media deep link did not select the chat panel",
  );
  document
    .querySelector<HTMLButtonElement>(
      ".pswp__button--close",
    )!
    .click();
  await until(
    () =>
      !document.querySelector(".pswp") && !location.hash,
    "close a direct meeting hash preview",
  );
  scenarios.push(
    "media hash selects the meeting chat panel and supports slide changes, Back and Forward without transferring bytes",
  );
  const galleryVideo = await createGalleryVideo();
  const galleryAudio = createGalleryAudio();
  for (const media of [galleryVideo, galleryAudio]) {
    const picker = document.querySelector<HTMLInputElement>(
      '[data-slot="chat-composer"] input[data-attachment="file"]',
    )!;
    const selection = new DataTransfer();
    selection.items.add(media);
    picker.files = selection.files;
    picker.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    await until(
      () =>
        !!document.querySelector(
          `[data-chat-message="sent-file-${media === galleryVideo ? 3 : 4}"]`,
        ),
      "shared media bubble",
    );
  }
  const videoCard = document.querySelector<HTMLElement>(
    '[data-chat-message="sent-file-3"]',
  )!;
  const videoLink =
    videoCard.querySelector<HTMLAnchorElement>(
      "a[data-message-media]",
    )!;
  await until(
    () => videoLink.dataset.pswpWidth === "160",
    "video thumbnail metadata",
  );
  await until(
    () =>
      (videoLink.querySelector<HTMLImageElement>(
        "img[data-media-thumbnail]",
      )?.naturalWidth ?? 0) > 0,
    "local video poster",
  );
  await checkMessageGallery(videoLink, true);
  const audio = document.querySelector<HTMLAudioElement>(
    '[data-chat-message="sent-file-4"] audio',
  )!;
  await until(
    () =>
      Number.isFinite(audio.duration) && audio.duration > 0,
    "audio metadata",
  );
  assert(
    audio.controls && audio.paused,
    "audio bubble should expose native controls without autoplay",
  );
  assert(
    Number(requestedFiles) === 2,
    "local media preview requested remote bytes",
  );
  await checkChatScroll(
    "shared PhotoSwipe video and audio bubbles",
  );
  scenarios.push(
    "group image and video open in PhotoSwipe with local download; audio decodes with native controls",
  );

  click("meeting.members", "tab");
  assert(
    document.querySelectorAll(".meeting-member").length ===
      4,
    "member tab missing participants",
  );
  click("meeting.info", "tab");
  assert(
    document.body.textContent?.includes(
      t("meeting.local_history"),
    ),
    "room history semantics missing",
  );
  click("meeting.chat", "tab");
  await checkGridResizing();
  scenarios.push(
    "grid stays stable and fits both dimensions through repeated container resizing, source changes and panel toggles",
  );
  await checkFocusedThumbnails();
  scenarios.push(
    "focus picture fits available height; thumbnails scroll independently",
  );
  click("meeting.enable_microphone");
  await until(
    () => local.stream()?.getAudioTracks().length === 1,
    "microphone enable",
  );
  click("meeting.mute_microphone");
  click("meeting.enable_camera");
  await until(
    () => Boolean(local.stream()?.getVideoTracks().length),
    "camera enable",
  );
  let cameraTrack = local.stream()!.getVideoTracks()[0];
  click("meeting.share_screen");
  await until(
    () => local.stream()?.getVideoTracks().length === 2,
    "camera and first screen coexist",
  );
  const firstScreen = local
    .stream()!
    .getVideoTracks()
    .find((track) => track !== cameraTrack)!;
  click("meeting.add_sharing");
  await until(
    () => local.stream()?.getVideoTracks().length === 3,
    "camera and two screens coexist",
  );
  const secondScreen = local
    .stream()!
    .getVideoTracks()
    .find(
      (track) =>
        track !== cameraTrack && track !== firstScreen,
    )!;
  assert(
    cameraTrack.readyState === "live" &&
      local
        .stream()!
        .getVideoTracks()
        .includes(cameraTrack),
    "sharing replaced or stopped the camera",
  );
  assert(
    document.querySelectorAll(
      '.meeting-tile[data-source-local="true"]',
    ).length === 3,
    "local camera and screens did not render as independent tiles",
  );
  assert(
    microphoneTrack()?.enabled === false &&
      local.stream()?.getAudioTracks().length === 3 &&
      displayCaptures.every(
        ({ audio }) =>
          audio.enabled && audio.readyState === "live",
      ),
    "adding screen sources changed microphone mute",
  );
  const sharingStatus = () =>
    document.querySelector<HTMLElement>(
      ".meeting-header-actions .meeting-sharing-status",
    );
  assert(
    sharingStatus()?.dataset.sharingCount === "2" &&
      !document.querySelector(
        ".meeting-share-status, .meeting-media-error",
      ),
    "sharing status must be a pill in the right header actions rather than a stage banner",
  );
  assert(
    sharingStatus()!.getBoundingClientRect().right <=
      document
        .querySelector<HTMLElement>(
          ".meeting-header .meeting-member-count",
        )!
        .getBoundingClientRect().left,
    "sharing pill must precede the member button on the right",
  );
  noOverflow("camera and two shared screens");
  setPermission("camera", "denied");
  await until(
    () => !permissionEntry(),
    "denied camera hides permission entry while screen sharing",
  );
  setPermission("camera", "granted");
  await until(
    () => !permissionEntry(),
    "header clears after permission is restored",
  );
  setAppState(
    "profile",
    "name",
    "Alex Chen / Design team / Long presenter name",
  );
  await frame();
  noOverflow("long presenter in compact sharing header");
  assert(
    sharingStatus()!.querySelector<HTMLElement>(
      ".meeting-sharing-presenter",
    )!.clientWidth > 0,
    "compact sharing header hid the presenter entirely",
  );
  setAppState("profile", "name", "Alex Chen");
  const originalMicrophone = microphoneTrack()!;
  const streamBeforeSettings = local.stream();
  const capturesBeforeActiveSettings =
    captureRequests.length;
  await openRoomSettings();
  click("room_dialog.devices", "tab");
  await selectDevice("meeting.microphone_device", "mic-2");
  await selectDevice("meeting.camera_device", "camera-2");
  assert(
    captureRequests.length ===
      capturesBeforeActiveSettings &&
      local.stream() === streamBeforeSettings &&
      !originalMicrophone.enabled &&
      cameraTrack.enabled &&
      [
        originalMicrophone,
        cameraTrack,
        firstScreen,
        secondScreen,
      ].every((track) => track.readyState === "live"),
    "settings selection changed active camera, muted microphone or shared screens",
  );
  await closeRoomSettings();
  scenarios.push(
    "settings only save device preferences while current camera, muted microphone and two screens keep their tracks",
  );
  const stageBeforeDevices = document
    .querySelector(".meeting-stage")!
    .getBoundingClientRect();
  const hadChatPanel = Boolean(
    document.querySelector("#meeting-side-panel"),
  );
  click("meeting.audio_devices");
  await selectDevice("meeting.microphone_device", "mic-2");
  await until(
    () => microphoneTrack() !== originalMicrophone,
    "microphone device change",
  );
  assert(
    originalMicrophone.readyState === "ended" &&
      microphoneTrack()?.enabled === false &&
      displayCaptures.every(
        ({ audio }) =>
          audio.enabled && audio.readyState === "live",
      ),
    "microphone selection must stop only the old microphone and preserve mute",
  );
  await selectDevice("meeting.speaker_device", "speaker-2");
  await until(
    () => outputSelections.includes("speaker-2"),
    "audio output device selection",
  );
  const deviceMenu = document.querySelector<HTMLElement>(
    "#meeting-device-menu",
  )!;
  const menuBounds = deviceMenu.getBoundingClientRect();
  const stageWithDevices = document
    .querySelector(".meeting-stage")!
    .getBoundingClientRect();
  assert(
    menuBounds.left >= 0 &&
      menuBounds.right <= innerWidth &&
      menuBounds.top >= 0 &&
      Math.abs(
        stageBeforeDevices.height - stageWithDevices.height,
      ) <= 1,
    "device menu must overlay the stage without resizing or escaping viewport",
  );
  noOverflow("audio device menu");
  deviceMenu.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }),
  );
  assert(
    !document.querySelector("#meeting-device-menu") &&
      Boolean(
        document.querySelector("#meeting-side-panel"),
      ) === hadChatPanel,
    "Escape must close only the device menu, preserving the chat panel",
  );
  click("meeting.camera_devices");
  const previousCamera = cameraTrack;
  await selectDevice("meeting.camera_device", "camera-2");
  await until(
    () =>
      !local
        .stream()!
        .getVideoTracks()
        .includes(previousCamera),
    "camera device change",
  );
  cameraTrack = local
    .stream()!
    .getVideoTracks()
    .find(
      (track) =>
        track !== firstScreen && track !== secondScreen,
    )!;
  assert(
    previousCamera.readyState === "ended" &&
      cameraTrack.readyState === "live" &&
      firstScreen.readyState === "live" &&
      secondScreen.readyState === "live" &&
      local
        .stream()!
        .getVideoTracks()
        .includes(firstScreen) &&
      local
        .stream()!
        .getVideoTracks()
        .includes(secondScreen),
    "camera selection must preserve both existing screen tracks",
  );
  assert(
    captureRequests.some(
      (request) =>
        typeof request.audio === "object" &&
        typeof request.audio.deviceId === "object" &&
        !Array.isArray(request.audio.deviceId) &&
        request.audio.deviceId.exact === "mic-2",
    ) &&
      captureRequests.some(
        (request) =>
          typeof request.video === "object" &&
          typeof request.video.deviceId === "object" &&
          !Array.isArray(request.video.deviceId) &&
          request.video.deviceId.exact === "camera-2",
      ),
    "device menus did not request the selected exact capture device IDs",
  );
  document
    .querySelector(".meeting-stage")!
    .dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
  assert(
    !document.querySelector("#meeting-device-menu"),
    "outside click did not dismiss the device menu",
  );
  scenarios.push(
    "device menus overlay the stage; exact capture device selection preserves other sources and mute; output selection",
  );
  const localTile = (track: MediaStreamTrack) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.meeting-tile[data-source-local="true"]',
      ),
    ].find((tile) => tile.dataset.trackId === track.id)!;
  const secondTile = localTile(secondScreen);
  assert(secondTile, "second screen tile is missing");
  const pin = [
    ...secondTile.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find(
    (button) =>
      button.getAttribute("aria-label") ===
      t("meeting.pin"),
  );
  assert(pin, "second screen pin action is missing");
  pin.click();
  await checkFocusLayout(
    "simultaneous camera and screen focus",
  );
  const firstTile = localTile(firstScreen);
  assert(firstTile, "first screen tile is missing");
  const stop = [
    ...firstTile.querySelectorAll<HTMLButtonElement>(
      "button",
    ),
  ].find(
    (button) =>
      button.getAttribute("aria-label") ===
      t("meeting.stop_source", {
        name: firstTile.getAttribute("aria-label"),
      }),
  );
  assert(stop, "individual screen stop action is missing");
  stop.click();
  await until(
    () => local.stream()?.getVideoTracks().length === 2,
    "only selected screen closes",
  );
  assert(
    String(firstScreen.readyState) === "ended" &&
      displayCaptures.find(
        ({ video }) => video === firstScreen,
      )?.audio.readyState === "ended" &&
      displayCaptures.find(
        ({ video }) => video === secondScreen,
      )?.audio.readyState === "live" &&
      secondScreen.readyState === "live" &&
      cameraTrack.readyState === "live",
    "closing one screen affected another capture source",
  );
  assert(
    sharingStatus()?.dataset.sharingCount === "1",
    "header sharing count did not track independent source stop",
  );
  assert(
    local
      .stream()!
      .getVideoTracks()
      .includes(cameraTrack) &&
      local
        .stream()!
        .getVideoTracks()
        .includes(secondScreen),
    "remaining sources changed identity after closing a screen",
  );
  await checkFocusLayout(
    "remaining focused screen survives another screen closing",
  );
  click("meeting.stop_sharing");
  await until(
    () => local.stream()?.getVideoTracks().length === 1,
    "all screens stopped independently of camera",
  );
  assert(
    local.stream()!.getVideoTracks()[0] === cameraTrack &&
      cameraTrack.readyState === "live",
    "stopping screens replaced or stopped the original camera",
  );
  assert(
    microphoneTrack()?.enabled === false &&
      local.stream()?.getAudioTracks().length === 1 &&
      displayCaptures.every(
        ({ audio }) => audio.readyState === "ended",
      ),
    "stopping shared screens changed microphone mute",
  );
  assert(
    !sharingStatus() &&
      document
        .querySelector(".meeting-heading")
        ?.textContent?.includes(roomId),
    "stopping from the sharing pill left stale status or lost the room heading",
  );
  await checkFocusLayout(
    "closing pinned source keeps focus layout",
  );
  assert(
    document.querySelector<HTMLElement>(
      ".meeting-tile.is-featured",
    )?.dataset.trackId === cameraTrack.id,
    "closing the pinned screen did not focus a remaining live source",
  );
  scenarios.push(
    "optional screen audio publishes independently of microphone mute; stopping one or all screens cleans up their audio and preserves other sources",
  );

  const published = local.stream();
  navigate("/");
  await until(
    () => Boolean(sidebar()),
    "home conversation list",
  );
  conversationRows(room)[0]
    .querySelector<HTMLButtonElement>("button")!
    .click();
  await until(
    () =>
      location.pathname.startsWith("/conversation/") &&
      Boolean(
        document.querySelector(
          '[data-chat-message="sent-1"]',
        ),
      ),
    "encoded room conversation route",
  );
  assert(
    decodeURIComponent(
      location.pathname.slice("/conversation/".length),
    ) === room,
    "room URL identity changed",
  );
  assert(
    !document.querySelector('[data-testid="meeting-page"]'),
    "meeting did not unmount on home navigation",
  );
  assert(
    local.stream() === published &&
      published!
        .getTracks()
        .every((track) => track.readyState === "live"),
    "navigation interrupted published media",
  );
  navigate("/");
  await until(
    () => Boolean(sidebar()),
    "home direct conversation list",
  );
  conversationRows(direct)[0]
    .querySelector<HTMLButtonElement>("button")!
    .click();
  await until(
    () =>
      location.pathname.startsWith("/conversation/") &&
      Boolean(
        document.querySelector(
          '[data-chat-message="alice-private"]',
        ),
      ),
    "encoded direct conversation route",
  );
  navigate("/video");
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-testid="meeting-page"]',
        ),
      ),
    "return to meeting route",
  );
  if (!document.querySelector("#meeting-side-panel"))
    click("meeting.show_panel");
  await until(
    () =>
      Boolean(
        document.querySelector(
          '[data-chat-message="sent-1"]',
        ),
      ),
    "room chat on return",
  );
  assert(
    local.stream() === published && leftCount === 0,
    "return changed room or local media",
  );
  scenarios.push(
    "actual Home sidebar routes decode JSON and URL namespaces; returning preserves media",
  );

  // A narrow parent also exercises min-width handling in the desktop branch;
  // the runner separately repeats this fixture at a real 390px viewport.
  const shell = document.querySelector<HTMLElement>(
    "#meeting-test-shell",
  )!;
  if (innerWidth >= 1100) {
    click("meeting.hide_panel");
    shell.style.width = "390px";
    await frame();
    await frame();
    assert(
      shell
        .querySelector<HTMLElement>("main")!
        .getBoundingClientRect().width <= 391,
      "narrow parent overflowed",
    );
    shell.style.width = "";
    click("meeting.show_panel");
  }
  if (innerWidth < 768) {
    await showConversations();
    await selectConversation(room);
    assert(
      !sidebar(),
      "mobile conversation selection did not switch to chat",
    );
    const panel = document
      .querySelector<HTMLElement>("#meeting-side-panel")!
      .getBoundingClientRect();
    assert(
      panel.left >= 0 && panel.right <= innerWidth,
      "mobile panel escaped viewport",
    );
  }
  await frame();
  await frame();
  noOverflow("final layout");
  assert(
    location.pathname === "/video" && leftCount === 0,
    "meeting route or room unexpectedly changed",
  );
  scenarios.push(
    "responsive panels and viewport containment",
  );
  // Leave the new multi-source focus view visible for the runner's screenshot.
  click("meeting.share_screen");
  await until(
    () => local.stream()?.getVideoTracks().length === 2,
    "snapshot first shared source",
  );
  click("meeting.add_sharing");
  await until(
    () => local.stream()?.getVideoTracks().length === 3,
    "snapshot second shared source",
  );
  const snapshotScreen = local
    .stream()!
    .getVideoTracks()[2];
  localTile(snapshotScreen)
    .querySelector<HTMLButtonElement>(
      `button[aria-label="${t("meeting.pin")}"]`,
    )!
    .click();
  if (innerWidth < 768) click("meeting.hide_panel");
  await checkFocusLayout("final multi-source focus layout");
  click("meeting.audio_devices");
  await until(
    () =>
      !document.querySelector<HTMLButtonElement>(
        `[role="combobox"][aria-label="${t("meeting.microphone_device")}"]`,
      )?.disabled,
    "reopened device options",
  );
  await frame();
  assert(
    document.querySelector<HTMLButtonElement>(
      `[role="combobox"][aria-label="${t("meeting.microphone_device")}"]`,
    )?.dataset.deviceId === "mic-2" &&
      document.querySelector<HTMLButtonElement>(
        `[role="combobox"][aria-label="${t("meeting.speaker_device")}"]`,
      )?.dataset.deviceId === "speaker-2",
    "reopening device menu did not display the selected microphone/output",
  );
  noOverflow("final expanded audio device menu");

  (window as any).__MEETING_OPEN_ROOM_SETTINGS__ =
    async () => {
      if (document.querySelector("#meeting-device-menu"))
        click("meeting.close_device_menu");
      document
        .querySelector<HTMLButtonElement>(
          ".meeting-heading",
        )!
        .click();
      await until(
        () => !!roomDialog(),
        "snapshot room dialog",
      );
      click("room_dialog.devices", "tab");
      await until(
        () =>
          !!roomDialog()!.querySelector<HTMLButtonElement>(
            '[role="combobox"]',
          ),
        "snapshot room devices",
      );
      await Promise.all(
        roomDialog()!
          .getAnimations({ subtree: true })
          .map((animation) =>
            animation.finished.catch(() => {}),
          ),
      );
      await frame();
      const body = roomDialog()!.querySelector<HTMLElement>(
        '[data-slot="dialog-body"]',
      )!;
      assert(
        body.scrollWidth <= body.clientWidth + 1,
        "snapshot room dialog horizontal overflow",
      );
    };
  (window as any).__SPEED_TEST_REPORT__ = {
    ok: true,
    width: innerWidth,
    scenarios,
    sentCount,
    sentFiles,
    requestedFiles,
    localPersistenceVerified: true,
    realMeetingComponents: true,
    mediaSource: "synthetic native MediaStream tracks",
    networkSignalingUsed: false,
  };
  // Keep the final real UI mounted for the runner's desktop/mobile screenshots.
}
main().catch((error) => {
  console.error(error);
  (window as any).__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
