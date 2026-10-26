import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
} from "solid-js";
import type { ActionFanSpace } from "./meeting-action-fan";

/** Position action menus against the real viewport, outside video clipping. */
export function createPortaledActionMenu(options: {
  radial(): boolean;
  open(): boolean;
  anchor(): HTMLElement;
  panel(): HTMLElement;
  mount(): Node | undefined;
}): { space: Accessor<ActionFanSpace | undefined> } {
  const [space, setSpace] = createSignal<ActionFanSpace>();
  onMount(() => {
    createEffect(() => {
      options.mount();
      if (!options.open()) return;
      const anchor = options.anchor();
      const panel = options.panel();
      const win = anchor.ownerDocument.defaultView!;
      const viewport = win.visualViewport;
      const life = new AbortController();
      let frame = 0;
      let previous = "";

      const update = () => {
        const rect = anchor.getBoundingClientRect();
        const left = (viewport?.offsetLeft ?? 0) + 8;
        const top = (viewport?.offsetTop ?? 0) + 8;
        const right =
          left + (viewport?.width ?? win.innerWidth) - 16;
        const bottom =
          top + (viewport?.height ?? win.innerHeight) - 16;
        const next = {
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
          x: rect.left - left,
          y: rect.top - top,
          size: rect.width,
        };
        setSpace((previous) =>
          previous &&
          previous.width === next.width &&
          previous.height === next.height &&
          previous.x === next.x &&
          previous.y === next.y &&
          previous.size === next.size
            ? previous
            : next,
        );
        if (untrack(options.radial)) {
          panel.style.left = `${rect.left}px`;
          panel.style.top = `${rect.top}px`;
          panel.style.width = `${rect.width}px`;
          panel.style.height = `${rect.height}px`;
          return;
        }
        panel.style.removeProperty("width");
        panel.style.removeProperty("height");
        const available = Math.max(0, bottom - top);
        const above = Math.max(
          0,
          Math.min(available, rect.top - top - 4),
        );
        const below = Math.max(
          0,
          Math.min(available, bottom - rect.bottom - 4),
        );
        panel.style.setProperty(
          "--portaled-menu-width",
          `${Math.max(0, right - left)}px`,
        );
        panel.style.setProperty(
          "--portaled-menu-height",
          `${Math.max(above, below)}px`,
        );
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const x = Math.max(
          left,
          Math.min(right - width, rect.right - width),
        );
        const y =
          above >= height || above >= below
            ? rect.top - height - 4
            : rect.bottom + 4;
        panel.style.left = `${x}px`;
        panel.style.top = `${Math.max(top, Math.min(bottom - height, y))}px`;
      };
      const follow = () => {
        // Transform animations do not notify ResizeObserver. Follow only the
        // open menu's anchor, including animated thumbnail-rail transitions.
        const rect = anchor.getBoundingClientRect();
        const current = `${rect.left},${rect.top},${rect.width},${rect.height}`;
        if (current !== previous) {
          previous = current;
          update();
        }
        frame = win.requestAnimationFrame(follow);
      };
      const observer = new ResizeObserver(update);
      observer.observe(anchor);
      observer.observe(panel);
      win.addEventListener("resize", update, {
        signal: life.signal,
      });
      win.addEventListener("scroll", update, {
        capture: true,
        signal: life.signal,
      });
      viewport?.addEventListener("resize", update, {
        signal: life.signal,
      });
      viewport?.addEventListener("scroll", update, {
        signal: life.signal,
      });
      update();
      frame = win.requestAnimationFrame(follow);
      onCleanup(() => {
        life.abort();
        observer.disconnect();
        win.cancelAnimationFrame(frame);
      });
    });
  });
  return { space };
}
