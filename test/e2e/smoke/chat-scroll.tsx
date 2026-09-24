import { createRoot, type ParentProps } from "solid-js";
import { render } from "solid-js/web";
import {
  Route,
  Router,
  useNavigate,
} from "@solidjs/router";
import { ModalProvider } from "@/components/dialogs/base";
import Home from "../../support/chat-workspace";
import Chat from "../../support/direct-chat-page";
import { createTaskService } from "@/libs/application/task-service";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { StoreMessage } from "@/libs/domain/message";
import { setChatTestContext } from "./chat-context";
import { t } from "@/i18n";
import "@/global.css";
import {
  checkMessageGallery,
  checkGalleryHistory,
} from "./message-gallery";
import { mediaHash } from "@/components/conversations/media-hash-route";
import { directConversationId } from "@/libs/domain/conversation";

const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve()),
  );
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
async function until(check: () => boolean) {
  for (let i = 0; i < 180; i++) {
    if (check()) return;
    await frame();
  }
  throw new Error(
    `Chat UI condition did not settle after ${scenarios.at(-1)?.name}; path=${location.pathname}${location.hash}; rows=${rows().length}; media=${document.querySelectorAll("a[data-message-media]").length}; viewer=${!!document.querySelector(".pswp")}`,
  );
}
const viewport = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="chat-viewport"]',
  )!;
const rows = () => [
  ...document.querySelectorAll<HTMLElement>(
    "[data-chat-message]",
  ),
];
const gap = () =>
  Math.max(
    0,
    viewport().scrollHeight -
      viewport().clientHeight -
      viewport().scrollTop,
  );
const ready = () =>
  viewport()
    ?.querySelector("ul")
    ?.getAttribute("aria-busy") === "false";
const firstVisible = () =>
  rows().find(
    (row) =>
      row.getBoundingClientRect().bottom >
      viewport().getBoundingClientRect().top,
  )!;
const offset = (element: HTMLElement) =>
  element.getBoundingClientRect().top -
  viewport().getBoundingClientRect().top;
const scenarios: {
  name: string;
  maxGap: number;
  finalGap: number;
}[] = [];
const reducedMotion = matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const snapshot = new URLSearchParams(location.search).has(
  "snapshot",
);
const animations: {
  name: string;
  intermediatePositions: number;
}[] = [];
async function checkSmooth(
  name: string,
  action: () => void,
  during?: () => void,
) {
  const before = viewport().scrollTop;
  action();
  const samples = new Set<number>();
  let changed = false;
  if (!reducedMotion)
    assert(
      gap() > 1,
      `${name}: jumped instead of animating`,
    );
  for (let i = 0; i < 180; i++) {
    await frame();
    if (gap() <= 1) break;
    if (viewport().scrollTop > before + 1) {
      samples.add(Math.round(viewport().scrollTop));
      if (during && !changed) {
        changed = true;
        during();
      }
    }
  }
  if (!reducedMotion)
    assert(
      samples.size > 1,
      `${name}: no intermediate animation positions`,
    );
  else
    assert(
      samples.size === 0,
      `${name}: ignored reduced motion`,
    );
  if (during && !reducedMotion)
    assert(
      changed,
      `${name}: layout change was not exercised`,
    );
  animations.push({
    name,
    intermediatePositions: samples.size,
  });
  await checkBottom(name);
}
// rAF runs before layout observers. A late image can change height in that
// phase, even though the controller corrects it before paint. Register this
// observer after the controller and measure after its layout correction.
function bottomGapAfterLayout(): Promise<number> {
  return new Promise((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve(gap());
    });
    observer.observe(viewport());
  });
}

async function checkBottom(name: string) {
  await until(ready);
  await frame();
  await frame();
  let maxGap = 0;
  for (let i = 0; i < 8; i++) {
    await frame();
    maxGap = Math.max(maxGap, await bottomGapAfterLayout());
  }
  assert(
    maxGap <= 2 && gap() <= 1,
    `${name}: peak gap ${maxGap}, final gap ${gap()}, scrollHeight ${viewport().scrollHeight}, clientHeight ${viewport().clientHeight}, scrollTop ${viewport().scrollTop}`,
  );
  assert(
    viewport().clientHeight > 100,
    `${name}: collapsed scrollport`,
  );
  assert(
    document.documentElement.scrollHeight <=
      window.innerHeight + 1,
    `${name}: chat made document scroll`,
  );
  scenarios.push({ name, maxGap, finalGap: gap() });
}
function message(
  client: string,
  index: number,
): StoreMessage {
  return {
    id: `${client}-${index}`,
    type: "text",
    client,
    target: "self",
    createdAt: index + 1,
    status: "received",
    data: `Message ${index}: A longer conversation message to exercise line wrapping when the sidebar and font metrics change. `.repeat(
      2,
    ),
  };
}
let navigate!: ReturnType<typeof useNavigate>;
function Shell(props: ParentProps) {
  navigate = useNavigate();
  return (
    <ModalProvider>
      <div
        id="chat-test-shell"
        class="flex h-full min-h-full w-full flex-col md:flex-row"
      >
        <div
          class="h-[var(--mobile-header-height)]
            w-[var(--desktop-header-width)] shrink-0"
        >
          Nav
        </div>
        <div class="min-w-0 flex-1">{props.children}</div>
      </div>
    </ModalProvider>
  );
}

async function main() {
  let disposeTasks!: () => void;
  const tasks = createRoot((dispose) => {
    disposeTasks = dispose;
    return createTaskService({
      clientId: () => "self",
      messages: () => appState.message.messages,
      caches: () => appState.cache.cacheInfo,
      transfers: () => ({}),
    });
  });
  const unexpected = async () => {
    throw new Error(
      "Unexpected network/file operation in chat smoke test",
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
    }),
    startSpeedTest: unexpected,
    cancelSpeedTest: () => {},
    approveSpeedTest: () => {},
    declineSpeedTest: () => {},
    localStream: () => null,
    replaceLocalStream: () => {},
    clearLocalStream: () => {},
    joinRoom: unexpected,
    roomConflict: () => false,
    leaveRoom: () => {},
    activeRoomConversationId: () => null,
    roomChatCapabilities: () => ({}),
    roomFileCapabilities: () => ({}),
    sendRoomFile: async () => {},
    requestRoomFile: async () => {},
    sendRoomText: unexpected,
    requestFile: unexpected,
    sendText: unexpected,
    sendFile: unexpected,
    sendClipboard: unexpected,
    sharedFiles: {
      download: async () => {},
      downloadTask: () => undefined,
    },
    supportsSharedFiles: () => false,
    catalog: {
      watch: () => {
        throw new Error("Unexpected directory query");
      },
    },
    retryMessage: unexpected,
    shareFile: unexpected,
    resumeFile: unexpected,
    pauseFile: unexpected,
    roomStatus: {
      roomId: null,
      profile: null,
      joinedAt: null,
    },
  });
  setAppState("profile", "clientId", "self");
  setAppState("options", "locale", "en-us");
  setAppState("options", "redirectToClient", undefined);
  setAppState("message", "clients", [
    { clientId: "peer", name: "Peer", avatar: null },
    { clientId: "other", name: "Other", avatar: null },
  ]);
  const initial = [
    ...Array.from({ length: 60 }, (_, i) =>
      message("peer", i),
    ),
    ...Array.from({ length: 40 }, (_, i) =>
      message("other", i),
    ),
  ];
  initial[48] = {
    id: "peer-48",
    type: "file",
    client: "peer",
    target: "self",
    createdAt: 49,
    status: "received",
    transferStatus: "complete",
    fid: "portrait",
    fileName: "portrait.svg",
    fileSize: 100,
    chunkSize: 100,
  };
  setAppState("message", "messages", initial);
  setAppState("message", "status", "ready");
  window.history.replaceState({}, "", "/client/peer/chat");
  const unmount = render(
    () => (
      <Router root={Shell}>
        <Route path="/" component={Home}>
          <Route path="/client/:id/chat" component={Chat} />
          <Route
            path="/client/:id/sync"
            component={() => <div>Sync fixture</div>}
          />
          <Route
            path="/"
            component={() => <div>Home fixture</div>}
          />
        </Route>
      </Router>
    ),
    document.getElementById("root")!,
  );
  try {
    await checkBottom("initial real chat and sidebar");
    assert(
      rows().length === 20,
      "initial history loaded extra pages",
    );
    assert(
      document.querySelectorAll(
        '[data-slot="chat-time-separator"]',
      ).length === 1 &&
        rows()[0].dataset.group === "start" &&
        rows().at(-1)?.dataset.group === "end",
      "initial same-sender history did not form one time block and compact group",
    );
    assert(
      rows().filter((row) =>
        row.querySelector('[data-slot="message-meta"]'),
      ).length === 1,
      "repeated timestamps were not compressed",
    );
    const compactGap =
      rows()[1].getBoundingClientRect().top -
      rows()[0].getBoundingClientRect().bottom;
    assert(
      compactGap >= 0 && compactGap <= 5,
      "consecutive bubbles are not tightly spaced",
    );
    assert(
      !document.querySelector(".animate-message"),
      "historical message animated",
    );

    navigate("/client/other/chat");
    await until(
      () =>
        rows().at(-1)?.dataset.chatMessage === "other-39",
    );
    await checkBottom(
      "router navigation and document reset",
    );

    setAppState("message", "status", "initializing");
    navigate("/client/peer/chat");
    await until(() => !!viewport() && !ready());
    await frame();
    setAppState("message", "status", "ready");
    await checkBottom("asynchronous hydration");

    await document.fonts.ready;
    document.documentElement.style.fontSize = "19px";
    await checkBottom("font metrics and text wrapping");
    document.documentElement.style.fontSize = "";
    await checkBottom("font size restored");

    const shell = document.getElementById(
      "chat-test-shell",
    )!;
    shell.style.width = "82%";
    await checkBottom("resizable parent width changes");
    shell.style.width = "";
    await checkBottom("resizable width restored");

    const file = new File(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="800"><rect width="240" height="800" fill="gray"/></svg>',
      ],
      "portrait.svg",
      { type: "image/svg+xml" },
    );
    setAppState("cache", "cacheInfo", "portrait", {
      id: "portrait",
      fileName: file.name,
      fileSize: file.size,
      chunkSize: file.size,
      mimetype: file.type,
      file,
      isComplete: true,
    });
    await until(
      () =>
        !!document.querySelector<HTMLImageElement>(
          'img[alt="portrait.svg"]',
        )?.complete,
    );
    await checkBottom(
      "late media hydration and aspect ratio change",
    );
    await checkMessageGallery(
      document.querySelector<HTMLAnchorElement>(
        "a[data-message-media]",
      )!,
    );
    await checkGalleryHistory(
      document.querySelector<HTMLAnchorElement>(
        "a[data-message-media]",
      )!,
    );
    viewport().scrollTop = viewport().scrollHeight;
    viewport().dispatchEvent(new Event("scroll"));
    await checkBottom(
      "return to bottom after private media preview and history navigation",
    );

    setAppState("session", "clientViewData", "peer", {
      clientId: "peer",
      name: "Peer",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    await until(() => !!document.querySelector("textarea"));
    await checkBottom("composer appears after connecting");
    const input = document.querySelector("textarea")!;
    input.value = "Expanded composer\n".repeat(6);
    input.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    await checkBottom("composer grows");
    input.value = "";
    input.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    await checkBottom("composer shrinks");

    viewport().scrollTop = viewport().scrollHeight / 2;
    await frame();
    await frame();
    const anchor = firstVisible();
    const before = offset(anchor);
    rows()[0].style.paddingTop = "180px";
    await frame();
    await frame();
    assert(
      Math.abs(offset(anchor) - before) <= 1,
      "late content shifted the reader's anchor",
    );
    setAppState("message", "messages", (messages) => [
      ...messages,
      message("peer", 60),
      message("peer", 61),
      message("peer", 62),
    ]);
    await frame();
    await frame();
    assert(
      Math.abs(offset(anchor) - before) <= 1,
      "incoming batch pulled the reader down",
    );
    assert(
      rows().length === 23,
      "batch messages were dropped or history was replaced",
    );

    const first = rows()[0];
    viewport().scrollTop = 0;
    const oldCount = rows().length;
    const oldOffset = offset(first);
    await until(() => rows().length > oldCount);
    await frame();
    await frame();
    assert(
      Math.abs(offset(first) - oldOffset) <= 1,
      "prepending history moved the visible message",
    );
    const bottomButton = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "button",
      ),
    ].find(
      (button) =>
        button.getAttribute("aria-label") ===
        t("client.scroll_to_bottom"),
    );
    assert(bottomButton, "missing return-to-bottom button");
    await checkSmooth(
      "return to bottom after reading and loading history",
      () => bottomButton!.click(),
    );
    await checkSmooth("smooth new message batch", () => {
      setAppState("message", "messages", (messages) => [
        ...messages,
        message("peer", 63),
        message("peer", 64),
      ]);
      const row = rows().at(-1)!;
      const bubble = row.querySelector<HTMLElement>(
        '[data-slot="message-bubble"]',
      )!;
      assert(
        getComputedStyle(row).transform === "none",
        "message animation moved its anchor row",
      );
      assert(
        getComputedStyle(bubble).animationName ===
          (reducedMotion ? "none" : "messageIn"),
        "new bubble did not respect the motion preference",
      );
    });
    await checkSmooth(
      "retarget while new message scroll is running",
      () => {
        setAppState("message", "messages", (messages) => [
          ...messages,
          message("peer", 65),
        ]);
      },
      () => {
        rows()[0].style.paddingTop = "280px";
      },
    );

    if (!reducedMotion) {
      viewport().scrollTop = viewport().scrollHeight / 2;
      await frame();
      await frame();
      const button =
        document.querySelector<HTMLButtonElement>(
          `button[aria-label="${t("client.scroll_to_bottom")}"]`,
        )!;
      const start = viewport().scrollTop;
      button.click();
      await until(
        () =>
          viewport().scrollTop > start + 2 && gap() > 200,
      );
      viewport().dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -120,
          bubbles: true,
        }),
      );
      viewport().scrollTop -= 40;
      viewport().dispatchEvent(new Event("scroll"));
      const stoppedAt = viewport().scrollTop;
      setAppState("message", "messages", (messages) => [
        ...messages,
        message("peer", 66),
      ]);
      for (let i = 0; i < 12; i++) await frame();
      assert(
        Math.abs(viewport().scrollTop - stoppedAt) <= 1,
        "animation resumed after reader interruption",
      );
      await checkSmooth(
        "return after user interruption",
        () => {
          document
            .querySelector<HTMLButtonElement>(
              `button[aria-label="${t("client.scroll_to_bottom")}"]`,
            )!
            .click();
        },
      );
    }

    for (const row of rows()) {
      const bubble = row.querySelector<HTMLElement>(
        '[data-slot="message-bubble"]',
      )!;
      assert(
        bubble.getBoundingClientRect().width <=
          row.getBoundingClientRect().width * 0.89 + 1,
        "bubble exceeded its responsive width",
      );
    }
    assert(
      viewport().scrollWidth <= viewport().clientWidth + 1,
      "message content caused horizontal scrolling",
    );

    const pausedAt =
      appState.message.messages.at(-1)!.createdAt +
      5 * 60000;
    await checkSmooth(
      "time separator after a five-minute pause",
      () => {
        setAppState("message", "messages", (messages) => [
          ...messages,
          { ...message("peer", 67), createdAt: pausedAt },
        ]);
      },
    );
    const groupStart = rows().at(-1)!;
    assert(
      groupStart.dataset.group === "single",
      "long pause incorrectly joined the prior group",
    );
    assert(
      document.querySelectorAll(
        '[data-slot="chat-time-separator"]',
      ).length === 2,
      "missing time separator after a pause",
    );
    await checkSmooth(
      "smoothly extend a compact group",
      () => {
        setAppState("message", "messages", (messages) => [
          ...messages,
          {
            ...message("peer", 68),
            createdAt: pausedAt + 60000,
          },
        ]);
      },
    );
    assert(
      rows().at(-2) === groupStart,
      "extending a group remounted its preceding bubble",
    );
    assert(
      groupStart.dataset.group === "start" &&
        !groupStart.querySelector(
          '[data-slot="message-meta"]',
        ),
      "previous group tail retained repeated metadata",
    );
    assert(
      rows().at(-1)?.dataset.group === "end",
      "new message did not become the group tail",
    );
    const finalRow = rows().at(-1)!;
    setAppState("message", "messages", (messages) =>
      messages.filter(
        (message) => message.id !== "peer-67",
      ),
    );
    await checkBottom(
      "time boundary moves after deleting a group start",
    );
    assert(
      rows().at(-1) === finalRow &&
        finalRow.dataset.group === "single",
      "deleting a group start replaced the surviving bubble",
    );
    assert(
      document.querySelectorAll(
        '[data-slot="chat-time-separator"]',
      ).length === 2,
      "deletion left a stale or duplicate time separator",
    );

    for (let i = 0; i < 8; i++) {
      const peer = i % 2 ? "peer" : "other";
      navigate(`/client/${peer}/chat`);
      await until(
        () =>
          rows()[0]?.dataset.chatMessage?.startsWith(
            `${peer}-`,
          ) === true,
      );
      await checkBottom(
        `repeated conversation switch ${i + 1}`,
      );
    }
    navigate("/client/peer/sync");
    await until(() => !viewport());
    await frame();
    setAppState("message", "messages", (messages) =>
      messages.map((message) =>
        message.id === "peer-5"
          ? {
              ...message,
              type: "file" as const,
              fid: "portrait",
              fileName: file.name,
              fileSize: file.size,
              chunkSize: file.size,
              mimeType: file.type,
              transferStatus: "complete" as const,
            }
          : message,
      ),
    );
    const deepHash = mediaHash({
      conversationId: directConversationId("self", "peer"),
      messageId: "peer-5",
    });
    // A fresh conversation mount with a hash must reveal older, windowed-out media.
    setAppState(
      "cache",
      "cacheInfo",
      "portrait",
      "file",
      undefined,
    );
    navigate(`/client/peer/chat${deepHash}`);
    await until(() =>
      rows().some(
        (row) => row.dataset.chatMessage === "peer-5",
      ),
    );
    assert(
      !document.querySelector(".pswp"),
      "uncached deep link should not start a transfer or preview",
    );
    setAppState("cache", "cacheInfo", "portrait", {
      id: "portrait",
      fileName: file.name,
      fileSize: file.size,
      chunkSize: file.size,
      mimetype: file.type,
      file,
      isComplete: true,
    });
    await until(
      () =>
        !!(
          window as Window & {
            pswp?: import("photoswipe").default;
          }
        ).pswp?.opener.isOpen,
    );
    assert(
      location.hash === deepHash,
      "initial deep link changed message identity",
    );
    document
      .querySelector<HTMLButtonElement>(
        ".pswp__button--close",
      )!
      .click();
    await until(
      () =>
        !document.querySelector(".pswp") && !location.hash,
    );
    assert(
      location.pathname === "/client/peer/chat",
      "closing an initial deep link navigated away",
    );
    scenarios.push({
      name: "deep link reveals older media after local cache hydration without requesting bytes",
      maxGap: 0,
      finalGap: 0,
    });
    navigate("/client/peer/sync");
    await until(() => !viewport());
    if (snapshot) {
      document.documentElement.classList.toggle(
        "dark",
        matchMedia("(prefers-color-scheme: dark)").matches,
      );
      setAppState("message", "status", "initializing");
      const texts = [
        "连续发送的消息现在可以紧凑显示了。",
        "同一发送者、5 分钟内的相邻消息会自动归为一组。",
        "组内只在最后一条显示时间。",
        "这样能少占一些空间。",
        "发送中和失败状态也会保留。",
        "间隔达到 5 分钟后，会显示新的时间分隔。",
        "这里有更新后的设计说明。",
        "收到，这样更清楚 👍",
      ];
      const sentAt = new Date(
        2026,
        8,
        22,
        16,
        10,
      ).getTime();
      const seconds = [0, 15, 30, 45, 60, 600, 620, 640];
      const preview = texts.map(
        (data, index) =>
          ({
            ...message("peer", index),
            client: [3, 4, 7].includes(index)
              ? "self"
              : "peer",
            target: [3, 4, 7].includes(index)
              ? "peer"
              : "self",
            data,
            createdAt: sentAt + seconds[index] * 1000,
          }) as StoreMessage,
      );
      preview[6] = {
        id: "archive-preview",
        type: "file",
        client: "peer",
        target: "self",
        fileName: "消息分组与时间分隔设计说明.zip",
        fileSize: 128000,
        chunkSize: 64000,
        createdAt: sentAt + seconds[6] * 1000,
        status: "received",
        transferStatus: "paused",
      };
      setAppState("message", "messages", preview);
      navigate("/client/peer/chat");
      setAppState("message", "status", "ready");
      await checkBottom("bubble visual snapshot");
    }
    (window as any).__SPEED_TEST_REPORT__ = {
      ok: true,
      width: innerWidth,
      reducedMotion,
      animations,
      scenarios,
      readingAnchorPreserved: true,
      olderHistoryAnchorPreserved: true,
      batchedMessagesPreserved: true,
      compactGroupsVerified: true,
      timeSeparatorsVerified: true,
      groupIdentityPreserved: true,
    };
    if (snapshot) {
      await new Promise<void>((resolve) => {
        (window as any).__CHAT_TEST_FINISH_SNAPSHOT__ =
          resolve;
      });
    }
  } finally {
    unmount();
    disposeTasks();
  }
}
main().catch((error) => {
  console.error(error);
  (window as any).__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
