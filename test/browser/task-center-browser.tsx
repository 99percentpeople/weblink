import { createRoot, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { ModalProvider } from "@/components/dialogs/base";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { TaskCenter } from "@/components/app/task-center";
import {
  SpeedTestService,
  type SpeedTestState,
} from "@/libs/application/speed-test-service";
import { createTaskService } from "@/libs/application/task-service";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { PeerSession } from "@/libs/core/session";
import { setTaskTestContext } from "./task-context";
import { t } from "@/i18n";
import "@/global.css";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
async function until(
  check: () => boolean,
  timeout = 10000,
) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout)
      throw new Error("UI wait timed out");
    await sleep(25);
  }
}
const click = (key: string, role = "button") => {
  const text = String(t(key));
  const element = [
    ...document.querySelectorAll<HTMLElement>(
      role === "tab" ? '[role="tab"]' : "button",
    ),
  ].find(
    (item) =>
      item.getAttribute("aria-label") === text ||
      item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing ${role}: ${text}`);
  element.click();
};

async function main() {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const pendingA: RTCIceCandidate[] = [],
    pendingB: RTCIceCandidate[] = [];
  a.onicecandidate = (event) => {
    if (event.candidate) {
      if (b.remoteDescription)
        void b.addIceCandidate(event.candidate);
      else pendingB.push(event.candidate);
    }
  };
  b.onicecandidate = (event) => {
    if (event.candidate) {
      if (a.remoteDescription)
        void a.addIceCandidate(event.candidate);
      else pendingA.push(event.candidate);
    }
  };
  const [state, setState] = createSignal<SpeedTestState>({
    status: "idle",
    peerId: null,
  });
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
  let approve!: (allow: boolean) => void;
  const initiator = new SpeedTestService({
    getConnection: () => a,
    isBusy: () => false,
    approve: async () => true,
    onState: (value) => {
      setState(value);
      tasks.recordSpeedTest(value);
    },
  });
  const responder = new SpeedTestService({
    getConnection: () => b,
    isBusy: () => false,
    approve: () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    onState: () => {},
  });
  let remoteChat: RTCDataChannel | undefined;
  b.ondatachannel = (event) => {
    if (event.channel.protocol === "message")
      remoteChat = event.channel;
    else responder.handleChannel("self", b, event.channel);
  };
  const chat = a.createDataChannel("chat", {
    protocol: "message",
  });
  let unmount: (() => void) | undefined;
  let launcher!: ReturnType<typeof clientInfoDialog>;
  try {
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    for (const candidate of pendingB)
      await b.addIceCandidate(candidate);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    for (const candidate of pendingA)
      await a.addIceCandidate(candidate);
    await until(
      () =>
        chat.readyState === "open" &&
        remoteChat?.readyState === "open",
    );
    setAppState("profile", "clientId", "self");
    setAppState("options", "locale", "en-us");
    setAppState("session", "sessions", "peer", {
      peerConnection: a,
    } as PeerSession);
    setAppState("session", "clientViewData", "peer", {
      onlineStatus: "online",
      createdAt: Date.now(),
      messageChannel: true,
    } as any);
    setAppState("message", "clients", [
      {
        clientId: "peer",
        name: "Desktop peer",
        avatar: null,
      },
    ]);
    setAppState("message", "messages", [
      {
        id: "send",
        fid: "file-a",
        type: "file",
        fileName: "Project archive.zip",
        fileSize: 8 * 1024 * 1024,
        chunkSize: 512 * 1024,
        createdAt: Date.now() - 2000,
        client: "self",
        target: "peer",
        status: "received",
        transferStatus: "paused",
        progress: {
          total: 8 * 1024 * 1024,
          received: 2 * 1024 * 1024,
        },
      },
      {
        id: "receive",
        fid: "file-b",
        type: "file",
        fileName: "Shared notes.txt",
        fileSize: 256 * 1024,
        chunkSize: 512 * 1024,
        createdAt: Date.now() - 3000,
        client: "peer",
        target: "self",
        status: "received",
        transferStatus: "complete",
      },
    ]);
    const unexpected = async () => {
      throw new Error(
        "Unexpected file operation in diagnostic test",
      );
    };
    setTaskTestContext({
      tasks,
      getSpeedTestState: tasks.latestSpeedTest,
      speedTestState: state,
      startSpeedTest: (peer) => initiator.start(peer),
      cancelSpeedTest: (peer) => initiator.cancel(peer),
      approveSpeedTest: () => {},
      declineSpeedTest: () => {},
      joinRoom: unexpected,
      leaveRoom: () => initiator.cancel(),
      requestFile: unexpected,
      sendText: unexpected,
      sendFile: unexpected,
      sendClipboard: unexpected,
      requestStorage: unexpected,
      retryMessage: unexpected,
      shareFile: unexpected,
      resumeFile: unexpected,
      pauseFile: unexpected,
      roomStatus: { roomId: null, profile: null },
    });
    const [routeVisible, setRouteVisible] =
      createSignal(true);
    function Launcher() {
      launcher = clientInfoDialog();
      return (
        <button onClick={() => void launcher.open("peer")}>
          Open client
        </button>
      );
    }
    unmount = render(
      () => (
        <ModalProvider>
          <div class="bg-background text-foreground min-h-screen p-4">
            <h1 class="mb-4 text-lg font-semibold">
              Weblink · Task center
            </h1>
            <TaskCenter placement="right" />
            <Show when={routeVisible()}>
              <Launcher />
            </Show>
          </div>
        </ModalProvider>
      ),
      document.getElementById("root")!,
    );
    await sleep(100);
    void launcher.open("peer", "speed");
    await sleep(100);
    click("speed_test.start");
    await until(
      () =>
        !!approve && state().progress?.phase === "approval",
    );
    const id = state().id;
    click("common.client_info_dialog.tabs.raw", "tab");
    await sleep(50);
    assert(
      document.querySelector("textarea"),
      "raw tab missing",
    );
    click("common.client_info_dialog.tabs.session", "tab");
    launcher.close();
    setRouteVisible(false); // Dispose the route that created the dialog.
    await sleep(100);
    assert(
      state().status === "running" && state().id === id,
      "closing/unmounting cancelled the test",
    );
    click("tasks.title");
    await sleep(100);
    assert(
      document.querySelectorAll("table tbody tr").length >=
        3,
      "unified task list missing file/speed tasks",
    );
    assert(
      tasks.activeCount() === 1,
      "active count incorrect",
    );
    approve(true);
    await until(() => state().status !== "running", 30000);
    assert(
      state().status === "done",
      `background test failed: ${state().error}`,
    );
    const result = state().result;
    assert(
      result?.upload.bytes && result.download.bytes,
      "missing bidirectional receipts",
    );
    assert(
      tasks
        .tasks()
        .some(
          (task) =>
            task.kind === "speed-test" &&
            task.status === "completed",
        ),
      "result not retained in tasks",
    );
    click("tasks.inspect"); // First row: the recently finished speed test.
    await sleep(100);
    assert(
      document.querySelector(
        '[role="tab"][data-key="speed"]',
      ) ||
        document
          .querySelector(
            '[role="tab"][aria-selected="true"]',
          )
          ?.textContent?.includes(
            String(
              t("common.client_info_dialog.tabs.speed"),
            ),
          ),
      "inspect did not open speed tab",
    );
    assert(
      document.body.textContent?.includes("Mbps"),
      "result missing after reopening info",
    );
    click("speed_test.start");
    await until(
      () =>
        state().status === "running" &&
        state().progress?.phase === "approval",
    );
    // Escape closes the actual dialog without stopping the new run.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    await until(
      () => !document.querySelector('[role="dialog"]'),
    );
    assert(
      state().status === "running",
      "Escape cancelled the test",
    );
    click("tasks.title");
    await sleep(100);
    click("speed_test.cancel");
    await until(() => state().status === "cancelled");
    assert(
      tasks
        .tasks()
        .filter((task) => task.kind === "speed-test")
        .length === 2,
      "run history overwritten",
    );
    assert(
      chat.readyState === "open" &&
        remoteChat?.readyState === "open",
      "chat channel was closed",
    );
    let echoed = false;
    remoteChat!.onmessage = (event) => {
      if (event.data === "still connected") echoed = true;
    };
    chat.send("still connected");
    await until(() => echoed);
    await sleep(100);
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"]',
    );
    assert(
      dialog &&
        dialog.scrollWidth <= dialog.clientWidth + 1,
      "dialog overflows horizontally",
    );
    assert(
      document.documentElement.scrollWidth <=
        innerWidth + 1,
      "page overflows horizontally",
    );
    (window as any).__TASK_TEST_OPEN_SESSION__ =
      async () => {
        click("tasks.inspect");
        await sleep(100);
        click(
          "common.client_info_dialog.tabs.session",
          "tab",
        );
        await sleep(200);
      };
    (window as any).__SPEED_TEST_REPORT__ = {
      ok: true,
      browser: navigator.userAgent,
      viewportWidth: innerWidth,
      result,
      survivedTabSwitch: true,
      survivedDialogClose: true,
      survivedRouteUnmount: true,
      unifiedFileAndSpeedTasks: true,
      historyRetained: true,
      stoppedFromTaskList: true,
      chatUnaffected: true,
      noHorizontalOverflow: true,
    };
  } finally {
    initiator.dispose();
    responder.dispose();
    a.close();
    b.close();
    // Keep the final UI on screen for optional desktop/mobile screenshots.
    window.addEventListener(
      "pagehide",
      () => {
        unmount?.();
        disposeTasks();
      },
      { once: true },
    );
  }
}
main().catch((error) => {
  (window as any).__SPEED_TEST_ERROR__ = String(
    error.stack ?? error,
  );
  console.error(error);
});
