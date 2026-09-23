// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
import { MeetingTile } from "@/routes/home/components/meeting-tile";

vi.hoisted(() => {
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    value: true,
  });
});

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconVolumeUpFilled: () => null,
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: () => <span>Avatar</span>,
}));
vi.mock("@/components/common/spinner", () => ({
  Spinner: () => null,
}));
vi.mock("@/libs/hooks/check-volume", () => ({
  createCheckVolume: () => () => false,
}));

class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  enabled = true;
  stop = vi.fn();
  constructor(readonly id: string) {
    super();
  }
}
class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return [...this.tracks];
  }
}

let fullscreenElement: Element | null = null;
const activateFullscreen = (element: Element | null) => {
  fullscreenElement = element;
  document.dispatchEvent(new Event("fullscreenchange"));
};

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperties(document, {
    fullscreenEnabled: { configurable: true, value: true },
    fullscreenElement: {
      configurable: true,
      get: () => fullscreenElement,
    },
    exitFullscreen: {
      configurable: true,
      value: vi.fn(async () => activateFullscreen(null)),
    },
  });
  vi.stubGlobal("MediaStream", Stream);
  vi.spyOn(
    HTMLMediaElement.prototype,
    "play",
  ).mockResolvedValue();
  vi.spyOn(
    HTMLMediaElement.prototype,
    "pause",
  ).mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const [local, setLocal] = createSignal(true);
  const [kind, setKind] = createSignal("screen");
  const [pinned, setPinned] = createSignal(false);
  const [track, setTrack] = createSignal(
    new Track("screen-1"),
  );
  const onStop = vi.fn();
  const view = render(() => (
    <MeetingTile
      name="Alice"
      sourceId="source"
      sourceKind={kind()}
      trackId={track().id}
      stream={
        new Stream([
          track() as unknown as MediaStreamTrack,
        ]) as unknown as MediaStream
      }
      local={local()}
      pinned={pinned()}
      onPin={() => setPinned((value) => !value)}
      onStop={onStop}
    />
  ));
  const video = view.container.querySelector("video")!;
  const display = video.parentElement!;
  display.requestFullscreen = vi.fn(async () =>
    activateFullscreen(display),
  );
  return {
    ...view,
    video,
    display,
    track,
    setTrack,
    setLocal,
    setKind,
    setPinned,
    onStop,
  };
}
const cover = () =>
  screen.queryByRole("button", {
    name: "meeting.show_screen_preview",
  });

describe("local screen preview cover", () => {
  it("covers only a local screen featured in the main view", () => {
    const view = setup();
    expect(cover()).toBeNull();
    view.setPinned(true);
    expect(cover()).not.toBeNull();
    view.setLocal(false);
    expect(cover()).toBeNull();
    view.setLocal(true);
    view.setKind("camera");
    expect(cover()).toBeNull();
    view.setKind("screen");
    fireEvent.click(cover()!);
    expect(cover()).toBeNull();
    view.setPinned(false);
    view.setPinned(true);
    expect(cover()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    expect(cover()).toBeNull();
    view.setTrack(new Track("screen-2"));
    expect(cover()).not.toBeNull();
  });

  it("keeps the cover and controls inside fullscreen and releases fullscreen when removed", async () => {
    const view = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    expect(document.fullscreenElement).toBe(view.display);
    expect(
      document.fullscreenElement?.contains(cover()),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.exit_fullscreen",
      }),
    );
    expect(document.fullscreenElement).toBeNull();
    expect(cover()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    fireEvent.click(cover()!);
    expect(cover()).toBeNull();
    expect(document.fullscreenElement).toBe(view.display);
    view.unmount();
    await Promise.resolve();
    expect(document.fullscreenElement).toBeNull();
  });

  it("keeps the shared track and preview element alive while covered or revealed", () => {
    const view = setup();
    const source = view.track();
    const stream = view.video.srcObject;
    view.setPinned(true);
    expect(cover()).not.toBeNull();
    expect(view.video.srcObject).toBe(stream);
    fireEvent.click(cover()!);
    expect(view.container.querySelector("video")).toBe(
      view.video,
    );
    expect(view.video.srcObject).toBe(stream);
    expect(source.enabled).toBe(true);
    expect(source.stop).not.toHaveBeenCalled();
    expect(
      HTMLMediaElement.prototype.pause,
    ).not.toHaveBeenCalled();
    expect(view.onStop).not.toHaveBeenCalled();
  });
});
