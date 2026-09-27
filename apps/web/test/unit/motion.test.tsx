// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { ChatScrollButton } from "@/components/conversations/chat-scroll-button";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconArrowDownward: () => null,
}));

const engine = vi.hoisted(() => ({
  animations: [] as {
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    complete(): void;
    finished: Promise<void>;
  }[],
}));
vi.mock("motion", () => ({
  animate: vi.fn(() => {
    let resolve!: () => void;
    const finished = new Promise<void>((done) => {
      resolve = done;
    });
    const controls = {
      finished,
      stop: vi.fn(),
      cancel: vi.fn(),
      complete: () => resolve(),
    };
    engine.animations.push(controls);
    return controls;
  }),
}));
beforeEach(() => {
  engine.animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Example() {
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <button onClick={() => setOpen((value) => !value)}>
        Toggle
      </button>
      <AnimatePresence when={open()}>
        <Motion.div
          data-testid="panel"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          Panel
        </Motion.div>
      </AnimatePresence>
    </>
  );
}

describe("Motion component lifecycle", () => {
  it("cancels unrendered animations and still applies updates and completes exit", async () => {
    const [opacity, setOpacity] = createSignal(1);
    const [present, setPresent] = createSignal(true);
    let parent!: HTMLDivElement;
    render(() => (
      <div ref={parent}>
        <AnimatePresence when={present()}>
          <Motion.div
            data-testid="panel"
            animate={{ opacity: opacity() }}
            exit={{ opacity: 0 }}
          />
        </AnimatePresence>
      </div>
    ));
    const panel = screen.getByTestId("panel");
    const failCommit = () => {
      throw new DOMException(
        "Target element is not rendered",
        "InvalidStateError",
      );
    };
    const entering = engine.animations.at(-1)!;
    entering.stop.mockImplementation(failCommit);
    parent.style.display = "none";
    expect(() => setOpacity(0.5)).not.toThrow();
    expect(entering.cancel).toHaveBeenCalledOnce();
    expect(engine.animations).toHaveLength(2);
    expect(screen.getByTestId("panel")).toBe(panel);
    const updated = engine.animations.at(-1)!;
    updated.stop.mockImplementation(failCommit);
    expect(() => setPresent(false)).not.toThrow();
    expect(updated.cancel).toHaveBeenCalledOnce();
    expect(panel).toBeInTheDocument();
    engine.animations.at(-1)!.complete();
    await waitFor(() =>
      expect(panel).not.toBeInTheDocument(),
    );
  });

  it("does not suppress unrelated animation failures", () => {
    const [opacity, setOpacity] = createSignal(1);
    render(() => (
      <Motion.div animate={{ opacity: opacity() }} />
    ));
    const error = new TypeError("Invalid animation target");
    engine.animations
      .at(-1)!
      .stop.mockImplementation(() => {
        throw error;
      });
    expect(() => setOpacity(0.5)).toThrow(error);
    expect(engine.animations).toHaveLength(1);
  });

  it("composes the chat button with UI Button, disabling exit and retaining rapid reopen", async () => {
    const [visible, setVisible] = createSignal(true);
    const onClick = vi.fn(() => setVisible(false));
    render(() => (
      <ChatScrollButton
        visible={visible()}
        onClick={onClick}
      />
    ));
    const button = screen.getByRole("button", {
      name: "client.scroll_to_bottom",
    });
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveProperty("inert", true);
    expect(screen.queryByRole("button")).toBeNull();
    const exit = engine.animations.at(-1)!;
    setVisible(true);
    exit.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByRole("button")).toBe(button);
    expect(button).toBeEnabled();
  });

  it("retains the child during exit and removes it after completion", async () => {
    render(Example);
    const panel = screen.getByTestId("panel");
    screen.getByRole("button").click();
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveProperty("inert", true);
    expect(panel).toHaveAttribute("aria-hidden", "true");
    engine.animations.at(-1)!.complete();
    await waitFor(() =>
      expect(panel).not.toBeInTheDocument(),
    );
  });
  it("keeps the same child when reopening interrupts an exit", async () => {
    render(Example);
    const panel = screen.getByTestId("panel");
    screen.getByRole("button").click();
    const exit = engine.animations.at(-1)!;
    screen.getByRole("button").click();
    expect(exit.stop).toHaveBeenCalledOnce();
    exit.complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("panel")).toBe(panel);
    expect(panel.inert).not.toBe(true);
    cleanup();
    expect(
      engine.animations.at(-1)!.cancel,
    ).toHaveBeenCalledOnce();
  });
  it("runs exit completion while the leaving child is still available to its owner", async () => {
    const [present, setPresent] = createSignal(true);
    const [owned, setOwned] = createSignal(true);
    const complete = vi.fn(() => {
      expect(
        screen.getByTestId("panel"),
      ).toBeInTheDocument();
      setOwned(false);
    });
    render(() => (
      <Show when={owned()}>
        <AnimatePresence
          when={present()}
          onExitComplete={complete}
        >
          <Motion.div
            data-testid="panel"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        </AnimatePresence>
      </Show>
    ));
    setPresent(false);
    engine.animations.at(-1)!.complete();
    await waitFor(() =>
      expect(complete).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("does not delay removal when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(Example);
    screen.getByRole("button").click();
    expect(screen.queryByTestId("panel")).toBeNull();
  });
});
