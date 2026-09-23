import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createMeetingSources,
  selectMeetingFeaturedSource,
  selectMeetingPipSource,
  type MeetingParticipant,
} from "@/routes/home/components/meeting-sources";

vi.mock("@/i18n", () => ({
  t: (key: string, args?: { count: number }) =>
    `${key}${args ? ` ${args.count}` : ""}`,
}));

class FakeStream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return [...this.tracks];
  }
}
const stream = (...tracks: MediaStreamTrack[]) =>
  new FakeStream(tracks) as unknown as MediaStream;
const track = (
  id: string,
  kind: "audio" | "video",
  screen = false,
) =>
  ({
    id,
    kind,
    readyState: "live",
    stop: vi.fn(),
    getSettings: () =>
      screen ? { displaySurface: "monitor" } : {},
  }) as unknown as MediaStreamTrack;

beforeEach(() => vi.stubGlobal("MediaStream", FakeStream));
afterEach(() => vi.unstubAllGlobals());

describe("meeting source presentation", () => {
  it("uses the large view only for a single source, regardless of its owner", () => {
    createRoot((dispose) => {
      const [participants, setParticipants] = createSignal<
        MeetingParticipant[]
      >([{ id: "me", name: "Me", local: true }]);
      const sources = createMeetingSources(participants);
      const local = sources()[0];
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBe(local);
      expect(
        selectMeetingFeaturedSource(sources(), local.id),
      ).toBe(local);
      const mine = {
        id: "me",
        name: "Me",
        local: true,
        stream: stream(
          track("camera", "video"),
          track("screen", "video", true),
        ),
      };
      setParticipants([mine]);
      const camera = sources()[0];
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBeUndefined();
      expect(
        selectMeetingFeaturedSource(sources(), camera.id),
      ).toBe(camera);
      setParticipants([mine, { id: "peer", name: "Peer" }]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBeUndefined();
      expect(
        selectMeetingFeaturedSource(sources(), camera.id)
          ?.id,
      ).toBe(camera.id);
      setParticipants([mine]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBeUndefined();
      setParticipants([
        {
          ...mine,
          stream: stream(track("screen", "video", true)),
        },
      ]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBe(sources()[0]);
      setParticipants([
        { id: "peer", name: "Peer", stream: mine.stream },
      ]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBeUndefined();
      setParticipants([{ id: "peer", name: "Peer" }]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBe(sources()[0]);
      expect(
        selectMeetingFeaturedSource([], null),
      ).toBeUndefined();
      dispose();
    });
  });

  it("selects the pinned view, then the first live video, then the first participant for PiP", () => {
    createRoot((dispose) => {
      const camera = track("camera", "video");
      const sources = createMeetingSources(() => [
        { id: "first", name: "First" },
        {
          id: "video",
          name: "Camera",
          stream: stream(camera),
        },
        { id: "last", name: "Last" },
      ]);
      const views = sources();
      expect(
        selectMeetingPipSource(views, views[2].id),
      ).toBe(views[2]);
      expect(selectMeetingPipSource(views, "gone")).toBe(
        views[1],
      );
      expect(selectMeetingPipSource(views, null)).toBe(
        views[1],
      );
      Object.defineProperty(camera, "readyState", {
        value: "ended",
      });
      expect(selectMeetingPipSource(views, null)).toBe(
        views[0],
      );
      expect(
        selectMeetingPipSource([], null),
      ).toBeUndefined();
      dispose();
    });
  });
  it("shows every local and remote video while exposing each participant's audio only once", () => {
    createRoot((dispose) => {
      const camera = track("camera", "video");
      const screen = track("screen", "video", true);
      const microphone = track("microphone", "audio");
      const remoteAudio = track("remote-audio", "audio");
      const remote1 = track("remote-1", "video");
      const remote2 = track("remote-2", "video");
      const sources = createMeetingSources(() => [
        {
          id: "me",
          name: "Me",
          local: true,
          stream: stream(camera, screen, microphone),
        },
        {
          id: "peer",
          name: "Peer",
          stream: stream(remote1, remote2, remoteAudio),
        },
      ]);
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["camera", "screen", "video", "video"]);
      expect(
        new Set(sources().map((source) => source.id)).size,
      ).toBe(4);
      expect(
        sources()
          .flatMap(
            (source) => source.stream?.getTracks() ?? [],
          )
          .filter((item) => item.kind === "audio"),
      ).toEqual([microphone, remoteAudio]);
      expect(
        sources()
          .slice(2)
          .map((source) => source.name),
      ).toEqual([
        "Peer · meeting.video_source 1",
        "Peer · meeting.video_source 2",
      ]);
      dispose();
      expect(camera.stop).not.toHaveBeenCalled();
      expect(remote1.stop).not.toHaveBeenCalled();
    });
  });

  it("keeps the camera presentation and pin identity stable when another shared screen ends", () => {
    createRoot((dispose) => {
      const camera = track("camera", "video");
      const screen = track("screen", "video", true);
      const [participants, setParticipants] = createSignal<
        MeetingParticipant[]
      >([
        {
          id: "me",
          name: "Me",
          local: true,
          stream: stream(camera, screen),
        },
      ]);
      const sources = createMeetingSources(participants);
      const first = sources()[0];
      setParticipants([
        {
          id: "me",
          name: "Renamed",
          local: true,
          stream: stream(camera),
        },
      ]);
      expect(sources()).toHaveLength(1);
      expect(sources()[0].id).toBe(first.id);
      expect(sources()[0].stream).toBe(first.stream);
      expect(sources()[0].name).toContain("Renamed");
      expect(camera.stop).not.toHaveBeenCalled();
      expect(screen.stop).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("keeps a participant placeholder for audio-only and legacy placeholder streams", () => {
    createRoot((dispose) => {
      const audio = track("audio", "audio");
      const blank = track("blank", "video");
      const sources = createMeetingSources(() => [
        {
          id: "peer",
          name: "Peer",
          stream: stream(blank, audio),
          placeholder: true,
        },
      ]);
      expect(sources()).toHaveLength(1);
      expect(sources()[0].kind).toBe("participant");
      expect(sources()[0].stream?.getTracks()).toEqual([
        audio,
      ]);
      dispose();
    });
  });
});
