import type {
  NativeScreenShare,
  NativeScreenOptions,
} from "@weblink/platform";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";
import { browserDecodeCapabilities } from "@/libs/domain/media-codecs";
import { createNativeCodecSelection } from "./native-codec-selection";
import type { RecordingInput } from "./recording-service";

/** A dedicated local receiver consumes real native audio and is independent of UI preview visibility. */
export async function openNativeRecordingStream(
  share: NativeScreenShare,
  sessionId: string,
  options: NativeScreenOptions | undefined,
  signal: AbortSignal,
  ended: (error?: Error) => void,
): Promise<RecordingInput> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  let closed = false;
  let answered = false;
  let opening: Promise<string> | undefined;
  const candidates: RTCIceCandidateInit[] = [];
  let receiver: ScreenReceiver | undefined;
  const closePeer = () =>
    share.closePeer(sessionId, id).catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    receiver?.close();
    void closePeer();
    // A slow offer must not resurrect its peer after cancellation.
    if (opening) void opening.then(closePeer, closePeer);
  };
  const failed = (error: Error) => {
    if (closed) return;
    close();
    ended(error);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    // Local codec choice does not change the formats negotiated with remote peers.
    const codecs = await createNativeCodecSelection(share, {
      ...options,
      codec: undefined,
      audioCodec: undefined,
    });
    codecs.setReceivers([browserDecodeCapabilities()]);
    signal.throwIfAborted();
    receiver = new ScreenReceiver(
      { iceServers: [] },
      () => {},
      failed,
      (candidate) => {
        if (closed) return;
        if (!answered) candidates.push(candidate);
        else
          void share
            .addIceCandidate(sessionId, id, candidate)
            .catch(failed);
      },
    );
    opening = share.offer(
      sessionId,
      id,
      [],
      false,
      true,
      (candidate) => {
        if (!closed)
          void receiver!
            .addIceCandidate(candidate)
            .catch(failed);
      },
      undefined,
      codecs.selected(),
    );
    const offer = await opening;
    if (closed)
      throw new Error("Native recording connection ended");
    const answer = await receiver.answer(offer);
    await share.answer(sessionId, id, answer);
    answered = true;
    for (const candidate of candidates.splice(0))
      await share.addIceCandidate(sessionId, id, candidate);
    await receiver.connected(options?.audio === true);
    if (closed)
      throw new Error("Native recording connection ended");
    receiver.monitorDecode(() => {});
    return { stream: receiver.stream, close };
  } catch (error) {
    close();
    throw error;
  }
}
