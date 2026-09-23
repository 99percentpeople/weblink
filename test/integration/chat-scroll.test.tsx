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
import {
  MemoryRouter,
  Route,
  createMemoryHistory,
} from "@solidjs/router";
import { reconcile } from "solid-js/store";
import { type ParentProps } from "solid-js";
import Chat from "../support/direct-chat-page";
import type { StoreMessage } from "@/libs/domain/message";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    sendFile: vi.fn(),
    sendClipboard: vi.fn(),
  }),
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  () => ({
    messageStores: {
      deleteMessage: (id: string) => {
        setAppState("message", "messages", (messages) =>
          messages.filter((message) => message.id !== id),
        );
        return true;
      },
    },
  }),
);
vi.mock(
  "@/libs/application/transfer/transfer-service",
  () => ({
    transferManager: {},
  }),
);
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {},
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleDropItems: vi.fn(),
}));
vi.mock(
  "@/components/dialogs/delete-file-message-dialog",
  () => ({
    createDeleteFileMessageDialog: () => ({
      open: vi.fn(),
    }),
  }),
);
vi.mock("@/components/icons", () => ({
  IconSettings: () => null,
  IconArrowDownward: () => null,
  IconArrowUpward: () => null,
  IconClose: () => null,
  IconPlaceItem: () => null,
}));
vi.mock("photoswipe/lightbox", () => ({
  default: class {
    addFilter() {}
    on() {}
    init() {}
    destroy() {}
  },
}));
vi.mock("photoswipe-video-plugin", () => ({
  default: class {},
}));
vi.mock("@/components/drop-area", () => ({
  default: (props: ParentProps) => (
    <div>{props.children}</div>
  ),
}));
vi.mock(
  "@/routes/client/[id]/components/client-header",
  () => ({
    ClientHeader: () => <header>Chat</header>,
  }),
);
vi.mock("@/routes/client/[id]/components/chat-bar", () => ({
  ChatBar: () => <footer>Composer</footer>,
}));
vi.mock("@/routes/client/[id]/components/message", () => ({
  MessageContent: (props: {
    message: StoreMessage;
    class: string;
    onDelete: () => void;
    joinedPrevious: boolean;
    joinedNext: boolean;
  }) => (
    <li
      data-chat-message={props.message.id}
      data-joined-previous={props.joinedPrevious}
      data-joined-next={props.joinedNext}
      class={props.class}
    >
      <span>{props.message.id}</span>
      <button onClick={props.onDelete}>
        Delete {props.message.id}
      </button>
    </li>
  ),
}));

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  deliver(target: Element) {
    this.callback(
      [{ target } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}
class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  target: Element | undefined;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    TestIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  disconnect() {
    this.target = undefined;
  }
  deliver(isIntersecting: boolean) {
    this.callback(
      [
        {
          target: this.target,
          isIntersecting,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

let viewportHeight = 600;
let deferSmoothScroll = false;
let motionQuery: MediaQueryList;
const rowHeights = new Map<string, number>();
const scrollTo = vi.fn(function (
  this: HTMLElement,
  options: ScrollToOptions,
) {
  if (deferSmoothScroll && options.behavior === "smooth")
    return;
  this.scrollTop = Math.max(
    0,
    Math.min(
      options.top ?? 0,
      this.scrollHeight - this.clientHeight,
    ),
  );
});
const viewport = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="chat-viewport"]',
  )!;
const rows = () => [
  ...document.querySelectorAll<HTMLElement>(
    "[data-chat-message]",
  ),
];
const rowHeight = (element: HTMLElement) =>
  rowHeights.get(element.dataset.chatMessage!) ?? 80;
const olderHeight = () =>
  document.querySelector('[aria-label="common.show_more"]')
    ? 40
    : 0;
const bottom = () =>
  Math.max(
    0,
    viewport().scrollHeight - viewport().clientHeight,
  );
function resize(
  target: Element = viewport().querySelector("ul")!,
) {
  for (const observer of TestResizeObserver.instances) {
    if (observer.targets.has(target))
      observer.deliver(target);
  }
}
function readHistory(top = 200) {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
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
    data: `Message ${index}`,
    createdAt: index,
    status: "received",
  };
}
function append(...indexes: number[]) {
  setAppState("message", "messages", (messages) => [
    ...messages,
    ...indexes.map((index) => message("peer", index)),
  ]);
}
function renderChat() {
  const history = createMemoryHistory();
  history.set({
    value: "/client/peer/chat",
    scroll: false,
  });
  const result = render(() => (
    <MemoryRouter history={history}>
      <Route path="/client/:id/chat" component={Chat} />
      <Route path="/" component={() => <div>Home</div>} />
    </MemoryRouter>
  ));
  return {
    ...result,
    list: () => viewport().querySelector("ul")!,
    navigate: (value: string) =>
      history.set({ value, scroll: false }),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(
    (...args) => {
      throw new Error(args.join(" "));
    },
  );
  TestResizeObserver.instances = [];
  TestIntersectionObserver.instances = [];
  viewportHeight = 600;
  deferSmoothScroll = false;
  motionQuery = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  }) as MediaQueryList;
  vi.stubGlobal("matchMedia", () => motionQuery);
  rowHeights.clear();
  scrollTo.mockClear();
  setAppState(reconcile(createInitialAppState()));
  setAppState("message", "clients", [
    { clientId: "peer", name: "Peer", avatar: null },
    { clientId: "other", name: "Other", avatar: null },
  ]);
  setAppState("message", "messages", [
    ...Array.from({ length: 40 }, (_, i) =>
      message("peer", i),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      message("other", i),
    ),
  ]);
  setAppState("message", "status", "ready");
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "IntersectionObserver",
    TestIntersectionObserver,
  );
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  vi.spyOn(
    Element.prototype,
    "clientHeight",
    "get",
  ).mockImplementation(function (this: HTMLElement) {
    return this.dataset.slot === "chat-viewport"
      ? viewportHeight
      : 0;
  });
  vi.spyOn(
    Element.prototype,
    "scrollHeight",
    "get",
  ).mockImplementation(function (this: HTMLElement) {
    return this.dataset.slot === "chat-viewport"
      ? Math.max(
          viewportHeight,
          olderHeight() +
            rows().reduce(
              (height, row) => height + rowHeight(row),
              0,
            ),
        )
      : 0;
  });
  vi.spyOn(
    Element.prototype,
    "getBoundingClientRect",
  ).mockImplementation(function (this: HTMLElement) {
    let top = 100,
      height = viewportHeight;
    if (this.hasAttribute("data-chat-message")) {
      const preceding = rows().slice(
        0,
        rows().indexOf(this),
      );
      top +=
        olderHeight() +
        preceding.reduce(
          (height, row) => height + rowHeight(row),
          0,
        ) -
        viewport().scrollTop;
      height = rowHeight(this);
    }
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 600,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("Chat scrollport and layout-driven following", () => {
  const separators = () => [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="chat-time-separator"]',
    ),
  ];

  it("renders compact neighbors and updates group edges without replacing existing message rows", () => {
    renderChat();
    const oldRows = rows();
    expect(separators()).toHaveLength(1);
    expect(oldRows[0]).toHaveAttribute(
      "data-joined-previous",
      "false",
    );
    expect(oldRows[0]).toHaveAttribute(
      "data-joined-next",
      "true",
    );
    expect(oldRows.at(-1)).toHaveAttribute(
      "data-joined-next",
      "false",
    );
    append(40, 41);
    expect(rows().slice(0, oldRows.length)).toEqual(
      oldRows,
    );
    expect(oldRows.at(-1)).toHaveAttribute(
      "data-joined-next",
      "true",
    );
    expect(rows().at(-1)).toHaveAttribute(
      "data-joined-next",
      "false",
    );
    expect(separators()).toHaveLength(1);
  });

  it("inserts separators for a five-minute pause and midnight but not simply for a change of sender", () => {
    const at = new Date(2026, 0, 3, 23, 50).getTime();
    setAppState("message", "messages", [
      { ...message("peer", 0), createdAt: at },
      {
        ...message("self", 1),
        target: "peer",
        createdAt: at + 60000,
      },
      {
        ...message("self", 2),
        target: "peer",
        createdAt: at + 6 * 60000,
      },
      {
        ...message("self", 3),
        target: "peer",
        createdAt: at + 10 * 60000,
      },
    ]);
    renderChat();
    expect(rows()).toHaveLength(4);
    expect(separators()).toHaveLength(3);
    expect(rows()[1]).toHaveClass("mt-2");
    expect(rows()[2]).not.toHaveClass("mt-2");
    expect(
      rows().every(
        (row) => row.dataset.joinedPrevious === "false",
      ),
    ).toBe(true);
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("moves the first visible time boundary when prepending without remounting the former first message", () => {
    renderChat();
    const first = rows()[0];
    const firstTime =
      separators()[0].querySelector("time")!.dateTime;
    readHistory();
    fireEvent.click(
      screen.getByLabelText("common.show_more"),
    );
    expect(rows()[5]).toBe(first);
    expect(first).toHaveAttribute(
      "data-joined-previous",
      "true",
    );
    expect(separators()).toHaveLength(1);
    expect(
      separators()[0].querySelector("time")!.dateTime,
    ).not.toBe(firstTime);
    expect(
      document.querySelector(".animate-message"),
    ).toBeNull();
  });

  it("recomputes the time gap and joined corners after a middle message is deleted", () => {
    const at = new Date(2026, 0, 3, 10).getTime();
    setAppState(
      "message",
      "messages",
      [0, 1, 2].map((index) => ({
        ...message("peer", index),
        createdAt: at + index * 4 * 60000,
      })),
    );
    renderChat();
    const last = rows().at(-1)!;
    expect(separators()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute(
      "data-joined-next",
      "true",
    );
    fireEvent.click(screen.getByText("Delete peer-1"));
    expect(separators()).toHaveLength(2);
    expect(rows().at(-1)).toBe(last);
    expect(rows()[0]).toHaveAttribute(
      "data-joined-next",
      "false",
    );
    expect(last).toHaveAttribute(
      "data-joined-previous",
      "false",
    );
  });

  it("positions the complete initial page synchronously before revealing it", () => {
    scrollTo.mockImplementationOnce(function (
      this: HTMLElement,
      options: ScrollToOptions,
    ) {
      expect(rows()).toHaveLength(20);
      expect(
        this.querySelector("ul")?.getAttribute("aria-busy"),
      ).toBe("true");
      this.scrollTop = options.top!;
    });
    const { list } = renderChat();
    expect(viewport().scrollTop).toBe(bottom());
    expect(list().getAttribute("aria-busy")).toBe("false");
    expect(list().classList.contains("invisible")).toBe(
      false,
    );
    expect(
      list().querySelector(".animate-message"),
    ).toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(TestIntersectionObserver.instances).toHaveLength(
      0,
    );
  });

  it("waits for asynchronous store hydration", () => {
    setAppState("message", "status", "initializing");
    const { list } = renderChat();
    resize();
    expect(rows()).toHaveLength(0);
    expect(list().getAttribute("aria-busy")).toBe("true");
    expect(scrollTo).not.toHaveBeenCalled();
    setAppState("message", "status", "ready");
    expect(rows()).toHaveLength(20);
    expect(viewport().scrollTop).toBe(bottom());
    expect(list().getAttribute("aria-busy")).toBe("false");
  });

  it("waits for a measurable viewport and handles later parent layout", () => {
    viewportHeight = 0;
    const { list } = renderChat();
    expect(list().getAttribute("aria-busy")).toBe("true");
    viewportHeight = 600;
    resize(viewport());
    expect(list().getAttribute("aria-busy")).toBe("false");
    expect(viewport().scrollTop).toBe(bottom());
  });

  it.each(["resize-first", "scroll-first"])(
    "follows late media and font geometry (%s)",
    (order) => {
      renderChat();
      fireEvent.scroll(viewport()); // A previously queued programmatic scroll event.
      for (const height of [320, 740, 460]) {
        rowHeights.set("peer-20", height);
        if (order === "scroll-first")
          fireEvent.scroll(viewport());
        resize();
        fireEvent.scroll(viewport());
        expect(viewport().scrollTop).toBe(bottom());
        expect(
          screen.queryByRole("button", {
            name: "client.scroll_to_bottom",
          }),
        ).toBeNull();
      }
    },
  );

  it("follows composer/viewport resizing without confusing browser clamping with scrolling up", () => {
    renderChat();
    for (const height of [400, 900, 500]) {
      viewportHeight = height;
      viewport().scrollTop = Math.min(
        viewport().scrollTop,
        bottom(),
      );
      fireEvent.scroll(viewport());
      resize(viewport());
      expect(viewport().scrollTop).toBe(bottom());
    }
    rowHeights.set("peer-20", 700);
    resize();
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("preserves a reader's visible message when earlier media changes height", () => {
    renderChat();
    readHistory();
    const anchor = rows().find(
      (row) => row.getBoundingClientRect().bottom > 100,
    )!;
    const offset = anchor.getBoundingClientRect().top;
    rowHeights.set("peer-20", 400);
    resize();
    expect(viewport().scrollTop).toBe(520);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    append(40, 41);
    resize();
    expect(viewport().scrollTop).toBe(520);
    expect(
      screen.queryByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    ).not.toBeNull();
  });

  it("includes every message in a received batch and retains already loaded history", () => {
    renderChat();
    append(40, 41, 42);
    expect(rows()).toHaveLength(23);
    for (const index of [20, 40, 41, 42])
      expect(
        screen.queryByText(`peer-${index}`),
      ).not.toBeNull();
    expect(viewport().scrollTop).toBe(bottom());
    expect(
      screen
        .getByText("peer-42")
        .closest("li")!
        .classList.contains("animate-message"),
    ).toBe(true);
  });

  it("loads older history only on real intersection, preserving the visible message", () => {
    renderChat();
    readHistory();
    const observer =
      TestIntersectionObserver.instances.at(-1)!;
    expect(observer.options.root).toBe(viewport());
    observer.deliver(false);
    expect(rows()).toHaveLength(20);
    observer.deliver(true);
    expect(rows()).toHaveLength(25);
    expect(viewport().scrollTop).toBe(600);
    resize();
    expect(viewport().scrollTop).toBe(600);
    // The callback still cannot load anything after this observer is retired.
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    );
    observer.deliver(true);
    expect(rows()).toHaveLength(25);
  });

  it("allows explicit loading and return-to-bottom without observer delays", () => {
    renderChat();
    fireEvent.click(
      screen.getByLabelText("common.show_more"),
    );
    expect(rows()).toHaveLength(25);
    readHistory();
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    );
    expect(viewport().scrollTop).toBe(bottom());
    rowHeights.set("peer-20", 500);
    resize();
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("starts a new scroll lifecycle when switching peers and ignores retired observers", async () => {
    const { navigate } = renderChat();
    readHistory();
    const oldViewport = viewport();
    const oldObserver = TestResizeObserver.instances.find(
      (observer) => observer.targets.has(oldViewport),
    )!;
    await navigate("/client/other/chat");
    await waitFor(() =>
      expect(screen.queryByText("other-29")).not.toBeNull(),
    );
    expect(viewport()).not.toBe(oldViewport);
    expect(oldObserver.targets.size).toBe(0);
    expect(viewport().scrollTop).toBe(bottom());
    expect(
      document.querySelector(".animate-message"),
    ).toBeNull();
    readHistory();
    const top = viewport().scrollTop;
    oldObserver.deliver(oldViewport);
    expect(viewport().scrollTop).toBe(top);
  });

  it("does not use document scroll state or let a router reset overwrite message scrolling", () => {
    renderChat();
    document.documentElement.scrollTop = 0;
    fireEvent.scroll(document);
    expect(viewport().scrollTop).toBe(bottom());
    readHistory();
    document.documentElement.scrollTop = 2000;
    fireEvent.scroll(document);
    expect(viewport().scrollTop).toBe(200);
  });

  it("reveals empty history and follows its first message", () => {
    setAppState("message", "messages", []);
    const { list } = renderChat();
    expect(list().getAttribute("aria-busy")).toBe("false");
    append(0);
    expect(rows()).toHaveLength(1);
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("projects deletion from the message store without maintaining a second stale list", () => {
    renderChat();
    fireEvent.click(screen.getByText("Delete peer-39"));
    expect(screen.queryByText("peer-39")).toBeNull();
    expect(rows()).toHaveLength(20);
    resize();
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("animates return-to-bottom without jumping or restarting on intermediate scroll/resize events", () => {
    deferSmoothScroll = true;
    renderChat();
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "instant",
    });
    readHistory();
    scrollTo.mockClear();
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "smooth",
    });
    expect(viewport().scrollTop).toBe(200);

    viewport().scrollTop = 400;
    fireEvent.scroll(viewport());
    resize();
    resize(viewport());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(viewport().scrollTop).toBe(400);
    expect(
      screen.queryByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    ).toBeNull();

    viewport().scrollTop = bottom();
    fireEvent.scroll(viewport());
    rowHeights.set("peer-20", 300);
    resize();
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "instant",
    });
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("smoothly follows every new batch and retargets late layout changes without an instant snap", () => {
    deferSmoothScroll = true;
    renderChat();
    const initialTop = viewport().scrollTop;
    scrollTo.mockClear();
    append(40, 41);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "smooth",
    });
    expect(viewport().scrollTop).toBe(initialTop);
    expect(
      document.querySelectorAll(".animate-message"),
    ).toHaveLength(2);

    viewport().scrollTop += 20;
    fireEvent.scroll(viewport());
    append(42);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "smooth",
    });
    rowHeights.set("peer-40", 300);
    resize();
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(
      scrollTo.mock.calls.every(
        ([options]) => options.behavior === "smooth",
      ),
    ).toBe(true);
    resize();
    fireEvent.scroll(viewport());
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(viewport().scrollTop).toBe(initialTop + 20);
  });

  it.each([
    "wheel",
    "pointerdown",
    "touchstart",
    "keyboard",
  ])(
    "lets %s input interrupt an animation and keeps later messages from pulling the reader down",
    (input) => {
      deferSmoothScroll = true;
      renderChat();
      readHistory();
      fireEvent.click(
        screen.getByRole("button", {
          name: "client.scroll_to_bottom",
        }),
      );
      viewport().scrollTop = 400;
      fireEvent.scroll(viewport());
      scrollTo.mockClear();
      if (input === "wheel")
        fireEvent.wheel(viewport(), { deltaY: -100 });
      else if (input === "keyboard")
        fireEvent.keyDown(viewport(), { key: "PageUp" });
      else
        fireEvent(
          viewport(),
          new Event(input, { bubbles: true }),
        );
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith({
        top: 400,
        behavior: "instant",
      });
      expect(
        screen.queryByRole("button", {
          name: "client.scroll_to_bottom",
        }),
      ).not.toBeNull();
      scrollTo.mockClear();
      append(40, 41);
      resize();
      fireEvent.scroll(viewport());
      expect(viewport().scrollTop).toBe(400);
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );

  it("ignores scrolling keys inside form controls and modified keyboard shortcuts", () => {
    deferSmoothScroll = true;
    renderChat();
    append(40);
    const input = document.createElement("input");
    viewport().append(input);
    scrollTo.mockClear();
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(viewport(), {
      key: "Home",
      ctrlKey: true,
    });
    resize();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    ).toBeNull();
  });

  it("respects reduced motion for new messages and the return-to-bottom button", () => {
    deferSmoothScroll = true;
    Object.assign(motionQuery, { matches: true });
    renderChat();
    append(40);
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "instant",
    });
    expect(viewport().scrollTop).toBe(bottom());
    readHistory();
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.scroll_to_bottom",
      }),
    );
    expect(viewport().scrollTop).toBe(bottom());
    expect(
      scrollTo.mock.calls.every(
        ([options]) => options.behavior === "instant",
      ),
    ).toBe(true);
  });

  it("finishes an active animation when reduced motion is enabled", () => {
    deferSmoothScroll = true;
    renderChat();
    append(40);
    expect(viewport().scrollTop).toBeLessThan(bottom());
    Object.assign(motionQuery, { matches: true });
    motionQuery.dispatchEvent(new Event("change"));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "instant",
    });
    expect(viewport().scrollTop).toBe(bottom());
  });

  it("cancels a native animation and its input listeners when switching conversations", async () => {
    deferSmoothScroll = true;
    const { navigate } = renderChat();
    append(40);
    const old = viewport();
    await navigate("/client/other/chat");
    await waitFor(() =>
      expect(screen.queryByText("other-29")).not.toBeNull(),
    );
    expect(viewport().scrollTop).toBe(bottom());
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: bottom(),
      behavior: "instant",
    });
    scrollTo.mockClear();
    fireEvent.wheel(old, { deltaY: -100 });
    fireEvent.scroll(old);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("disconnects observers and ignores queued callbacks after leaving chat", () => {
    const { unmount } = renderChat();
    const element = viewport();
    const observer = TestResizeObserver.instances.find(
      (item) => item.targets.has(element),
    )!;
    unmount();
    scrollTo.mockClear();
    observer.deliver(element);
    fireEvent.scroll(element);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      TestResizeObserver.instances.every(
        (item) => item.targets.size === 0,
      ),
    ).toBe(true);
  });
});
