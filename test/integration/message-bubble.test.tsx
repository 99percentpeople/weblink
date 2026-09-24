// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type { ActiveFileTransfer } from "@/libs/application/transfer/file-transfer-state";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import { reconcile } from "solid-js/store";
import type {
  ComponentProps,
  JSX,
  ParentProps,
} from "solid-js";
import { createSignal } from "solid-js";
import {
  MessageContent,
  type MessageCardProps,
} from "@/routes/client/[id]/components/message";
import { ChatTimeSeparator } from "@/routes/client/[id]/components/chat-time-separator";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";

const {
  retryMessage,
  contextMenu,
  activeRoomConversationId,
  requestRoomFile,
  requestFile,
  resumeFile,
  pauseFile,
  previewFile,
  downloadFile,
} = vi.hoisted(() => ({
  retryMessage: vi.fn(),
  contextMenu: vi.fn(),
  requestRoomFile: vi.fn(),
  requestFile: vi.fn(),
  resumeFile: vi.fn(),
  pauseFile: vi.fn(),
  previewFile: vi.fn(),
  downloadFile: vi.fn(),
  activeRoomConversationId: vi.fn<() => string | null>(
    () => "active-room",
  ),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    retryMessage,
    activeRoomConversationId,
    roomFileCapabilities: () => ({ peer: "supported" }),
    requestRoomFile,
    requestFile,
    resumeFile,
    pauseFile,
  }),
}));
vi.mock("@/components/dialogs/preview-dialog", () => ({
  createPreviewDialog: () => ({ open: previewFile }),
}));
vi.mock("@/libs/utils/download-file", () => ({
  downloadFile,
}));
vi.mock("@/components/portable-contextmenu", () => ({
  PortableContextMenu: (props: {
    children: (bindings: {
      onContextMenu: typeof contextMenu;
    }) => JSX.Element;
  }) => props.children({ onContextMenu: contextMenu }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: (props: ParentProps) => <>{props.children}</>,
  TooltipTrigger: (props: ComponentProps<"button">) => (
    <button {...props} />
  ),
  TooltipContent: (props: ParentProps) => (
    <span>{props.children}</span>
  ),
}));
vi.mock("@/components/icon-file", () => ({
  IconFile: () => <svg />,
}));
vi.mock("@/components/icons", async (importOriginal) => {
  const icons =
    await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.keys(icons).map((key) => [
      key,
      (props: ComponentProps<"svg">) => (
        <svg data-icon={key} {...props} />
      ),
    ]),
  );
});

const textMessage = (
  overrides: Partial<StoreMessage> = {},
): StoreMessage =>
  ({
    id: "m1",
    type: "text",
    client: "self",
    target: "peer",
    data: "A short message",
    createdAt: 1700000000000,
    status: "received",
    ...overrides,
  }) as StoreMessage;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => "blob:local-preview",
      );
      static revokeObjectURL = vi.fn();
    },
  );
  activeRoomConversationId.mockReturnValue("active-room");
  requestRoomFile.mockResolvedValue(undefined);
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "self");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const roomFileMessage = (
  overrides: Partial<FileTransferMessage> = {},
): FileTransferMessage => ({
  id: "room-file",
  type: "file",
  client: "peer",
  target: "self",
  conversationId: "active-room",
  createdAt: 1700000000000,
  status: "received",
  fid: "binary",
  fileName: "firmware.bin",
  fileSize: 1024,
  chunkSize: 512,
  mimeType: "application/octet-stream",
  room: {
    roomId: "room",
    senderName: "Alice",
    senderAvatar: null,
  },
  ...overrides,
});

function onlineSender() {
  setAppState("session", "clientViewData", "peer", {
    clientId: "peer",
    name: "Alice",
    avatar: null,
    createdAt: 1,
    onlineStatus: "online",
    messageChannel: true,
  });
}

function bubble(
  message = textMessage(),
  grouping: Pick<
    MessageCardProps,
    "joinedPrevious" | "joinedNext"
  > = {},
) {
  const result = render(() => (
    <ul>
      <MessageContent
        message={message}
        {...grouping}
        class="animate-message"
        data-chat-message={message.id}
      />
    </ul>
  ));
  return {
    ...result,
    row: result.container.querySelector("li")!,
    bubble: result.container.querySelector<HTMLElement>(
      '[data-slot="message-bubble"]',
    )!,
    meta: result.container.querySelector<HTMLElement>(
      '[data-slot="message-meta"]',
    )!,
  };
}

describe("message bubble layout", () => {
  it("keeps the anchor row separate from a bounded, theme-aware outgoing bubble", () => {
    const view = bubble();
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).toBeNull();
    expect(view.row).toHaveAttribute(
      "data-side",
      "outgoing",
    );
    expect(view.row).toHaveAttribute(
      "data-chat-message",
      "m1",
    );
    expect(view.row).toHaveClass(
      "w-full",
      "animate-message",
    );
    expect(view.bubble).toHaveClass(
      "self-end",
      "rounded-br-md",
      "bg-primary/10",
      "w-fit",
      "max-w-[88%]",
    );
    expect(
      view.meta.querySelector('[data-icon="IconCheck"]'),
    ).not.toBeNull();
    const time = view.meta.querySelector("time")!;
    expect(time).toHaveAttribute(
      "datetime",
      new Date(1700000000000).toISOString(),
    );
    expect(time.title).not.toBe("");
  });

  it("aligns incoming bubbles to the left without an outgoing delivery receipt", () => {
    const view = bubble(
      textMessage({ client: "peer", target: "self" }),
    );
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).toBeNull();
    expect(view.row).toHaveAttribute(
      "data-side",
      "incoming",
    );
    expect(view.bubble).toHaveClass(
      "self-start",
      "rounded-bl-md",
      "bg-background/90",
    );
    expect(
      view.meta.querySelector('[data-icon="IconCheck"]'),
    ).toBeNull();
    expect(view.meta.querySelector("time")).not.toBeNull();
  });

  it("preserves paragraphs and safely wraps unbroken text without breaking every word", () => {
    const text = `First paragraph\n\n${"long-unbroken-text".repeat(40)}\n<script>alert(1)</script>`;
    const view = bubble(textMessage({ data: text }));
    const article = view.bubble.querySelector("article")!;
    expect(article).toHaveClass("[overflow-wrap:anywhere]");
    expect(article).not.toHaveClass("break-all");
    expect(article.querySelector("p")).toHaveClass(
      "whitespace-pre-wrap",
    );
    expect(article.textContent).toBe(text);
    expect(article.querySelector("script")).toBeNull();
  });

  it("gives file messages a bounded card and a readable filename before cache metadata is ready", () => {
    const fileName = `${"very-long-filename-".repeat(20)}.zip`;
    const view = bubble({
      id: "file-message",
      type: "file",
      client: "peer",
      target: "self",
      createdAt: 1700000000000,
      status: "received",
      fid: "archive",
      fileName,
      fileSize: 200,
      chunkSize: 100,
    });
    expect(view.bubble).toHaveClass(
      "w-88",
      "min-w-0",
      "max-w-[88%]",
    );
    expect(screen.getByTitle(fileName)).toHaveClass(
      "truncate",
    );
    expect(
      screen.getByTitle(fileName).parentElement,
    ).not.toHaveClass("absolute");
  });

  it("keeps retry and error details available in the compact metadata row", () => {
    setAppState("session", "clientViewData", "peer", {
      clientId: "peer",
      name: "Peer",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    const message = textMessage({
      status: "error",
      error: "Network unavailable",
    });
    const view = bubble(message);
    expect(view.meta).toContainElement(
      screen.getByText("client.message_error"),
    );
    expect(
      screen.getByText("errors.connection_failed"),
    ).toBeInTheDocument();
    const button = screen.getByLabelText("tasks.resume");
    fireEvent.click(button);
    expect(retryMessage).toHaveBeenCalledWith(message);
  });

  it.each(["self", "peer"])(
    "compresses intermediate %s bubbles without hiding their timestamp from assistive technology",
    (client) => {
      const view = bubble(textMessage({ client }), {
        joinedPrevious: true,
        joinedNext: true,
      });
      expect(view.row).toHaveAttribute(
        "data-group",
        "middle",
      );
      expect(view.bubble).toHaveClass("py-2");
      expect(view.bubble).toHaveClass(
        client === "self"
          ? "rounded-tr-md"
          : "rounded-tl-md",
        client === "self"
          ? "rounded-br-md"
          : "rounded-bl-md",
      );
      expect(
        view.row.querySelector(
          '[data-slot="message-meta"]',
        ),
      ).toBeNull();
      expect(view.bubble.querySelector("time")).toHaveClass(
        "sr-only",
      );
      expect(view.bubble.title).not.toBe("");
      expect(view.row).not.toHaveAttribute(
        "joinedPrevious",
      );
      expect(view.row).not.toHaveAttribute("joinedNext");
    },
  );

  it.each(["self", "peer"])(
    "rounds the outer corners and shows metadata on the last %s bubble",
    (client) => {
      const view = bubble(textMessage({ client }), {
        joinedPrevious: true,
      });
      expect(view.row).toHaveAttribute("data-group", "end");
      expect(view.bubble).toHaveClass(
        "rounded-2xl",
        client === "self"
          ? "rounded-tr-md"
          : "rounded-tl-md",
      );
      expect(view.bubble).not.toHaveClass(
        client === "self"
          ? "rounded-br-md"
          : "rounded-bl-md",
      );
      expect(
        view.meta.querySelector("time"),
      ).not.toHaveClass("sr-only");
    },
  );

  it("retains sending and failure states on intermediate messages", () => {
    const sending = bubble(
      textMessage({ status: "sending" }),
      { joinedNext: true },
    );
    expect(
      sending.meta.querySelector(
        '[data-icon="IconSchedule"]',
      ),
    ).not.toBeNull();
    expect(sending.meta.querySelector("time")).toBeNull();
    setAppState("session", "clientViewData", "peer", {
      clientId: "peer",
      name: "Peer",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    const failed = textMessage({
      id: "failed",
      status: "error",
      error: "Disconnected",
    });
    const view = bubble(failed, { joinedNext: true });
    expect(
      view.meta.querySelector('[data-icon="IconClose"]'),
    ).not.toBeNull();
    expect(
      screen.getByText("errors.connection_closed"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("tasks.resume"));
    expect(retryMessage).toHaveBeenCalledWith(failed);
  });

  it("updates group edges without replacing a bubble or replaying its animation", () => {
    const [joinedNext, setJoinedNext] = createSignal(false);
    const result = render(() => (
      <ul>
        <MessageContent
          message={textMessage()}
          joinedNext={joinedNext()}
        />
      </ul>
    ));
    const element = result.container.querySelector(
      '[data-slot="message-bubble"]',
    );
    const row = result.container.querySelector("li")!;
    setJoinedNext(true);
    expect(row).toHaveAttribute("data-group", "start");
    expect(
      row.querySelector('[data-slot="message-meta"]'),
    ).toBeNull();
    expect(
      result.container.querySelector(
        '[data-slot="message-bubble"]',
      ),
    ).toBe(element);
    setJoinedNext(false);
    expect(row).toHaveAttribute("data-group", "single");
    expect(
      row.querySelector('[data-slot="message-meta"] time'),
    ).not.toBeNull();
    expect(
      result.container.querySelector(
        '[data-slot="message-bubble"]',
      ),
    ).toBe(element);
  });

  it("renders stable localized time labels and full dates in separators", () => {
    const timestamp = 1700000000000;
    const view = bubble();
    const result = render(() => (
      <ul>
        <ChatTimeSeparator timestamp={timestamp} />
      </ul>
    ));
    const separator =
      result.container.querySelector("time")!;
    for (const locale of [
      "en-us",
      "zh-cn",
      "zh-tw",
    ] as const) {
      setAppState("options", "locale", locale);
      expect(
        view.meta.querySelector("time")?.textContent,
      ).toBe(
        new Date(timestamp).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      expect(separator.textContent).toBe(
        new Date(timestamp).toLocaleString(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      );
      expect(separator).toHaveAttribute(
        "datetime",
        new Date(timestamp).toISOString(),
      );
    }
  });

  it("limits the context-menu target to the bubble rather than the full-width empty row", () => {
    const view = bubble();
    fireEvent.contextMenu(view.row);
    expect(contextMenu).not.toHaveBeenCalled();
    fireEvent.contextMenu(view.bubble);
    expect(contextMenu).toHaveBeenCalledTimes(1);
  });
  it("places recipient avatars toward the center of outgoing room bubbles without a disclosure or text list", () => {
    setAppState("message", "clients", [
      {
        clientId: "alice",
        name: "Saved Alice",
        avatar: null,
      },
      { clientId: "ben", name: "Saved Ben", avatar: null },
      { clientId: "kai", name: "Saved Kai", avatar: null },
    ]);
    setAppState("session", "clientViewData", "alice", {
      clientId: "alice",
      name: "Live Alice",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    const view = bubble(
      textMessage({
        conversationId: "active-room",
        room: {
          roomId: "room",
          senderName: "Me",
          senderAvatar: null,
        },
        deliveries: {
          alice: "delivered",
          ben: "sending",
          kai: "failed",
          unknown: "unsupported",
        },
      }),
    );
    const receipts = view.row.querySelector<HTMLElement>(
      '[data-slot="room-deliveries"]',
    )!;
    expect(receipts.parentElement).toBe(
      view.bubble.parentElement,
    );
    expect(receipts.parentElement).toHaveAttribute(
      "data-slot",
      "message-row",
    );
    expect(receipts.parentElement).toHaveClass(
      "flex",
      "items-end",
      "justify-start",
      "flex-row-reverse",
    );
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).not.toBeNull();
    expect(view.bubble).not.toContainElement(receipts);
    expect(receipts).toHaveClass(
      "shrink-0",
      "max-w-24",
      "justify-end",
    );
    expect(
      receipts.querySelector("details, summary, ul"),
    ).toBeNull();
    expect(
      receipts.querySelectorAll("[data-recipient-id]"),
    ).toHaveLength(4);
    for (const [name, status] of [
      ["Live Alice", "delivered"],
      ["Saved Ben", "sending"],
      ["Saved Kai", "failed"],
      ["unknown", "unsupported"],
    ]) {
      const avatar = screen.getByRole("img", {
        name: `${name} · conversations.delivery_${status}`,
      });
      expect(avatar).toHaveAttribute(
        "title",
        `${name} · conversations.delivery_${status}`,
      );
      expect(avatar).toHaveAttribute(
        "data-delivery-status",
        status,
      );
      expect(avatar.parentElement).toHaveClass(
        "-space-x-1.5",
      );
    }
    expect(
      screen.queryByText("conversations.delivered_count"),
    ).toBeNull();
    expect(
      screen.queryByText("conversations.delivery_failed"),
    ).toBeNull();
    expect(
      receipts.querySelector(
        '[data-delivery-status="failed"]',
      ),
    ).toHaveClass("border-destructive");
    expect(
      receipts.querySelector(
        '[data-delivery-status="unsupported"]',
      ),
    ).toHaveClass("opacity-40");
  });

  it("keeps a compact retry icon beside failed recipients and prevents duplicate retries", async () => {
    setAppState("session", "clientViewData", "peer", {
      clientId: "peer",
      name: "Peer",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    let resolve!: () => void;
    retryMessage.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const message = textMessage({
      conversationId: "active-room",
      room: {
        roomId: "room",
        senderName: "Me",
        senderAvatar: null,
      },
      deliveries: { peer: "failed" },
    });
    const view = bubble(message);
    const button = screen.getByRole("button", {
      name: "conversations.retry_failed",
    });
    expect(view.bubble).not.toContainElement(button);
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(retryMessage).toHaveBeenCalledTimes(1);
    expect(retryMessage).toHaveBeenCalledWith(message);
    resolve();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it.each(["historical room", "offline recipient"])(
    "hides room retry for an %s while retaining the status avatar",
    (condition) => {
      if (condition === "historical room") {
        activeRoomConversationId.mockReturnValue(
          "another-room",
        );
        setAppState("session", "clientViewData", "peer", {
          clientId: "peer",
          name: "Peer",
          avatar: null,
          createdAt: 1,
          onlineStatus: "online",
          messageChannel: true,
        });
      }
      const view = bubble(
        textMessage({
          conversationId: "active-room",
          room: {
            roomId: "room",
            senderName: "Me",
            senderAvatar: null,
          },
          deliveries: { peer: "failed" },
        }),
      );
      expect(
        view.row.querySelector(
          '[data-delivery-status="failed"]',
        ),
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "conversations.retry_failed",
        }),
      ).toBeNull();
    },
  );

  it("shows a sender avatar on incoming room messages without adding recipient avatars", () => {
    const view = bubble(
      textMessage({
        client: "peer",
        target: "self",
        conversationId: "active-room",
        room: {
          roomId: "room",
          senderName: "Peer",
          senderAvatar: null,
        },
        deliveries: { self: "delivered" },
      }),
    );
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).not.toBeNull();
    expect(view.bubble.parentElement).not.toHaveClass(
      "flex-row-reverse",
    );
    expect(
      view.row.querySelector(
        '[data-slot="room-deliveries"]',
      ),
    ).toBeNull();
  });
  it("caps the avatar stack with a compact overflow count without adding an expandable panel", () => {
    const view = bubble(
      textMessage({
        conversationId: "active-room",
        room: {
          roomId: "room",
          senderName: "Me",
          senderAvatar: null,
        },
        deliveries: {
          alice: "delivered",
          ben: "delivered",
          kai: "delivered",
          dana: "sending",
          eli: "failed",
          fran: "unsupported",
        },
      }),
    );
    const receipts = view.row.querySelector<HTMLElement>(
      '[data-slot="room-deliveries"]',
    )!;
    expect(
      receipts.querySelectorAll("[data-recipient-id]"),
    ).toHaveLength(3);
    const overflow = receipts.querySelector(
      '[data-slot="room-delivery-overflow"]',
    )!;
    expect(overflow.textContent).toBe("+3");
    expect(overflow).toHaveAttribute(
      "title",
      "dana · conversations.delivery_sending\neli · conversations.delivery_failed\nfran · conversations.delivery_unsupported",
    );
    expect(
      receipts.querySelector("details, summary"),
    ).toBeNull();
  });
});

describe("room file offers", () => {
  it.each([true, false])(
    "renders locally owned images without requesting bytes (sender: %s)",
    async (outgoing) => {
      onlineSender();
      const file = new File(
        [new Uint8Array(12)],
        "photo.png",
        { type: "image/png" },
      );
      const offer = roomFileMessage({
        client: outgoing ? "self" : "peer",
        target: outgoing ? "active-room" : "self",
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      });
      const cache = () =>
        setAppState("cache", "cacheInfo", "binary", {
          id: "binary",
          fileName: file.name,
          fileSize: file.size,
          mimetype: file.type,
          chunkSize: offer.chunkSize,
          roomAttachment: true,
          roomOfferId: offer.id,
          from: offer.client,
          file,
          isComplete: true,
        });
      if (outgoing) cache();
      const view = bubble(offer);
      if (!outgoing) {
        expect(
          screen.queryByRole("img", { name: file.name }),
        ).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(requestRoomFile).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole("button", {
            name: "conversations.room_file_request",
          }),
        );
        await waitFor(() =>
          expect(requestRoomFile).toHaveBeenCalledOnce(),
        );
        cache();
      }
      expect(
        screen.getByRole("img", { name: file.name }),
      ).toHaveAttribute("src", "blob:local-preview");
      expect(URL.createObjectURL).toHaveBeenCalledWith(
        file,
      );
      expect(
        screen.queryByRole("button", {
          name: "conversations.room_file_request",
        }),
      ).toBeNull();
      expect(
        screen.getByRole("link", {
          name: `common.action.preview: ${file.name}`,
        }),
      ).toHaveAttribute("data-message-media");
      expect(previewFile).not.toHaveBeenCalled();
      if (outgoing)
        expect(requestRoomFile).not.toHaveBeenCalled();
      view.unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(
        "blob:local-preview",
      );
    },
  );

  it.each(["video/mp4", "audio/ogg"])(
    "renders a sender's local %s with the matching media bubble and no transfer request",
    (type) => {
      const file = new File(["local"], "media", { type });
      const offer = roomFileMessage({
        client: "self",
        target: "active-room",
        fileName: file.name,
        fileSize: file.size,
        mimeType: type,
      });
      setAppState("cache", "cacheInfo", "binary", {
        id: "binary",
        fileName: file.name,
        fileSize: file.size,
        mimetype: type,
        chunkSize: offer.chunkSize,
        roomAttachment: true,
        roomOfferId: offer.id,
        from: offer.client,
        file,
        isComplete: true,
      });
      const view = bubble(offer);
      const player = view.row.querySelector(
        type.startsWith("video/") ? "video" : "audio",
      )!;
      expect(player).toHaveAttribute(
        "src",
        "blob:local-preview",
      );
      if (type.startsWith("audio/"))
        expect(player).toHaveAttribute("controls");
      else {
        expect(player).not.toHaveAttribute("controls");
        expect(player.closest("a")).toHaveAttribute(
          "data-pswp-type",
          "video",
        );
        expect(player.closest("a")).toHaveAttribute(
          "data-pswp-video-src",
          "blob:local-preview",
        );
      }
      expect(player).not.toHaveAttribute("autoplay");
      expect(requestRoomFile).not.toHaveBeenCalled();
    },
  );

  it("waits for an explicit request even with no cache, then offers preview and save after completion", async () => {
    onlineSender();
    const offer = roomFileMessage();
    const view = bubble(offer);
    expect(
      screen.getByTitle("firmware.bin"),
    ).toBeInTheDocument();
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).toHaveAttribute("aria-label", "Alice");
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(requestRoomFile).not.toHaveBeenCalled();
    const request = screen.getByRole("button", {
      name: "conversations.room_file_request",
    });
    expect(request).toBeEnabled();
    fireEvent.click(request);
    await waitFor(() =>
      expect(requestRoomFile).toHaveBeenCalledWith(offer),
    );
    expect(requestRoomFile).toHaveBeenCalledTimes(1);

    const file = new File(
      [new Uint8Array(1024)],
      "firmware.bin",
      { type: "application/octet-stream" },
    );
    setAppState("cache", "cacheInfo", "binary", {
      id: "binary",
      fileName: file.name,
      fileSize: file.size,
      chunkSize: offer.chunkSize,
      mimetype: offer.mimeType,
      roomAttachment: true,
      roomOfferId: offer.id,
      from: offer.client,
      file,
      isComplete: true,
    });
    expect(
      screen.queryByRole("button", {
        name: "conversations.room_file_request",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.preview",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.download",
      }),
    );
    expect(previewFile).toHaveBeenCalledWith(file);
    expect(downloadFile).toHaveBeenCalledWith(file);
    expect(requestRoomFile).toHaveBeenCalledTimes(1);
  });

  it("does not expose cached bytes belonging to a private file or another room offer", () => {
    onlineSender();
    const offer = roomFileMessage();
    bubble(offer);
    const base = {
      id: "binary",
      fileName: offer.fileName,
      fileSize: offer.fileSize,
      chunkSize: offer.chunkSize,
      mimetype: offer.mimeType,
      file: new File(
        [new Uint8Array(1024)],
        offer.fileName,
      ),
      isComplete: true,
      roomAttachment: true,
      roomOfferId: offer.id,
      from: offer.client,
    };
    for (const mismatch of [
      { roomAttachment: false },
      { roomOfferId: "another-offer" },
      { from: "another-peer" },
      { fileSize: 2048 },
    ]) {
      setAppState("cache", "cacheInfo", "binary", {
        ...base,
        ...mismatch,
      });
      expect(
        screen.queryByRole("button", {
          name: "common.action.preview",
        }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "common.action.download",
        }),
      ).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "conversations.room_file_request",
        }),
      ).toBeEnabled();
    }
    expect(requestRoomFile).not.toHaveBeenCalled();
  });

  it("keeps a historical offer readable but disables requesting outside its original room", () => {
    onlineSender();
    activeRoomConversationId.mockReturnValue(
      "another-room",
    );
    bubble(roomFileMessage());
    const request = screen.getByRole("button", {
      name: "conversations.room_file_request",
    });
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(requestRoomFile).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "conversations.room_file_sender_unavailable",
      ),
    ).toBeInTheDocument();
  });

  it("opens recipient-specific progress on demand without proactively resuming uploads", async () => {
    const view = bubble(
      roomFileMessage({
        client: "self",
        target: "self",
        room: {
          roomId: "room",
          senderName: "Me",
          senderAvatar: null,
        },
        deliveries: {
          alice: "delivered",
          ben: "delivered",
        },
        roomTransfers: {
          alice: {
            status: "complete",
            progress: { received: 1024, total: 1024 },
          },
          ben: {
            status: "paused",
            progress: { received: 512, total: 1024 },
          },
        },
      }),
    );
    expect(
      view.row.querySelector(
        '[data-slot="message-sender-avatar"]',
      ),
    ).toHaveAttribute("aria-label", "Me");
    const receipts = view.row.querySelector(
      '[data-slot="room-deliveries"]',
    );
    expect(receipts?.parentElement).toBe(
      view.bubble.parentElement,
    );
    expect(
      view.row.querySelector("[data-transfer-recipient]"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "conversations.room_file_details",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      dialog.querySelector(
        '[data-transfer-recipient="alice"]',
      ),
    ).toHaveTextContent("tasks.status.completed");
    expect(
      dialog.querySelector(
        '[data-transfer-recipient="ben"]',
      ),
    ).toHaveTextContent("tasks.status.paused");
    expect(
      screen.queryByRole("button", {
        name: "tasks.resume",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "conversations.room_file_request",
      }),
    ).toBeNull();
    expect(requestRoomFile).not.toHaveBeenCalled();
  });
});

describe("shared attachment bubbles and transfer controls", () => {
  it.each([
    "image/png",
    "video/mp4",
    "audio/ogg",
    "application/zip",
  ])(
    "renders private %s through the shared bubble",
    (type) => {
      const file = new File(["bytes"], "attachment", {
        type,
      });
      const message = roomFileMessage({
        room: undefined,
        conversationId: undefined,
        client: "self",
        target: "peer",
        fileName: file.name,
        fileSize: file.size,
        mimeType: type,
        transferStatus: "complete",
      });
      setAppState("cache", "cacheInfo", "binary", {
        id: "binary",
        fileName: file.name,
        fileSize: file.size,
        chunkSize: 512,
        mimetype: type,
        file,
        isComplete: true,
      });
      const view = bubble(message);
      expect(
        view.row.querySelector(
          '[data-slot="file-attachment-bubble"]',
        ),
      ).toBeInTheDocument();
      if (
        type.startsWith("image/") ||
        type.startsWith("video/")
      ) {
        expect(
          screen.getByRole("link", {
            name: "common.action.preview: attachment",
          }),
        ).toHaveAttribute("data-message-media");
      } else if (type.startsWith("audio/")) {
        expect(
          view.row.querySelector("audio"),
        ).toHaveAttribute("controls");
      } else {
        expect(
          view.row.querySelector("img, video, audio"),
        ).toBeNull();
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: "common.action.download",
        }),
      );
      expect(downloadFile).toHaveBeenCalledWith(file);
      expect(view.row).toHaveTextContent("5.00 B");
      expect(requestFile).not.toHaveBeenCalled();
      expect(requestRoomFile).not.toHaveBeenCalled();
      view.unmount();
      if (!type.startsWith("application/"))
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(
          "blob:local-preview",
        );
    },
  );

  it.each(["room", "private-receiver", "private-sender"])(
    "keeps %s progress while switching the center control from pause to resume",
    async (kind) => {
      onlineSender();
      const sender = kind === "private-sender";
      const initial = roomFileMessage({
        room:
          kind === "room"
            ? roomFileMessage().room
            : undefined,
        client: sender ? "self" : "peer",
        target: sender ? "peer" : "self",
        transferStatus: "transfering",
        progress: { received: 512, total: 1024 },
      });
      const [message, setMessage] = createSignal(initial);
      setAppState("cache", "cacheInfo", "binary", {
        id: "binary",
        fileName: initial.fileName,
        fileSize: 1024,
        chunkSize: 512,
        mimetype: initial.mimeType,
      });
      setAppState("transfer", "transfers", "active", {
        id: "active",
        messageId: initial.id,
        fileId: "binary",
        session: {
          clientId: "self",
          targetClientId: "peer",
        },
        transferer: {
          mode: sender
            ? TransferMode.Send
            : TransferMode.Receive,
        },
      } as unknown as ActiveFileTransfer);
      render(() => (
        <ul>
          <MessageContent message={message()} />
        </ul>
      ));
      const ring = screen.getByRole("progressbar", {
        name: "tasks.progress",
      });
      expect(ring.tagName.toLowerCase()).toBe("svg");
      expect(ring).toHaveAttribute("aria-valuenow", "50");
      const status = document.querySelector(
        '[data-slot="file-transfer-status"]',
      )!;
      expect(status).toHaveTextContent("0.00 B/s");
      expect(status).not.toHaveTextContent(
        "tasks.status.running",
      );
      const pause = screen.getByRole("button", {
        name: "tasks.pause",
      });
      expect(pause.parentElement).toBe(ring.parentElement);
      fireEvent.click(pause);
      await waitFor(() =>
        expect(pauseFile).toHaveBeenCalledWith(
          "binary",
          "peer",
        ),
      );
      setAppState(
        "transfer",
        "transfers",
        "active",
        undefined,
      );
      setMessage({ ...initial, transferStatus: "paused" });
      expect(status).toHaveTextContent(
        "tasks.status.paused",
      );
      expect(status).not.toHaveTextContent("/s");
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: "tasks.resume",
          }),
        ).toBeEnabled(),
      );
      expect(
        screen.getByRole("progressbar"),
      ).toHaveAttribute("aria-valuenow", "50");
      fireEvent.click(
        screen.getByRole("button", {
          name: "tasks.resume",
        }),
      );
      await waitFor(() => {
        if (kind === "room")
          expect(requestRoomFile).toHaveBeenCalledWith(
            message(),
          );
        else if (sender)
          expect(resumeFile).toHaveBeenCalledWith(
            "binary",
            "peer",
          );
        else
          expect(requestFile).toHaveBeenCalledWith(
            "peer",
            expect.objectContaining({ id: "binary" }),
            true,
          );
      });
    },
  );

  it("keeps room upload controls and progress isolated by recipient", async () => {
    const offer = roomFileMessage({
      client: "self",
      target: "active-room",
      roomTransfers: {
        alice: {
          status: "transfering",
          progress: { received: 256, total: 1024 },
        },
        ben: {
          status: "complete",
          progress: { received: 1024, total: 1024 },
        },
      },
    });
    setAppState("transfer", "transfers", "alice-upload", {
      id: "alice-upload",
      messageId: offer.id,
      fileId: offer.fid,
      session: {
        clientId: "self",
        targetClientId: "alice",
      },
      transferer: { mode: TransferMode.Send },
    } as unknown as ActiveFileTransfer);
    const view = bubble(offer);
    expect(
      view.row.querySelector("[data-transfer-recipient]"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "conversations.room_file_details",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      dialog.querySelector(
        '[data-transfer-recipient="alice"] [role="progressbar"]',
      ),
    ).toHaveAttribute("aria-valuenow", "25");
    expect(
      dialog.querySelector(
        '[data-transfer-recipient="ben"] [role="progressbar"]',
      ),
    ).toHaveAttribute("aria-valuenow", "100");
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks.pause · alice",
      }),
    );
    await waitFor(() =>
      expect(pauseFile).toHaveBeenCalledWith(
        "binary",
        "alice",
      ),
    );
    expect(
      screen.queryByRole("button", {
        name: "tasks.resume",
      }),
    ).toBeNull();
    expect(requestRoomFile).not.toHaveBeenCalled();
  });
});
