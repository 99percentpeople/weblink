import type {
  NativeScreenShare,
  NativeScreenOptions,
  NativeSendCodecs,
} from "@weblink/platform";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";
import { createUuid } from "@/libs/domain/ids";
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
  if (share.offerRecording) {
    try {
      return await openConnection(
        share,
        sessionId,
        options,
        signal,
        ended,
        true,
      );
    } catch {
      // Reuse is optional. Negotiation/capability failures before recording starts
      // fall back after disposing the attempt, without ending the shared capture.
      signal.throwIfAborted();
    }
  }
  return openConnection(
    share,
    sessionId,
    options,
    signal,
    ended,
    false,
  );
}

async function openConnection(
  share: NativeScreenShare,
  sessionId: string,
  options: NativeScreenOptions | undefined,
  signal: AbortSignal,
  ended: (error?: Error) => void,
  reuse: boolean,
): Promise<RecordingInput> {
  signal.throwIfAborted();
  const id = createUuid();
  let closed = false;
  let answered = false;
  let ready = false;
  let notified = false;
  let opening: Promise<string | null> | undefined;
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
    if (closed || notified) return;
    close();
    if (ready) ended(error);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    const capabilities = browserDecodeCapabilities();
    let fallbackCodecs: NativeSendCodecs | undefined;
    if (!reuse) {
      // Borrowing an existing encoder needs no hardware enumeration/probe.
      // Only the fallback chooses a new local encoder independently of remote peers.
      const codecs = await createNativeCodecSelection(
        share,
        {
          ...options,
          codec: undefined,
          audioCodec: undefined,
        },
      );
      codecs.setReceivers([capabilities]);
      fallbackCodecs = codecs.selected();
    }
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
    const candidate = (candidate: RTCIceCandidateInit) => {
      if (!closed)
        void receiver!
          .addIceCandidate(candidate)
          .catch(failed);
    };
    opening = reuse
      ? share.offerRecording!(
          sessionId,
          id,
          {
            video: capabilities.video ?? ["video/h264"],
            audio: capabilities.audio?.[0] ?? "audio/opus",
          },
          candidate,
          (error) => {
            if (closed || notified) return;
            if (!ready) {
              close();
              return;
            }
            notified = true;
            // Keep the receiver alive until MediaRecorder has emitted its final blob.
            // Ending the borrowed sender saves the current file, without a new source.
            ended(error ? new Error(error) : undefined);
          },
        )
      : share.offer(
          sessionId,
          id,
          [],
          false,
          true,
          candidate,
          undefined,
          fallbackCodecs,
        );
    const offer = await opening;
    if (offer === null)
      throw new Error("No reusable native sender");
    if (closed)
      throw new Error("Native recording connection ended");
    const answer = await receiver.answer(offer);
    await share.answer(sessionId, id, answer);
    answered = true;
    for (const candidate of candidates.splice(0))
      await share.addIceCandidate(sessionId, id, candidate);
    await receiver.connected(options?.audio === true);
    if (reuse) await receiver.decoded(4000);
    if (closed)
      throw new Error("Native recording connection ended");
    receiver.monitorDecode(() => {});
    ready = true;
    return { stream: receiver.stream, close };
  } catch (error) {
    close();
    // The offer has settled now: also cover a synchronous end callback that ran
    // before `opening` was assigned, and release the attempt before falling back.
    await closePeer();
    throw error;
  }
}
