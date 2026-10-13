import { createLoopingTrack } from "./looping-track";
import { setupTheme } from "./theme";
import { setupLanguage } from "./i18n";

const controller = new AbortController();
const { signal } = controller;

const i18n = setupLanguage(signal);
setupTheme(signal, i18n);

// Enhance the screenshot gallery; the first scene also works without JS.
const showcase =
  document.querySelector<HTMLElement>(".showcase");
const tabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(
    '[role="tab"]',
  ),
);
const track =
  showcase?.querySelector<HTMLElement>(".demo-track");
const panels = tabs
  .map((tab) =>
    document.getElementById(
      tab.getAttribute("aria-controls") ?? "",
    ),
  )
  .filter((panel): panel is HTMLElement => panel !== null);
const initialIndex = Math.max(
  0,
  tabs.findIndex(
    (tab) => tab.getAttribute("aria-selected") === "true",
  ),
);
const loopingTrack = track
  ? createLoopingTrack(track, panels, signal, initialIndex)
  : undefined;
const tabList =
  showcase?.querySelector<HTMLElement>(".demo-tabs");
const tabHighlight = showcase?.querySelector<HTMLElement>(
  ".demo-tab-highlight",
);
const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
const rotationDelay = 6000;
let hovered = false;
let focused = false;
let rotationTimer: number | undefined;

function updateTabHighlight(): void {
  const selected = tabs.find(
    (tab) => tab.getAttribute("aria-selected") === "true",
  );
  if (!tabHighlight || !selected) return;
  tabHighlight.style.width = `${selected.offsetWidth}px`;
  tabHighlight.style.height = `${selected.offsetHeight}px`;
  tabHighlight.style.top = `${selected.offsetTop}px`;
  tabHighlight.style.transform = `translateX(${selected.offsetLeft}px)`;
  tabHighlight.hidden = false;
  tabList?.setAttribute("data-animated", "");
}

function scheduleRotation(): void {
  window.clearTimeout(rotationTimer);
  if (
    signal.aborted ||
    reducedMotion.matches ||
    hovered ||
    focused ||
    document.hidden ||
    tabs.length < 2
  ) {
    return;
  }
  rotationTimer = window.setTimeout(() => {
    const index = tabs.findIndex(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    const next = tabs[(index + 1) % tabs.length];
    if (next) selectTab(next, true);
  }, rotationDelay);
}

function selectTab(
  selected: HTMLButtonElement,
  seamless = false,
): void {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(
      tab.getAttribute("aria-controls") ?? "",
    );
    if (panel) {
      panel.hidden = false;
      panel.inert = !active;
      panel.setAttribute("aria-hidden", String(!active));
    }
  }
  loopingTrack?.goTo(tabs.indexOf(selected), seamless);
  updateTabHighlight();
  scheduleRotation();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab), {
    signal,
  });
  tab.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      let nextIndex: number;
      switch (event.key) {
        case "ArrowRight":
          nextIndex = (index + 1) % tabs.length;
          break;
        case "ArrowLeft":
          nextIndex =
            (index - 1 + tabs.length) % tabs.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      const next = tabs[nextIndex];
      if (next) {
        event.preventDefault();
        selectTab(next);
        next.focus();
      }
    },
    { signal },
  );
}

// Keep the scene still while someone reads or uses it.
showcase?.addEventListener(
  "pointerenter",
  (event) => {
    if (event.pointerType !== "mouse") return;
    hovered = true;
    scheduleRotation();
  },
  { signal },
);
showcase?.addEventListener(
  "pointerleave",
  () => {
    hovered = false;
    scheduleRotation();
  },
  { signal },
);

function updateFocus(): void {
  focused = Boolean(
    showcase?.contains(document.activeElement) &&
    document.activeElement?.matches(":focus-visible"),
  );
  scheduleRotation();
}

showcase?.addEventListener("focusin", updateFocus, {
  signal,
});
showcase?.addEventListener(
  "focusout",
  () => queueMicrotask(updateFocus),
  { signal },
);
document.addEventListener(
  "visibilitychange",
  scheduleRotation,
  { signal },
);
reducedMotion.addEventListener("change", scheduleRotation, {
  signal,
});
signal.addEventListener(
  "abort",
  () => window.clearTimeout(rotationTimer),
  { once: true },
);
const tabResizeObserver = new ResizeObserver(
  updateTabHighlight,
);
for (const tab of tabs) tabResizeObserver.observe(tab);
signal.addEventListener(
  "abort",
  () => tabResizeObserver.disconnect(),
  { once: true },
);
updateFocus();
const initialTab = tabs[initialIndex];
if (initialTab) selectTab(initialTab);

const menu =
  document.querySelector<HTMLDetailsElement>(
    ".mobile-menu",
  );
if (menu) {
  menu.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("a")
      ) {
        menu.open = false;
      }
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    },
    { signal },
  );
  document.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !menu.contains(event.target)
      ) {
        menu.open = false;
      }
    },
    { signal },
  );
}

// Avoid duplicated listeners when Vite replaces this module during development.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => controller.abort());
}
