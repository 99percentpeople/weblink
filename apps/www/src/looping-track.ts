interface LoopingTrack {
  goTo(index: number, seamless?: boolean): void;
}

export function createLoopingTrack(
  track: HTMLElement,
  panels: readonly HTMLElement[],
  signal: AbortSignal,
  initialIndex: number,
): LoopingTrack {
  const lastIndex = panels.length - 1;
  const copies: HTMLElement[] = [];
  let currentIndex = initialIndex;
  let wrapping = false;
  let revision = 0;

  function copyPanel(panel: HTMLElement): HTMLElement {
    const copy = panel.cloneNode(true) as HTMLElement;
    copy.hidden = false;
    copy.inert = true;
    copy.setAttribute("aria-hidden", "true");
    for (const name of [
      "id",
      "role",
      "aria-labelledby",
      "tabindex",
    ]) {
      copy.removeAttribute(name);
    }
    for (const node of copy.querySelectorAll("[id]")) {
      node.removeAttribute("id");
    }
    // The offscreen copies must be ready before a wrap begins.
    for (const image of copy.querySelectorAll("img")) {
      image.loading = "eager";
      image.removeAttribute("fetchpriority");
    }
    copies.push(copy);
    return copy;
  }

  const firstPanel = panels[0];
  if (panels.length > 1 && firstPanel) {
    track.append(copyPanel(firstPanel));
  }

  function jumpTo(position: number): void {
    track.style.transition = "none";
    track.style.setProperty(
      "--demo-index",
      String(position),
    );
    // Commit the identical frame before restoring the slide transition.
    track.getBoundingClientRect();
    track.style.removeProperty("transition");
  }

  jumpTo(currentIndex);
  signal.addEventListener(
    "abort",
    () => {
      revision++;
      for (const copy of copies) copy.remove();
      jumpTo(currentIndex);
    },
    { once: true },
  );

  return {
    goTo(index, seamless = false) {
      if (
        signal.aborted ||
        index === currentIndex ||
        index < 0 ||
        index > lastIndex
      ) {
        return;
      }
      const move = ++revision;
      // A new selection may interrupt a wrap before it has settled.
      if (wrapping) jumpTo(currentIndex);
      let position = index;
      if (
        seamless &&
        panels.length > 1 &&
        currentIndex === lastIndex &&
        index === 0
      ) {
        position = panels.length;
      }
      currentIndex = index;
      wrapping = position !== index;
      track.style.setProperty(
        "--demo-index",
        String(position),
      );
      if (!wrapping) return;

      // Also settles when motion is disabled or a transition is cancelled.
      void Promise.allSettled(
        track
          .getAnimations()
          .map((animation) => animation.finished),
      ).then(() => {
        if (signal.aborted || move !== revision) return;
        jumpTo(currentIndex);
        wrapping = false;
      });
    },
  };
}
