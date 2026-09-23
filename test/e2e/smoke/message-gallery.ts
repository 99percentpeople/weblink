const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve()),
  );
async function until(
  check: () => boolean,
  description: string,
) {
  for (let i = 0; i < 240; i++) {
    if (check()) return;
    await frame();
  }
  throw new Error(`PhotoSwipe: ${description}`);
}

export async function checkMessageGallery(
  link: HTMLAnchorElement,
  video = false,
) {
  const previousHash = location.hash;
  const viewport = link.closest<HTMLElement>(
    '[data-slot="chat-viewport"]',
  );
  if (viewport) {
    const rect = link.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    if (
      rect.top < bounds.top ||
      rect.bottom > bounds.bottom
    ) {
      viewport.scrollTop +=
        rect.top -
        bounds.top -
        (viewport.clientHeight - rect.height) / 2;
      viewport.dispatchEvent(new Event("scroll"));
      await frame();
    }
  }
  // A real click interrupts any smooth following started by the preceding send.
  // HTMLElement.click() alone skips that pointer interaction.
  link.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "mouse",
      button: 0,
    }),
  );
  const scrollTop = viewport?.scrollTop;
  const thumbnail = link.querySelector<HTMLImageElement>(
    "img[data-media-thumbnail]",
  );
  if (thumbnail?.naturalWidth) {
    const bounds = thumbnail.getBoundingClientRect();
    const expected =
      Number(link.dataset.pswpWidth) /
      Number(link.dataset.pswpHeight);
    if (
      Math.abs(bounds.width / bounds.height - expected) >
      0.02
    )
      throw new Error(
        "Thumbnail bounds include letterboxing and would distort the zoom transition",
      );
  }
  link.click();
  await until(
    () => !!document.querySelector(".pswp--open"),
    "did not open from message bubble",
  );
  await until(
    () =>
      document.querySelector<HTMLAnchorElement>(
        ".pswp__button--download-button",
      )?.download === link.dataset.download,
    "download filename did not follow the active slide",
  );
  const download =
    document.querySelector<HTMLAnchorElement>(
      ".pswp__button--download-button",
    )!;
  if (download.href !== link.dataset.pswpSrc)
    throw new Error(
      "Gallery download does not reference the local attachment",
    );
  if (video) {
    await until(
      () =>
        !!document.querySelector<HTMLVideoElement>(
          ".pswp video",
        )?.videoWidth,
      "video was not decoded in the gallery",
    );
    if (
      !document.querySelector<HTMLVideoElement>(
        ".pswp video",
      )!.controls
    )
      throw new Error(
        "Gallery video has no playback controls",
      );
  } else {
    await until(
      () =>
        !!document.querySelector<HTMLImageElement>(
          ".pswp img.pswp__img",
        )?.naturalWidth,
      "image was not decoded in the gallery",
    );
  }
  // PhotoSwipe deliberately ignores close until its opening animation ends.
  await until(
    () =>
      !!(
        window as Window & {
          pswp?: import("photoswipe").default;
        }
      ).pswp?.opener.isOpen,
    "opening animation did not finish",
  );
  if (location.hash !== link.hash)
    throw new Error(
      "Preview did not publish a stable media hash",
    );
  const pswp = (
    window as Window & {
      pswp?: import("photoswipe").default;
    }
  ).pswp!;
  const bounds = pswp.getThumbBounds();
  const actual = link
    .querySelector<HTMLElement>("[data-media-thumbnail]")
    ?.getBoundingClientRect();
  if (
    actual &&
    bounds &&
    (Math.abs(bounds.x - actual.left) > 1 ||
      Math.abs(bounds.y - actual.top) > 1 ||
      Math.abs(bounds.w - actual.width) > 1)
  )
    throw new Error(
      "PhotoSwipe transition bounds differ from visible thumbnail",
    );
  document
    .querySelector<HTMLButtonElement>(
      ".pswp__button--close",
    )!
    .click();
  await until(
    () => !document.querySelector(".pswp"),
    "did not clean up after close",
  );
  await until(
    () => location.hash === previousHash,
    "close did not restore the previous hash",
  );
  if (
    viewport &&
    Math.abs(viewport.scrollTop - scrollTop!) > 1
  )
    throw new Error(
      `Thumbnail preview changed the conversation scroll position: ${link.dataset.messageMedia}, ${scrollTop} -> ${viewport.scrollTop}, viewport ${viewport.clientHeight}/${viewport.scrollHeight}, focus ${document.activeElement?.tagName}`,
    );
}

export async function createGalleryVideo() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const stream = canvas.captureStream(10);
  const recorder = new MediaRecorder(stream, {
    mimeType: "video/webm",
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) =>
    chunks.push(event.data);
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  try {
    recorder.start();
    for (let i = 0; i < 15; i++) {
      canvas.getContext("2d")!.fillStyle =
        i % 2 ? "#5599cc" : "#114477";
      canvas.getContext("2d")!.fillRect(0, 0, 160, 90);
      await frame();
    }
    recorder.stop();
    await stopped;
    return new File(chunks, "meeting-video.webm", {
      type: "video/webm",
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function createGalleryAudio() {
  const bytes = new ArrayBuffer(44 + 1600);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 1600, true);
  return new File([bytes], "meeting-audio.wav", {
    type: "audio/wav",
  });
}

export async function checkGalleryHistory(
  link: HTMLAnchorElement,
) {
  const path = location.pathname + location.search;
  const previousHash = location.hash;
  const pswp = () =>
    (
      window as Window & {
        pswp?: import("photoswipe").default;
      }
    ).pswp;
  link.click();
  await until(
    () => !!pswp()?.opener.isOpen,
    "history preview open",
  );
  const length = history.length;
  const next = document.querySelector<HTMLButtonElement>(
    pswp()!.currIndex > 0
      ? ".pswp__button--arrow--prev"
      : ".pswp__button--arrow--next",
  );
  if (next && pswp()!.getNumItems() > 1) {
    next.click();
    await until(
      () => location.hash !== link.hash,
      "slide change did not update deep link",
    );
    if (history.length !== length)
      throw new Error(
        "Slide change created extra history entries",
      );
  }
  const lastHash = location.hash;
  history.back();
  await until(
    () => !pswp() && location.hash === previousHash,
    "Back did not close the preview",
  );
  if (location.pathname + location.search !== path)
    throw new Error("Back left the conversation");
  history.forward();
  await until(
    () =>
      !!pswp()?.opener.isOpen && location.hash === lastHash,
    "Forward did not reopen the selected media",
  );
  document
    .querySelector<HTMLButtonElement>(
      ".pswp__button--close",
    )!
    .click();
  await until(
    () => !pswp() && location.hash === previousHash,
    "closing a restored preview changed its conversation",
  );
}
