import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import { bindNativeScreenAudio } from "@/libs/domain/native-screen/tracks";
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
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
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
  it("keeps each native screen's audio and presentation identity when another screen stops", () => {
    createRoot((dispose) => {
      const one = track("native-one", "video"),
        two = track("native-two", "video");
      const audioOne = track("audio-one", "audio"),
        audioTwo = track("audio-two", "audio");
      bindNativeScreenAudio(stream(one, audioOne));
      bindNativeScreenAudio(stream(two, audioTwo));
      const [participants, setParticipants] = createSignal<
        MeetingParticipant[]
      >([
        {
          id: "peer",
          name: "Peer",
          nativeScreenStream: stream(
            one,
            audioTwo,
            two,
            audioOne,
          ),
        },
      ]);
      const sources = createMeetingSources(participants);
      const screens = sources().filter(
        (s) => s.kind === "screen",
      );
      expect(
        screens.map((s) => s.stream!.getTracks()),
      ).toEqual([
        [one, audioOne],
        [two, audioTwo],
      ]);
      // Browser getTracks() need not retain the constructor's track order.
      vi.spyOn(
        screens[1].stream!,
        "getTracks",
      ).mockReturnValue([audioTwo, two]);
      setParticipants([
        {
          ...participants()[0],
          nativeScreenStream: stream(two, audioTwo),
        },
      ]);
      const remaining = sources().find(
        (s) => s.kind === "screen",
      )!;
      expect(remaining.id).toBe(screens[1].id);
      expect(remaining.audioId).toBe(screens[1].audioId);
      expect(remaining.stream).toBe(screens[1].stream);
      expect(two.stop).not.toHaveBeenCalled();
      expect(audioTwo.stop).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("does not attach a new source's early audio to the screen already being watched", () => {
    createRoot((dispose) => {
      const video = track("first", "video"),
        audio = track("first-audio", "audio");
      const incoming = track("second-audio", "audio");
      bindNativeScreenAudio(stream(video, audio));
      bindNativeScreenAudio(stream(incoming));
      const sources = createMeetingSources(() => [
        {
          id: "peer",
          name: "Peer",
          nativeScreenStream: stream(
            video,
            audio,
            incoming,
          ),
        },
      ]);
      expect(
        sources()
          .find((s) => s.kind === "screen")!
          .stream!.getTracks(),
      ).toEqual([video, audio]);
      dispose();
    });
  });
  it("keeps a native screen independent of camera MID metadata and browser placeholders", () => {
    createRoot((dispose) => {
      const camera = track("camera", "video");
      const native = track("screen", "video");
      const nativeAudio = track("screen-audio", "audio");
      const [participants, setParticipants] = createSignal<
        MeetingParticipant[]
      >([
        {
          id: "peer",
          name: "Peer",
          stream: stream(camera),
          nativeScreenStream: stream(native, nativeAudio),
          videoSources: [{ mid: "0", kind: "camera" }],
          videoTracks: [{ mid: "0", trackId: camera.id }],
        },
      ]);
      const sources = createMeetingSources(participants);
      expect(sources().map((s) => s.kind)).toEqual([
        "camera",
        "screen",
      ]);
      expect(sources()[0].stream?.getTracks()).toEqual([
        camera,
      ]);
      expect(sources()[1].stream?.getTracks()).toEqual([
        native,
        nativeAudio,
      ]);
      setParticipants([
        { ...participants()[0], placeholder: true },
      ]);
      expect(sources().map((s) => s.kind)).toEqual([
        "participant",
        "screen",
      ]);
      setParticipants([
        {
          ...participants()[0],
          nativeScreenStream: undefined,
        },
      ]);
      expect(sources().map((s) => s.kind)).toEqual([
        "participant",
      ]);
      expect(native.stop).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("moves shared audio onto its matching screen when MID metadata arrives, without duplicating tracks", () => {
    createRoot((dispose) => {
      const camera = track("receiver-camera", "video");
      const screen1 = track("receiver-screen-1", "video");
      const screen2 = track("receiver-screen-2", "video");
      const mic = track("receiver-mic", "audio");
      const audio1 = track("receiver-audio-1", "audio");
      const audio2 = track("receiver-audio-2", "audio");
      const participant: MeetingParticipant = {
        id: "peer",
        name: "Peer",
        stream: stream(
          camera,
          screen1,
          screen2,
          audio2,
          mic,
          audio1,
        ),
        videoSources: [
          { mid: "0", kind: "camera" },
          { mid: "2", kind: "screen" },
          { mid: "4", kind: "screen" },
        ],
        videoTracks: [
          { mid: "0", trackId: camera.id },
          { mid: "2", trackId: screen1.id },
          { mid: "4", trackId: screen2.id },
        ],
      };
      const [participants, setParticipants] = createSignal([
        participant,
      ]);
      const sources = createMeetingSources(participants);
      const ids = sources().map((source) => source.id);
      // An older peer or not-yet-described audio retains the existing fallback.
      expect(sources()[0].stream?.getTracks()).toEqual([
        camera,
        audio2,
        mic,
        audio1,
      ]);
      const described: MeetingParticipant = {
        ...participant,
        audioSources: [
          { mid: "1", kind: "microphone" },
          { mid: "3", kind: "screen", videoMid: "2" },
          { mid: "5", kind: "screen", videoMid: "4" },
        ],
        audioTracks: [
          { mid: "5", trackId: audio2.id },
          { mid: "1", trackId: mic.id },
          { mid: "3", trackId: audio1.id },
        ],
      };
      setParticipants([described]);
      expect(sources().map((source) => source.id)).toEqual(
        ids,
      );
      expect(
        sources().map((source) =>
          source.stream?.getTracks(),
        ),
      ).toEqual([
        [camera, mic],
        [screen1, audio1],
        [screen2, audio2],
      ]);
      const microphoneId = sources()[0].audioId;
      const screenStreams = sources()
        .slice(1)
        .map((source) => source.stream);
      setParticipants([
        {
          ...described,
          stream: stream(
            screen1,
            screen2,
            audio2,
            mic,
            audio1,
          ),
        },
      ]);
      expect(sources()[0].kind).toBe("participant");
      expect(sources()[0].audioId).toBe(microphoneId);
      expect(sources()[0].stream?.getTracks()).toEqual([
        mic,
      ]);
      expect(
        sources()
          .slice(1)
          .map((source) => source.stream),
      ).toEqual(screenStreams);
      dispose();
      for (const audio of [mic, audio1, audio2])
        expect(audio.stop).not.toHaveBeenCalled();
    });
  });

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
      const shared = track("screen-only", "video", true);
      setParticipants([
        {
          ...mine,
          stream: stream(shared),
        },
      ]);
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["participant", "screen"]);
      expect(
        selectMeetingFeaturedSource(sources(), null),
      ).toBeUndefined();
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

  it("keeps the local participant tile stable when microphone joins a screen-only share", () => {
    createRoot((dispose) => {
      const shared = track("screen-only", "video", true);
      const microphone = track("microphone", "audio");
      const [participants, setParticipants] = createSignal<
        MeetingParticipant[]
      >([
        {
          id: "me",
          name: "Me",
          local: true,
          stream: stream(shared),
        },
      ]);
      const sources = createMeetingSources(participants);
      const participantId = sources()[0].id;
      const screenId = sources()[1].id;
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["participant", "screen"]);
      expect(sources()[0].stream).toBeNull();
      expect(sources()[1].stream?.getTracks()).toEqual([
        shared,
      ]);

      setParticipants([
        {
          id: "me",
          name: "Me",
          local: true,
          stream: stream(shared, microphone),
        },
      ]);
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["participant", "screen"]);
      expect(sources()[0].id).toBe(participantId);
      expect(sources()[1].id).toBe(screenId);
      expect(sources()[0].stream?.getTracks()).toEqual([
        microphone,
      ]);
      expect(sources()[1].stream?.getTracks()).toEqual([
        shared,
      ]);
      dispose();
    });
  });

  it("keeps a remote participant tile beside a separately described shared screen", () => {
    createRoot((dispose) => {
      const microphone = track("remote-audio", "audio");
      const screen = track("remote-screen", "video");
      const sources = createMeetingSources(() => [
        {
          id: "peer",
          name: "Peer",
          stream: stream(screen, microphone),
          videoSources: [{ mid: "2", kind: "screen" }],
          videoTracks: [{ trackId: screen.id, mid: "2" }],
        },
      ]);
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["participant", "screen"]);
      expect(sources()[0].stream?.getTracks()).toEqual([
        microphone,
      ]);
      expect(sources()[1].stream?.getTracks()).toEqual([
        screen,
      ]);
      expect(sources()[0].participantId).toBe("peer");
      expect(sources()[1].participantId).toBe("peer");
      dispose();
    });
  });

  it("joins remote source semantics to rewritten track IDs through MID", () => {
    createRoot((dispose) => {
      const microphone = track("remote-audio", "audio");
      const remoteCamera = track(
        "rewritten-camera",
        "video",
      );
      const remoteScreen = track(
        "rewritten-screen",
        "video",
      );
      const sources = createMeetingSources(() => [
        {
          id: "peer",
          name: "Peer",
          stream: stream(
            remoteCamera,
            remoteScreen,
            microphone,
          ),
          videoSources: [
            { mid: "0", kind: "camera" },
            { mid: "2", kind: "screen" },
          ],
          videoTracks: [
            { trackId: remoteCamera.id, mid: "0" },
            { trackId: remoteScreen.id, mid: "2" },
          ],
        },
      ]);
      expect(
        sources().map((source) => source.kind),
      ).toEqual(["camera", "screen"]);
      expect(sources()[0].stream?.getTracks()).toEqual([
        remoteCamera,
        microphone,
      ]);
      expect(sources()[1].stream?.getTracks()).toEqual([
        remoteScreen,
      ]);
      dispose();
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
