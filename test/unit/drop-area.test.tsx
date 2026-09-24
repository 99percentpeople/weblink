// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import DropArea from "@/components/drop-area";

const files = () => ({
  types: ["Files"],
  dropEffect: "none",
});
function drag(
  target: EventTarget,
  type: string,
  dataTransfer = files(),
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return event;
}
function setup() {
  const [disabled, setDisabled] = createSignal(false);
  const onDrop = vi.fn();
  const view = render(() => (
    <DropArea
      disabled={disabled()}
      onDrop={onDrop}
      overlay={(state) => (
        <Show when={state.active}>
          <output data-testid="overlay">
            {state.accepted ? "accepted" : "rejected"}
          </output>
        </Show>
      )}
    >
      <header>Header</header>
      <main>
        <span>Message</span>
      </main>
      <textarea aria-label="Message input" />
    </DropArea>
  ));
  return {
    ...view,
    root: view.container.firstElementChild!,
    onDrop,
    setDisabled,
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("file drop area", () => {
  it("keeps one overlay through child transitions with null relatedTarget and repeated dragover", () => {
    const { root } = setup();
    const header = root.querySelector("header")!;
    const message = root.querySelector("span")!;
    const transfer = files();
    drag(root, "dragenter", transfer);
    const overlay = screen.getByTestId("overlay");
    drag(header, "dragenter", transfer);
    drag(root, "dragleave", transfer);
    expect(screen.getByTestId("overlay")).toBe(overlay);
    drag(message, "dragenter", transfer);
    drag(header, "dragleave", transfer);
    for (let i = 0; i < 5; i++) {
      transfer.dropEffect = "none";
      expect(
        drag(message, "dragover", transfer)
          .defaultPrevented,
      ).toBe(true);
      expect(transfer.dropEffect).toBe("copy");
      expect(screen.getByTestId("overlay")).toBe(overlay);
    }
    drag(message, "dragleave", transfer);
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("does not leave when relatedTarget is another descendant", () => {
    const { root } = setup();
    const header = root.querySelector("header")!;
    const input = root.querySelector("textarea")!;
    drag(header, "dragenter");
    const overlay = screen.getByTestId("overlay");
    drag(header, "dragleave", files(), input);
    expect(screen.getByTestId("overlay")).toBe(overlay);
    drag(input, "dragenter");
    drag(input, "dragleave", files(), document.body);
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("handles duplicate dragenter and a dragover without dragenter", () => {
    const { root } = setup();
    drag(root, "dragenter");
    drag(root, "dragenter");
    drag(root, "dragleave");
    expect(screen.queryByTestId("overlay")).toBeNull();
    drag(root, "dragover");
    expect(screen.getByTestId("overlay")).toBeTruthy();
    drag(root, "dragleave");
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("rejects files while disabled, including a permission change during dragging", () => {
    const { root, setDisabled, onDrop } = setup();
    const transfer = files();
    drag(root, "dragenter", transfer);
    expect(transfer.dropEffect).toBe("copy");
    setDisabled(true);
    drag(root, "dragover", transfer);
    expect(transfer.dropEffect).toBe("none");
    expect(screen.getByTestId("overlay").textContent).toBe(
      "rejected",
    );
    expect(
      drag(root, "drop", transfer).defaultPrevented,
    ).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("leaves text and link dragging alone", () => {
    const { root, onDrop } = setup();
    for (const type of ["dragenter", "dragover", "drop"]) {
      const transfer = {
        types: ["text/plain", "text/uri-list"],
        dropEffect: "move",
      };
      expect(
        drag(root, type, transfer).defaultPrevented,
      ).toBe(false);
      expect(transfer.dropEffect).toBe("move");
    }
    expect(screen.queryByTestId("overlay")).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("handles a child drop once and clears the overlay before calling the consumer", () => {
    const { root, onDrop } = setup();
    const input = root.querySelector("textarea")!;
    drag(input, "dragenter");
    onDrop.mockImplementation(() =>
      expect(screen.queryByTestId("overlay")).toBeNull(),
    );
    const event = drag(input, "drop");
    expect(event.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(event);
  });

  it("does not send a nested drop to its parent too", () => {
    const outer = vi.fn(),
      inner = vi.fn();
    const { container } = render(() => (
      <DropArea onDrop={outer}>
        <DropArea onDrop={inner}>
          <span>Target</span>
        </DropArea>
      </DropArea>
    ));
    drag(container.querySelector("span")!, "drop");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it.each([
    "drop",
    "dragend",
    "blur",
    "dragleave",
    "dragover",
    "escape",
  ])(
    "clears stale state on %s outside the area",
    (type) => {
      const { root } = setup();
      drag(root, "dragenter");
      if (type === "escape")
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape" }),
        );
      else drag(document.documentElement, type);
      expect(screen.queryByTestId("overlay")).toBeNull();
    },
  );

  it("releases global cancellation listeners on unmount", () => {
    const listen = vi.spyOn(window, "addEventListener");
    const { unmount } = setup();
    const options = listen.mock.calls
      .filter(([type]) => String(type) === "dragend")
      .at(-1)![2] as AddEventListenerOptions;
    expect(options.signal?.aborted).toBe(false);
    unmount();
    expect(options.signal?.aborted).toBe(true);
  });
});
