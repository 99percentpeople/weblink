// @vitest-environment jsdom
import {
  Show,
  batch,
  createSignal,
  type ParentProps,
} from "solid-js";
import { render, cleanup } from "@solidjs/testing-library";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { MeetingStage } from "@/routes/home/components/meeting-stage";
import { createMeetingMainView } from "@/routes/home/components/meeting-main-view";
import type { MeetingSource } from "@/routes/home/components/meeting-sources";

// Exercise activation/portal ownership directly, without menus or layout geometry.
const fixture = vi.hoisted(() => ({
  video: undefined as HTMLVideoElement | undefined,
  actions: [] as { label: string; onAction(): void }[],
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/hooks/create-mobile", () => ({
  createIsMobile: () => () => true,
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    getRemoteControl: () => undefined,
    getScreenControl: () => undefined,
  },
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: { options: {} },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({ remoteClipboard: undefined }),
}));
vi.mock("@/libs/state/audio-player-context", () => ({
  useAudioPlayer: () => ({
    isSourceMuted: () => false,
    setSourceMuted() {},
  }),
}));
vi.mock(
  "@/routes/home/components/remote-control-overlay",
  () => ({
    RemoteControlOverlay: () => null,
  }),
);
vi.mock(
  "@/routes/home/components/video-display-context",
  () => ({
    useVideoDisplay: () => ({
      videoRef: () => fixture.video ?? null,
      videoTrack: () => null,
      audioTracks: () => [],
    }),
  }),
);
vi.mock("@/routes/home/components/video-display", () => ({
  VideoDisplay: (
    props: ParentProps<{
      ref?(element: HTMLDivElement): void;
    }>,
  ) => <div ref={props.ref}>{props.children}</div>,
}));
vi.mock(
  "@/routes/home/components/meeting-tile-actions",
  () => ({
    MeetingTileActions: (props: ParentProps) =>
      props.children,
    MeetingTileAction: (props: {
      label: string;
      onAction(): void;
    }) => {
      fixture.actions.push({
        label: props.label,
        onAction: () => props.onAction(),
      });
      return null;
    },
  }),
);
vi.mock("@/components/ui/motion", () => ({
  AnimatePresence: (
    props: ParentProps<{ when: boolean }>,
  ) => <Show when={props.when}>{props.children}</Show>,
  Motion: {
    article: (
      props: ParentProps<{
        ref?(element: HTMLElement): void;
      }>,
    ) => (
      <article ref={props.ref}>{props.children}</article>
    ),
    div: (props: ParentProps) => (
      <div>{props.children}</div>
    ),
  },
}));

beforeEach(() => {
  fixture.actions = [];
  fixture.video = document.createElement("video");
  Object.defineProperties(fixture.video, {
    readyState: { value: 4 },
    videoWidth: { value: 640 },
  });
  Object.defineProperties(document, {
    pictureInPictureEnabled: {
      configurable: true,
      value: true,
    },
    exitPictureInPicture: {
      configurable: true,
      value: vi.fn(async () => {}),
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(
    document,
    "pictureInPictureEnabled",
  );
  Reflect.deleteProperty(document, "exitPictureInPicture");
});

function setup() {
  const enter = vi.fn(
    async () => ({}) as PictureInPictureWindow,
  );
  fixture.video!.requestPictureInPicture = enter;
  const [pinned, setPinned] = createSignal<string | null>(
    "first",
  );
  const source = (id: string): MeetingSource => ({
    id,
    participantId: id,
    audioId: id,
    name: id,
    kind: "participant",
    stream: null,
    local: false,
  });
  const [sources, setSources] = createSignal([
    source("first"),
    source("second"),
  ]);
  const [active, setActive] = createSignal(true);
  const confirm = vi.fn(async () => true);
  const main = createMeetingMainView({
    current: () => pinned() ?? undefined,
    valid: (id) =>
      sources().some((source) => source.id === id),
    confirm,
    onError: vi.fn(),
  });
  const view = render(() => (
    <MeetingStage
      active={active()}
      sources={sources()}
      pinnedId={pinned()}
      railCollapsed={false}
      onRailCollapsedChange={() => {}}
      onPin={setPinned}
      onStop={() => {}}
      transitionLayout={(update) => batch(update)}
      registerFeatures={main.register}
      onActivate={(id, action) => {
        void main.change(id, () => {
          setPinned(id);
          action();
        });
      }}
    />
  ));
  const actions = fixture.actions.filter(
    (action) =>
      action.label === "common.action.picture_in_picture",
  );
  expect(actions).toHaveLength(2);
  return {
    ...view,
    enter,
    pinned,
    setPinned,
    sources,
    setSources,
    setActive,
    main,
    confirm,
    request: () => actions[1].onAction(),
  };
}

it.each([false, true])(
  "commits a secondary view before PiP without waiting for an animation frame (batched=%s)",
  async (batched) => {
    const f = setup();
    if (batched) batch(f.request);
    else f.request();
    expect(f.pinned()).toBe("second");
    await Promise.resolve();
    expect(f.enter).toHaveBeenCalledOnce();
  },
);

it.each(["switch", "remove", "hide", "unmount"])(
  "discards queued PiP activation after %s",
  async (reason) => {
    const f = setup();
    batch(f.request);
    if (reason === "switch") f.setPinned("first");
    if (reason === "remove") f.setSources([f.sources()[0]]);
    if (reason === "hide") f.setActive(false);
    if (reason === "unmount") f.unmount();
    await Promise.resolve();
    expect(f.enter).not.toHaveBeenCalled();
  },
);

it("does not queue PiP when the previous main view's confirmation is cancelled", async () => {
  const f = setup();
  const stop = vi.fn(async () => true);
  f.main.register("first", { active: () => true, stop });
  f.confirm.mockResolvedValue(false);
  f.request();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.enter).not.toHaveBeenCalled();
  expect(f.pinned()).toBe("first");
  expect(stop).not.toHaveBeenCalled();
});
