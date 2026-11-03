import type {
  MediaReceiverFactory,
  MediaReceiveConnection,
} from "./media-receiver";
import type { MediaSignal } from "./media-signaling";

export interface IncomingMedia {
  receiver?: MediaReceiveConnection;
  candidates: RTCIceCandidateInit[];
}

/** Signal the answer before trickled ICE. Every await is scoped to the offer being answered. */
export async function answerMediaOffer(
  value: Extract<MediaSignal, { type: "offer" }>,
  incoming: IncomingMedia,
  port: {
    createReceiver: MediaReceiverFactory;
    loadIceServers(): Promise<RTCIceServer[]>;
    relayOnly(): boolean;
    send(signal: MediaSignal): void;
  },
  current: () => boolean,
  changed: (stream: MediaStream | null) => void,
  failed: (error: unknown) => void,
) {
  const servers = await port.loadIceServers();
  if (!current()) return;
  let answered = false;
  const pending: RTCIceCandidateInit[] = [];
  const onCandidate = (candidate: RTCIceCandidateInit) => {
    if (!current()) return;
    if (!answered) {
      if (pending.length < 256) pending.push(candidate);
    } else
      port.send({
        type: "candidate",
        id: value.id,
        candidate,
      });
  };
  const receiver = (incoming.receiver = port.createReceiver(
    value.sdp,
    {
      iceServers: servers,
      iceTransportPolicy: port.relayOnly()
        ? "relay"
        : "all",
    },
    changed,
    failed,
    value.trickleIce === true ? onCandidate : undefined,
  ));
  for (const candidate of incoming.candidates.splice(0))
    await receiver.addIceCandidate(candidate);
  const sdp = await receiver.answer(value.sdp);
  if (!current()) {
    receiver.close();
    return;
  }
  port.send({ type: "answer", id: value.id, sdp });
  answered = true;
  pending.forEach(onCandidate);
  await receiver.connected();
  if (!current()) {
    receiver.close();
    return;
  }
  receiver.monitorDecode(() => {
    if (current())
      port.send({
        type: "receiver-status",
        id: value.id,
        state: "healthy",
      });
  });
}
