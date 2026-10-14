// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
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
import { TextMessageContent } from "@/components/conversations/text-message-content";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

class TextResizeObserver {
  static instances: TextResizeObserver[] = [];
  target?: Element;
  disconnect = vi.fn();
  constructor(readonly notify: () => void) {
    TextResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
}

let availableCharacters = Infinity;

beforeEach(() => {
  TextResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TextResizeObserver);
  availableCharacters = Infinity;
  // Model available text capacity; actual line wrapping is the browser's job.
  vi.spyOn(
    HTMLElement.prototype,
    "clientWidth",
    "get",
  ).mockReturnValue(100);
  vi.spyOn(
    HTMLElement.prototype,
    "clientHeight",
    "get",
  ).mockReturnValue(100);
  vi.spyOn(
    HTMLElement.prototype,
    "scrollHeight",
    "get",
  ).mockImplementation(function (this: HTMLElement) {
    return (this.textContent?.length ?? 0) >
      availableCharacters
      ? 200
      : 100;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resize(text: HTMLElement, overflowing: boolean) {
  availableCharacters = overflowing ? 32 : Infinity;
  const observer = TextResizeObserver.instances.findLast(
    (item) => item.target === text,
  )!;
  observer.notify();
  return observer;
}

describe("long message disclosure", () => {
  it("offers Show more only while the unexpanded text overflows and cleans up on removal", () => {
    const view = render(() => (
      <TextMessageContent text="A message with enough text to demonstrate overflow" />
    ));
    const text = view.container.querySelector("p")!;
    const more = () =>
      view.queryByRole("button", {
        name: "common.show_more",
      });
    expect(more()).toBeNull();
    const observer = resize(text, true);
    expect(more()).toHaveAttribute(
      "aria-controls",
      text.querySelector('[data-slot="message-text"]')!.id,
    );
    expect(more()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    resize(text, false);
    expect(more()).toBeNull();
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("expands once through its scroll owner, retaining the full text and no collapse action", () => {
    const original =
      "First paragraph\n\n" + "A long message\n".repeat(20);
    const [value, setValue] = createSignal(original);
    const onExpand = vi.fn((expand: () => void) =>
      expand(),
    );
    const view = render(() => (
      <TextMessageContent
        text={value()}
        onExpand={onExpand}
      />
    ));
    const text = view.container.querySelector("p")!;
    const observer = resize(text, true);
    expect(
      text.querySelector('[data-slot="message-text"]')!
        .textContent,
    ).toBe(original);
    fireEvent.click(
      view.getByRole("button", {
        name: "common.show_more",
      }),
    );
    expect(onExpand).toHaveBeenCalledOnce();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.container.querySelector("p")).toBe(text);
    expect(text.textContent).toBe(original);
    expect(observer.disconnect).toHaveBeenCalledOnce();
    setValue(original + "More text");
    expect(view.queryByRole("button")).toBeNull();
    expect(text.textContent).toBe(original + "More text");
  });

  it("preserves grapheme clusters and the original text when finding an inline preview", () => {
    const grapheme = "👩🏽‍💻e\u0301";
    const original = grapheme.repeat(20);
    const view = render(() => (
      <TextMessageContent text={original} />
    ));
    const text = view.container.querySelector("p")!;
    resize(text, true);
    const message = text.querySelector(
      '[data-slot="message-text"]',
    )!;
    const preview = message.firstChild!.textContent!;
    expect(preview.length).toBeGreaterThan(0);
    const boundaries = Array.from(
      new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(original),
      (part) => part.index + part.segment.length,
    );
    expect(boundaries).toContain(preview.length);
    expect(original.startsWith(preview)).toBe(true);
    expect(message.textContent).toBe(original);
    expect(
      view.container.querySelectorAll("p"),
    ).toHaveLength(1);
    fireEvent.click(view.getByRole("button"));
    expect(text.textContent).toBe(original);
  });
});
