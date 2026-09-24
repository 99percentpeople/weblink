// @vitest-environment jsdom
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ChatFileDropArea } from "@/components/conversations/chat-file-drop-area";

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
  error: vi.fn(),
  animations: [] as {
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    complete(): void;
    finished: Promise<void>;
  }[],
}));
vi.mock("motion", () => ({
  animate: () => {
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controls = {
      stop: vi.fn(),
      cancel: vi.fn(),
      complete,
      finished,
    };
    mock.animations.push(controls);
    return controls;
  },
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleDropItems: mock.read,
}));
vi.mock("solid-sonner", () => ({
  toast: {
    loading: mock.loading,
    dismiss: mock.dismiss,
    error: mock.error,
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/user-error", () => ({
  userErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/components/icons", () => ({
  IconClose: () => null,
  IconPlaceItem: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const [key, setKey] = createSignal("first");
  const [disabled, setDisabled] = createSignal(false);
  const send = vi.fn().mockResolvedValue(undefined);
  const sent = vi.fn();
  const view = render(() => (
    <ChatFileDropArea
      conversationKey={key()}
      disabled={disabled()}
      onSendFile={send}
      onSent={sent}
    >
      <header>Header</header>
      <main>Messages</main>
      <textarea />
    </ChatFileDropArea>
  ));
  const drop = (
    files = [new File(["a"], "a.txt")],
    items: unknown[] = [{}],
  ) => {
    const event = new Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    const data = {
      types: ["Files"],
      items,
      files,
      dropEffect: "none",
    };
    Object.defineProperty(event, "dataTransfer", {
      value: data,
    });
    view.container
      .querySelector("textarea")!
      .dispatchEvent(event);
    return event;
  };
  const drag = (type: string) => {
    const event = new Event(type, {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], dropEffect: "none" },
    });
    view.container
      .querySelector("textarea")!
      .dispatchEvent(event);
  };
  const overlay = () =>
    view.container.querySelector(
      '[data-slot="chat-drop-overlay"]',
    );
  return {
    ...view,
    setKey,
    setDisabled,
    send,
    sent,
    drop,
    drag,
    overlay,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  mock.loading.mockReturnValue("processing");
  mock.read.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat drop overlay transitions", () => {
  it("starts processing immediately and retains the accepted hint until fade-out completes", async () => {
    const pending = deferred<File[]>();
    mock.read.mockReturnValue(pending.promise);
    const view = setup();
    view.drag("dragenter");
    const overlay = view.overlay()!;
    expect(overlay).toBeTruthy();
    const hint = overlay.textContent;
    view.drop();
    expect(mock.read).toHaveBeenCalledOnce();
    expect(view.overlay()).toBe(overlay);
    expect(overlay.textContent).toBe(hint);
    expect(overlay).toHaveProperty("inert", true);
    mock.animations.at(-1)!.complete();
    await waitFor(() => expect(view.overlay()).toBeNull());
    pending.resolve([]);
    await pending.promise;
  });

  it("reuses the overlay when re-entering during fade-out", async () => {
    const view = setup();
    view.drag("dragenter");
    const overlay = view.overlay();
    view.drag("dragleave");
    const exit = mock.animations.at(-1)!;
    view.drag("dragenter");
    expect(exit.stop).toHaveBeenCalledOnce();
    exit.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.overlay()).toBe(overlay);
    const count = mock.animations.length;
    view.drag("dragover");
    expect(mock.animations).toHaveLength(count);
    view.drag("dragleave");
    mock.animations.at(-1)!.complete();
    await waitFor(() => expect(view.overlay()).toBeNull());
  });

  it("does not wait for an exit when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const view = setup();
    view.drag("dragenter");
    expect(view.overlay()).toBeTruthy();
    view.drag("dragleave");
    expect(view.overlay()).toBeNull();
  });
});

describe("chat file drop processing", () => {
  it("reads drop entries synchronously and sends all prepared files in order", async () => {
    const files = [
      new File(["one"], "one.txt"),
      new File(["zip"], "folder.zip"),
    ];
    mock.read.mockResolvedValue(files);
    const view = setup();
    expect(view.drop().defaultPrevented).toBe(true);
    expect(mock.read).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(view.sent).toHaveBeenCalledOnce(),
    );
    expect(view.send.mock.calls).toEqual(
      files.map((file) => [file]),
    );
    expect(mock.dismiss).toHaveBeenCalledWith("processing");
    expect(mock.error).not.toHaveBeenCalled();
  });

  it("falls back to FileList when no drag items are available", async () => {
    const file = new File(["file"], "fallback.txt");
    const view = setup();
    view.drop([file], []);
    await waitFor(() =>
      expect(view.send).toHaveBeenCalledWith(file),
    );
    expect(mock.read).not.toHaveBeenCalled();
  });

  it.each([
    "conversation",
    "disabled",
    "unmount",
    "cancel",
  ])(
    "aborts pending preparation on %s without sending or error toasts",
    async (reason) => {
      const pending = deferred<File[]>();
      mock.read.mockReturnValue(pending.promise);
      const view = setup();
      view.drop();
      const signal = mock.read.mock
        .calls[0][1] as AbortSignal;
      if (reason === "conversation") view.setKey("second");
      else if (reason === "disabled")
        view.setDisabled(true);
      else if (reason === "unmount") view.unmount();
      else mock.loading.mock.calls[0][1].action.onClick();
      expect(signal.aborted).toBe(true);
      expect(mock.dismiss).toHaveBeenCalledWith(
        "processing",
      );
      // Even a reader which ignores abort must not publish its late result.
      pending.resolve([new File(["late"], "late.txt")]);
      await pending.promise;
      expect(view.send).not.toHaveBeenCalled();
      expect(view.sent).not.toHaveBeenCalled();
      expect(mock.error).not.toHaveBeenCalled();
    },
  );

  it("does not resume a cancelled batch after switching away and back", async () => {
    const pending = deferred<File[]>();
    mock.read.mockReturnValue(pending.promise);
    const view = setup();
    view.drop();
    view.setKey("second");
    view.setKey("first");
    pending.resolve([new File(["late"], "late.txt")]);
    await pending.promise;
    expect(view.send).not.toHaveBeenCalled();
  });

  it("ignores a duplicate drop while preparation is in flight", async () => {
    const pending = deferred<File[]>();
    mock.read.mockReturnValue(pending.promise);
    const view = setup();
    view.drop();
    view.drop();
    expect(mock.read).toHaveBeenCalledOnce();
    pending.resolve([new File(["one"], "one.txt")]);
    await waitFor(() =>
      expect(view.sent).toHaveBeenCalledOnce(),
    );
    expect(view.send).toHaveBeenCalledOnce();
  });

  it("stops remaining files if the conversation changes during the first send", async () => {
    const pending = deferred<void>();
    mock.read.mockResolvedValue([
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
    ]);
    const view = setup();
    view.send.mockReturnValue(pending.promise);
    view.drop();
    await waitFor(() =>
      expect(view.send).toHaveBeenCalledOnce(),
    );
    view.setKey("second");
    pending.resolve();
    await pending.promise;
    expect(view.send).toHaveBeenCalledOnce();
    expect(view.sent).not.toHaveBeenCalled();
  });

  it.each(["prepare", "send"])(
    "reports %s failures and allows a later retry",
    async (stage) => {
      const view = setup();
      const file = new File(["retry"], "retry.txt");
      mock.read.mockResolvedValue([file]);
      if (stage === "prepare")
        mock.read.mockRejectedValueOnce(
          new Error("Failed"),
        );
      else
        view.send.mockRejectedValueOnce(
          new Error("Failed"),
        );
      view.drop();
      await waitFor(() =>
        expect(mock.error).toHaveBeenCalledWith("Failed"),
      );
      view.drop();
      await waitFor(() =>
        expect(view.sent).toHaveBeenCalledOnce(),
      );
    },
  );
});
