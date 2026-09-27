import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import DropArea, {
  type DropAreaState,
} from "@/components/drop-area";
import { ChatDropOverlay } from "@/components/conversations/chat-drop-overlay";
import "@/global.css";

const assert: (
  value: unknown,
  message: string,
) => asserts value = (value, message) => {
  if (!value) throw new Error(message);
};
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve()),
  );
const [disabled, setDisabled] = createSignal(false);
let area!: HTMLElement;
let deliveries = 0;
let clicks = 0;
let dropped: File | undefined;
let dragState!: DropAreaState;
const dispose = render(
  () => (
    <DropArea
      ref={(element) => (area = element)}
      disabled={disabled()}
      class="relative isolate m-4 flex flex-col gap-3 border p-4"
      overlay={(state) => {
        dragState = state;
        return <ChatDropOverlay state={state} />;
      }}
      onDrop={(event) => {
        deliveries++;
        dropped = event.dataTransfer?.files[0];
      }}
    >
      <button
        data-probe="button"
        class="cursor-pointer"
        onClick={() => clicks++}
      >
        Button
      </button>
      <button
        data-probe="disabled button"
        disabled
        class="cursor-not-allowed"
      >
        Disabled button
      </button>
      <label data-probe="label" class="cursor-pointer">
        Attachment label
        <input type="file" class="hidden" />
      </label>
      <input data-probe="file input" type="file" />
      <textarea data-probe="textarea" class="cursor-text">
        Keep this draft
      </textarea>
      <a
        data-probe="link"
        href="#link"
        class="cursor-pointer"
      >
        Link
      </a>
      <div
        data-probe="editable"
        contentEditable
        class="cursor-text"
      >
        Editable content
      </div>
      <svg
        data-probe="svg"
        width="24"
        height="24"
        class="cursor-pointer"
      >
        <rect width="24" height="24" />
      </svg>
    </DropArea>
  ),
  document.getElementById("root")!,
);
const controls = () =>
  Array.from(
    area.querySelectorAll<HTMLElement>("[data-probe]"),
  );
const center = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
};
const hit = (element: Element) => {
  const point = center(element);
  return document.elementFromPoint(point.x, point.y)!;
};
const overlay = () =>
  area.querySelector<HTMLElement>(
    '[data-slot="chat-drop-overlay"]',
  );
const transfer = () => {
  const data = new DataTransfer();
  data.items.add(new File(["file bytes"], "drop.txt"));
  return data;
};
function drag(
  type: string,
  point: { x: number; y: number },
  data = transfer(),
) {
  const target = document.elementFromPoint(
    point.x,
    point.y,
  )!;
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    dataTransfer: data,
  });
  target.dispatchEvent(event);
  return { event, data, target };
}
function restored() {
  for (const control of controls())
    assert(
      control.contains(hit(control)),
      `${control.dataset.probe}: interaction was not restored`,
    );
}

async function main() {
  await frame();
  restored();
  const originalDraft =
    area.querySelector("textarea")!.value;
  let sampled = 0;
  for (const entry of controls()) {
    const begin = drag("dragenter", center(entry));
    assert(
      begin.event.defaultPrevented,
      `${entry.dataset.probe}: file entry was not accepted`,
    );
    await frame();
    const surface = overlay();
    assert(surface, "Drop overlay was not mounted");
    // Test the browser's actual hit testing, not dispatchEvent on a chosen child.
    // A passing event-handler test alone cannot detect control cursor leakage.
    for (let pass = 0; pass < 2; pass++) {
      for (const control of controls()) {
        const result = drag("dragover", center(control));
        assert(
          result.target === surface,
          `${control.dataset.probe}: drag still hits an underlying control`,
        );
        assert(
          result.event.defaultPrevented,
          `${control.dataset.probe}: file drag was not handled`,
        );
        assert(
          getComputedStyle(result.target).cursor === "copy",
          "Drag cursor was not consistent",
        );
        assert(
          overlay() === surface,
          "Overlay was remounted while moving across controls",
        );
        sampled++;
      }
    }
    // The icon and hint must not introduce more hit targets either.
    assert(
      hit(surface.querySelector("span")!) === surface,
      "Overlay hint intercepted the drag",
    );
    setDisabled(true);
    const rejected = drag("dragover", center(entry));
    assert(
      rejected.target === surface &&
        rejected.event.defaultPrevented,
      "Disabled drop did not reject the file",
    );
    assert(
      getComputedStyle(surface).cursor === "not-allowed",
      "Disabled drag has the wrong cursor",
    );
    setDisabled(false);
    const before = deliveries;
    drag("drop", center(entry));
    assert(
      deliveries === before + 1 &&
        dropped?.name === "drop.txt",
      "Drop was lost or delivered more than once",
    );
    // Interaction must return synchronously, not after the exit animation.
    restored();
    const button = controls()[0];
    hit(button).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    assert(
      clicks === deliveries,
      "Click was blocked during fade-out",
    );
  }
  assert(
    area.querySelector("textarea")!.value === originalDraft,
    "Dragging modified the draft",
  );
  const text = new DataTransfer();
  text.setData("text/plain", "selected text");
  const ordinary = drag(
    "dragenter",
    center(controls()[0]),
    text,
  );
  assert(
    !ordinary.event.defaultPrevented,
    "Text drag was intercepted",
  );
  restored();
  drag("dragenter", center(controls()[0]));
  await frame();
  drag("dragover", { x: 1, y: 1 });
  restored();
  drag("dragenter", center(controls()[0]));
  await frame();
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape" }),
  );
  restored();
  // Leave the fixture mounted for the runner's native file drag checks.
  const events: {
    type: string;
    target: string | null;
    relatedTarget: string | null;
    effect?: string;
    trusted: boolean;
  }[] = [];
  const name = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.getAttribute("data-slot") ??
        target.getAttribute("data-probe") ??
        target.tagName)
      : null;
  for (const type of [
    "dragenter",
    "dragover",
    "dragleave",
    "drop",
    "dragend",
  ]) {
    area.addEventListener(type, (event) => {
      const drag = event as DragEvent;
      events.push({
        type,
        target: name(drag.target),
        relatedTarget: name(drag.relatedTarget),
        effect: drag.dataTransfer?.dropEffect,
        trusted: drag.isTrusted,
      });
    });
  }
  Object.assign(window, {
    __DROP_TEST__: {
      prepare(rejected: boolean) {
        setDisabled(rejected);
        events.length = 0;
        return controls().map(center);
      },
      setDisabled,
      snapshot() {
        return {
          active: dragState.active,
          accepted: dragState.accepted,
          deliveries,
          restored: controls().every((control) =>
            control.contains(hit(control)),
          ),
          events,
        };
      },
    },
  });
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    controls: 8,
    hitTargetChecks: sampled,
    deliveries,
    checks: [
      "control hit isolation",
      "stable cursor",
      "disabled state",
      "single delivery",
      "immediate interaction restoration",
      "draft retained",
      "text drag unaffected",
      "outside leave",
      "Escape cancellation",
    ],
  };
}
main().catch((error) => {
  dispose();
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
