import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { reconcile } from "solid-js/store";
import { AudioPlayerView } from "@/components/app/audio-player";
import { createAudioPlayer } from "@/libs/state/create-audio-player";
import {
  setAppState,
  type ClientInfo,
} from "@/libs/state/app-state";
import { meetingAudioSourceId } from "@/routes/home/components/meeting-audio-sources";

declare global {
  interface Window {
    __AUDIO_PLAYBACK_START__?: () => void;
  }
}

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Capture the test tab's rendered audio, not the input tracks or a mocked
 * play(). MediaElementAudioSourceNode cannot measure Chromium srcObject output. */
async function main() {
  const capture =
    await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: true,
        restrictOwnAudio: false,
      },
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
  const context = new AudioContext({ sampleRate: 48000 });
  const host = document.createElement("div");
  document.body.append(host);
  const oscillators: OscillatorNode[] = [];
  const borrowed: MediaStreamTrack[] = [];
  const peers: RTCPeerConnection[] = [];
  let dispose = () => {};
  try {
    assert(
      capture.getAudioTracks().length === 1,
      "The isolated test tab must provide rendered audio",
    );
    await context.resume();
    const frequencies = [600, 1500, 2600];
    // MediaStream destinations match the native PCM -> Web Audio bridge.
    const tracks = frequencies.map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = 0.03;
      const destination =
        context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      oscillators.push(oscillator);
      const track = destination.stream.getAudioTracks()[0];
      borrowed.push(track);
      return track;
    });
    const canvas = document.createElement("canvas");
    const video = canvas
      .captureStream()
      .getVideoTracks()[0];
    borrowed.push(video);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    const silence = context.createGain();
    silence.gain.value = 0;
    context
      .createMediaStreamSource(capture)
      .connect(analyser)
      .connect(silence)
      .connect(context.destination);
    const bins = new Float32Array(
      analyser.frequencyBinCount,
    );
    const levels = () => {
      analyser.getFloatFrequencyData(bins);
      return frequencies.map((frequency) => {
        const bin = Math.round(
          (frequency * analyser.fftSize) /
            context.sampleRate,
        );
        return Math.max(...bins.slice(bin - 2, bin + 3));
      });
    };
    const checks: {
      name: string;
      levelsDb: (number | null)[];
    }[] = [];
    const audible = async (
      name: string,
      expected: boolean[],
    ) => {
      // Let old samples drain before accepting consecutive spectral matches.
      await sleep(250);
      const deadline = performance.now() + 5000;
      let stable = 0;
      let actual = levels();
      while (performance.now() < deadline) {
        actual = levels();
        if (
          expected.every((present, index) =>
            present
              ? actual[index] > -65
              : actual[index] < -90,
          )
        ) {
          if (++stable === 3) {
            checks.push({
              name,
              levelsDb: actual.map((db) =>
                Number.isFinite(db)
                  ? Math.round(db * 100) / 100
                  : null,
              ),
            });
            return;
          }
        } else stable = 0;
        await sleep(50);
      }
      throw new Error(
        `${name}: expected audible ${expected}; measured ${actual} dB at ${frequencies} Hz`,
      );
    };
    const publish = (
      clients: Record<string, Partial<ClientInfo>>,
    ) =>
      setAppState(
        "session",
        "clientViewData",
        reconcile(
          Object.fromEntries(
            Object.entries(clients).map(([id, client]) => [
              id,
              { ...client },
            ]),
          ) as Record<string, ClientInfo>,
        ),
      );
    const alice = {
      clientId: "alice",
      name: "Alice",
      stream: new MediaStream([tracks[0]]),
      nativeScreenStream: new MediaStream([
        video,
        tracks[1],
      ]),
    };
    const bob = {
      clientId: "bob",
      name: "Bob",
      stream: new MediaStream([tracks[2]]),
    };
    publish({ alice });
    let player!: ReturnType<typeof createAudioPlayer>;
    let show!: (visible: boolean) => void;
    dispose = render(() => {
      player = createAudioPlayer();
      const [visible, setVisible] = createSignal(true);
      show = setVisible;
      return (
        <Show when={visible()}>
          <AudioPlayerView player={player} />
        </Show>
      );
    }, host);
    const controls = player.value;
    const outputElements = () =>
      [...host.querySelectorAll("audio")].filter(
        (element) => element.srcObject,
      );
    await audible("native microphone and shared audio", [
      true,
      true,
      false,
    ]);
    const originalElements = outputElements();
    controls.setSourceMuted(
      "alice",
      meetingAudioSourceId("alice"),
      true,
    );
    await audible(
      "first track muted, screen remains audible",
      [false, true, false],
    );
    controls.setSourceMuted(
      "alice",
      meetingAudioSourceId("alice"),
      false,
    );
    controls.setSourceMuted(
      "alice",
      meetingAudioSourceId("alice", video.id),
      true,
    );
    await audible(
      "screen muted, microphone remains audible",
      [true, false, false],
    );
    controls.setPeerMuted("alice", false);
    controls.setPlay(false);
    publish({ alice, bob });
    await audible(
      "global mute survives a new participant",
      [false, false, false],
    );
    assert(
      originalElements.every((element) =>
        outputElements().includes(element),
      ),
      "New participants must retain existing renderers",
    );
    // Real browser setSinkId, including while muted. Physical alternative
    // devices and partial native-call failures are covered deterministically.
    await controls.setOutputDevice("default");
    assert(
      outputElements().every(
        (element) => element.sinkId === "default",
      ),
      "The selected output must reach every renderer",
    );
    await audible(
      "output selection preserves global mute",
      [false, false, false],
    );
    controls.setPlay(true);
    await audible("all participants play together", [
      true,
      true,
      true,
    ]);
    controls.setPeerMuted("alice", true);
    await audible(
      "member mute leaves the other participant audible",
      [false, false, true],
    );
    controls.setSourceMuted(
      "alice",
      meetingAudioSourceId("alice", video.id),
      false,
    );
    await audible("one source can override member mute", [
      false,
      true,
      true,
    ]);
    controls.setPeerMuted("alice", false);
    show(false);
    await audible("detached view stops playback", [
      false,
      false,
      false,
    ]);
    assert(
      borrowed.every(
        (track) => track.readyState === "live",
      ),
      "View cleanup must retain borrowed tracks",
    );
    show(true);
    await audible("view remount restores every track", [
      true,
      true,
      true,
    ]);
    assert(
      outputElements().every(
        (element) => element.sinkId === "default",
      ),
      "Remounted renderers must inherit the selected output",
    );
    publish({ bob });
    await audible(
      "removing one participant retains the other",
      [false, false, true],
    );
    controls.setPeerMuted("alice", true);
    publish({ alice, bob });
    await audible(
      "reconnected sources retain member mute",
      [false, false, true],
    );
    assert(
      outputElements().every(
        (element) => element.sinkId === "default",
      ),
      "New renderers must inherit the selected output",
    );
    controls.setPeerMuted("alice", false);
    await controls.setOutputDevice("");
    await audible(
      "returning to system default retains all audio",
      [true, true, true],
    );

    const sender = new RTCPeerConnection({
      iceServers: [],
    });
    const receiver = new RTCPeerConnection({
      iceServers: [],
    });
    peers.push(sender, receiver);
    const remote: MediaStreamTrack[] = [];
    sender.onicecandidate = ({ candidate }) => {
      if (candidate)
        void receiver.addIceCandidate(candidate);
    };
    receiver.onicecandidate = ({ candidate }) => {
      if (candidate) void sender.addIceCandidate(candidate);
    };
    receiver.ontrack = ({ track }) => remote.push(track);
    tracks
      .slice(0, 2)
      .forEach((track) =>
        sender.addTrack(track, new MediaStream([track])),
      );
    await sender.setLocalDescription(
      await sender.createOffer(),
    );
    await receiver.setRemoteDescription(
      sender.localDescription!,
    );
    await receiver.setLocalDescription(
      await receiver.createAnswer(),
    );
    await sender.setRemoteDescription(
      receiver.localDescription!,
    );
    const deadline = performance.now() + 10000;
    while (
      remote.length !== 2 ||
      remote.some((track) => track.muted)
    ) {
      assert(
        performance.now() < deadline,
        "RTP reception did not start",
      );
      await sleep(25);
    }
    borrowed.push(...remote);
    publish({
      alice: {
        ...alice,
        stream: new MediaStream(remote),
        nativeScreenStream: undefined,
      },
    });
    await audible("two real WebRTC tracks", [
      true,
      true,
      false,
    ]);
    publish({
      alice: {
        ...alice,
        stream: new MediaStream([remote[0]]),
      },
    });
    await audible(
      "WebRTC microphone and native screen audio",
      [true, true, false],
    );
    publish({
      alice: {
        ...alice,
        stream: new MediaStream([tracks[1], remote[0]]),
        nativeScreenStream: undefined,
      },
    });
    await audible("native track first with WebRTC audio", [
      true,
      true,
      false,
    ]);
    dispose();
    dispose = () => {};
    await audible("owner disposal stops all playback", [
      false,
      false,
      false,
    ]);
    assert(
      borrowed.every(
        (track) => track.readyState === "live",
      ),
      "Playback disposal must not stop borrowed tracks",
    );
    return {
      ok: true,
      frequenciesHz: frequencies,
      renderedTabAudio: true,
      checks,
    };
  } finally {
    dispose();
    peers.forEach((peer) => peer.close());
    borrowed.forEach((track) => track.stop());
    oscillators.forEach((oscillator) => oscillator.stop());
    capture.getTracks().forEach((track) => track.stop());
    await context.close();
    host.remove();
    setAppState("session", "clientViewData", reconcile({}));
  }
}

window.__AUDIO_PLAYBACK_START__ = () => {
  delete window.__AUDIO_PLAYBACK_START__;
  void main().then(
    (report) => {
      window.__SPEED_TEST_REPORT__ = report;
    },
    (error) => {
      window.__SPEED_TEST_ERROR__ =
        error.stack ?? String(error);
    },
  );
};
