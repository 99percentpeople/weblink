import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";

export function TextMessageContent(props: {
  text: string;
  onExpand?: (expand: () => void) => void;
}) {
  const id = createUniqueId();
  const [expanded, setExpanded] = createSignal(false);
  const [previewEnd, setPreviewEnd] =
    createSignal<number>();
  const visibleEnd = () =>
    expanded()
      ? props.text.length
      : (previewEnd() ?? props.text.length);
  let content!: HTMLParagraphElement;

  const disclosure = (
    <span class="whitespace-nowrap">
      <span aria-hidden="true">…</span>
      <Button
        type="button"
        variant="link"
        class="h-auto p-0 align-baseline text-xs"
        aria-controls={id}
        aria-expanded={false}
        onClick={() => {
          const expand = () => setExpanded(true);
          if (props.onExpand) props.onExpand(expand);
          else expand();
        }}
      >
        {t("common.show_more")}
      </Button>
    </span>
  ) as HTMLSpanElement;

  createEffect(() => {
    const text = props.text;
    t("common.show_more");
    if (expanded()) return;
    let boundaries: number[] | undefined;
    const measure = () => {
      if (!content.clientWidth) return;
      // Measure at the paragraph's actual width without moving live text or
      // focus. The inline suffix participates in wrapping just like the text.
      const probe = content.cloneNode(
        false,
      ) as HTMLParagraphElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "fixed",
        top: "0",
        left: "0",
        visibility: "hidden",
        pointerEvents: "none",
        width: getComputedStyle(content).width,
      });
      probe.textContent = text;
      content.after(probe);
      const fits = () =>
        probe.scrollHeight <= probe.clientHeight + 1;
      try {
        if (fits()) {
          setPreviewEnd(undefined);
          return;
        }
        // Keep emoji, combining marks and other grapheme clusters intact.
        boundaries ??= [
          0,
          ...Array.from(
            new Intl.Segmenter(undefined, {
              granularity: "grapheme",
            }).segment(text),
            (part) => part.index + part.segment.length,
          ),
        ];
        const candidate = document.createTextNode("");
        probe.replaceChildren(
          candidate,
          disclosure.cloneNode(true),
        );
        let start = 0;
        let end = boundaries.length - 1;
        while (start < end) {
          const middle = Math.ceil((start + end) / 2);
          candidate.data = text
            .slice(0, boundaries[middle])
            .trimEnd();
          if (fits()) start = middle;
          else end = middle - 1;
        }
        setPreviewEnd(
          text.slice(0, boundaries[start]).trimEnd().length,
        );
      } finally {
        probe.remove();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    const controller = new AbortController();
    document.fonts?.addEventListener(
      "loadingdone",
      measure,
      {
        signal: controller.signal,
      },
    );
    onCleanup(() => {
      observer.disconnect();
      controller.abort();
    });
  });

  return (
    <p
      ref={content}
      class={cn(
        "whitespace-pre-wrap",
        !expanded() && "max-h-[24lh] overflow-hidden",
      )}
    >
      <span id={id} data-slot="message-text">
        {props.text.slice(0, visibleEnd())}
        <span hidden>{props.text.slice(visibleEnd())}</span>
      </span>
      <Show
        when={!expanded() && previewEnd() !== undefined}
      >
        {disclosure}
      </Show>
    </p>
  );
}
