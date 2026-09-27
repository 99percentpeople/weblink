// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import {
  batch,
  createSignal,
  type ParentProps,
} from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MeetingStage } from "@/routes/home/components/meeting-stage";
import type { MeetingSource } from "@/routes/home/components/meeting-sources";

const fixture = vi.hoisted(() => ({
  update: undefined as (() => void) | undefined,
  animations: [] as {
    element: HTMLElement;
    opacity: unknown;
    stop: ReturnType<typeof vi.fn>;
    complete(): void;
  }[],
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/routes/home/components/audio-player", () => ({
  useAudioPlayer: () => ({
    isSourceMuted: () => false,
    setSourceMuted: vi.fn(),
    isPeerMuted: () => false,
    setPeerMuted() {},
  }),
}));
vi.mock("@/routes/home/components/video-display", () => ({
  VideoDisplay: (
    props: ParentProps<{
      ref?: (node: HTMLDivElement) => void;
    }>,
  ) => <div ref={props.ref}>{props.children}</div>,
}));
vi.mock(
  "@/routes/home/components/meeting-grid-layout",
  () => ({
    createMeetingGridLayout: () =>
      Object.assign(
        () => ({
          tileWidth: 320,
          tileHeight: 180,
          columns: 2,
          rows: 1,
          gap: 12,
          offsetX: 0,
          offsetY: 0,
        }),
        {
          measure() {},
          schedule(update: () => void) {
            fixture.update = update;
          },
        },
      ),
  }),
);
vi.mock("motion", () => ({
  animate: vi.fn(
    (
      element: HTMLElement,
      target: { opacity?: unknown },
    ) => {
      let complete!: () => void;
      const finished = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const controls = {
        element,
        opacity: target.opacity,
        complete,
        finished,
        stop: vi.fn(),
        cancel: vi.fn(),
      };
      fixture.animations.push(controls);
      return controls;
    },
  ),
}));
beforeEach(() => {
  fixture.update = undefined;
  fixture.animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function commitLayout() {
  const update = fixture.update;
  fixture.update = undefined;
  batch(() => update?.());
}
const source = (id: string): MeetingSource => ({
  id,
  participantId: id,
  audioId: JSON.stringify([id, null]),
  name: id,
  kind: "participant",
  stream: null,
  local: false,
});
function setup(pinned: boolean) {
  const self = source("self");
  const peer = source("peer");
  const screen = {
    ...source("screen"),
    participantId: "peer",
    kind: "screen" as const,
  };
  const [sources, setSources] = createSignal([self, peer]);
  const [pinnedId, setPinnedId] = createSignal<
    string | null
  >(pinned ? peer.id : null);
  const view = render(() => (
    <MeetingStage
      compact
      sources={sources()}
      pinnedId={pinnedId()}
      railCollapsed={false}
      onRailCollapsedChange={() => {}}
      onPin={setPinnedId}
      onStop={() => {}}
      transitionLayout={(update) => batch(update)}
    />
  ));
  const tile = (id: string) =>
    view.container.querySelector<HTMLElement>(
      `[data-source-id="${id}"]`,
    );
  const peerTile = tile("peer")!;
  vi.spyOn(
    peerTile,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(40, 50, 320, 180));
  return {
    ...view,
    self,
    peer,
    screen,
    tile,
    peerTile,
    setSources,
    setPinnedId,
  };
}

describe("meeting source exit ownership", () => {
  it.each([false, true])(
    "releases a returning participant's exit state (featured=%s)",
    async (featured) => {
      const f = setup(featured);
      // A remote track arrives before the metadata identifying it as a screen.
      f.setSources([f.self, f.screen]);
      expect(f.peerTile.style.position).toBe("");
      commitLayout();
      expect(f.peerTile.style.position).toBe("fixed");
      expect(f.peerTile.inert).toBe(true);
      const exit = fixture.animations.findLast(
        (animation) => animation.opacity === 0,
      )!;

      // Classification restores the participant while its old exit is pending.
      batch(() => {
        f.setSources([f.self, f.peer, f.screen]);
        f.setPinnedId(f.screen.id);
      });
      commitLayout();
      expect(f.tile("peer")).toBe(f.peerTile);
      for (const key of [
        "position",
        "left",
        "top",
        "width",
        "height",
      ])
        expect(f.peerTile.style.getPropertyValue(key)).toBe(
          "",
        );
      expect(f.peerTile.inert).not.toBe(true);
      expect(exit.stop).toHaveBeenCalledOnce();
      // Presence opacity belongs to a child; layout owns the outer tile's styles.
      expect(exit.element).not.toBe(f.peerTile);
      expect(f.peerTile.contains(exit.element)).toBe(true);
      exit.complete();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.tile("peer")).toBe(f.peerTile);
    },
  );

  it("cleans up an actual departure and allows the same source to join again", async () => {
    const f = setup(false);
    f.setSources([f.self]);
    commitLayout();
    fixture.animations
      .findLast((animation) => animation.opacity === 0)!
      .complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.tile("peer")).toBeNull();
    f.setSources([f.self, f.peer]);
    commitLayout();
    expect(f.tile("peer")).not.toBe(f.peerTile);
    expect(f.tile("peer")!.style.position).toBe("");
  });

  it("discards an obsolete exit when source updates coalesce before the layout frame", () => {
    const f = setup(false);
    f.setSources([f.self]);
    f.setSources([f.self, f.peer]);
    commitLayout();
    expect(f.tile("peer")).toBe(f.peerTile);
    expect(f.peerTile.style.position).toBe("");
    expect(f.peerTile.inert).not.toBe(true);
    expect(
      fixture.animations.some(
        (animation) => animation.opacity === 0,
      ),
    ).toBe(false);
  });
});
