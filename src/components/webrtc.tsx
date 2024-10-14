"use client";

import { Button } from "@/components/ui/button";
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { db } from "@/libs/firebase";
import {
  child,
  DatabaseReference,
  onValue,
  push,
  ref,
  remove,
  set,
  Unsubscribe,
  update,
} from "firebase/database";

export default function Home() {
  let webcamVideo: HTMLVideoElement | undefined;
  let remoteVideo: HTMLVideoElement | undefined;

  const [cancelCallback, setCancelCallback] = createSignal<
    (() => Promise<void> | void) | null
  >(null);

  const [isCaller, setIsCaller] = createSignal(false);

  const [acceptCallback, setAcceptCallback] = createSignal<
    ((resolve: boolean) => Promise<void> | void) | null
  >(null);

  let roomRef: DatabaseReference;

  const [localStream, setLocalStream] =
    createSignal<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] =
    createSignal<MediaStream | null>(null);

  const [peerConnection, setPeerConnection] =
    createSignal<RTCPeerConnection | null>(null);

  onMount(async () => {
    roomRef = ref(db, "webrtc/rooms/my-room");

    createEffect(() => {
      const local = localStream();
      if (webcamVideo && local) {
        webcamVideo.srcObject = local;
      }
    });

    createEffect(() => {
      const remote = remoteStream();
      if (remoteVideo && remote) {
        remoteVideo.srcObject = remote;
      }
    });

    const offerRef = child(roomRef, "offer");
    const answerRef = child(roomRef, "answer");
    onValue(offerRef, (snapshot) => {
      if (snapshot.exists()) {
        const offer = snapshot.val();

        setAcceptCallback(() => async (resolve) => {
          if (resolve) {
            await joinCall(offer);
          } else {
            remove(offerRef);
          }
          setAcceptCallback(null);
        });
      } else {
        cancelCallback()?.();
        setCancelCallback(null);
        setAcceptCallback(null);
      }
    });

    onValue(answerRef, (snapshot) => {
      if (!snapshot.exists()) {
        cancelCallback()?.();
        setCancelCallback(null);
      }
    });

    onCleanup(async () => {
      await clearSession();
    });
  });

  const [callStatus, setCallStatus] = createSignal<
    "waiting" | "connected" | "closed" | "error"
  >("closed");

  createEffect(async () => {
    const pc = peerConnection();
    if (!pc) return;

    const local = localStream();

    if (local) {
      const tracks = local.getTracks();
      const senders = pc.getSenders();
      tracks.forEach((track) => {
        const sender = senders.find(
          (s) => s.track?.id == track.id,
        );
        if (sender) {
          sender.replaceTrack(track);
        } else {
          // 添加新轨道到连接
          pc.addTrack(track, local);
        }
      });
    } else {
      pc.addTransceiver("video", { direction: "recvonly" });
    }
  });

  // Function to replace track when local stream changes
  async function updateStream(newStream: MediaStream) {
    const pc = peerConnection();
    if (!pc) return;

    // Replace existing tracks with new tracks
    const senders = pc.getSenders();
    newStream.getTracks().forEach((track) => {
      const sender = senders.find(
        (s) => s.track?.kind === track.kind,
      );
      if (sender) {
        sender.replaceTrack(track);
      } else {
        pc.addTrack(track, newStream);
      }
    });

    // Stop old tracks
    localStream()
      ?.getTracks()
      .forEach((track) => track.stop());

    // Update local stream
    setLocalStream(newStream);

    // Trigger renegotiation
    await createOfferAndSend(pc);
  }

  async function createOfferAndSend(
    peerConnection: RTCPeerConnection,
  ) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const offerRef = child(roomRef, "offer");
    await set(offerRef, {
      type: offer.type,
      sdp: offer.sdp,
    });
    // setIsCaller(true);
    return offerRef;
  }

  async function createAnswerAndSend(
    peerConnection: RTCPeerConnection,
  ) {
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const answerRef = child(roomRef, "answer");
    await set(answerRef, {
      type: answer.type,
      sdp: answer.sdp,
    });
    // setIsCaller(false);
    return answerRef;
  }

  function addConnectionEventHandler(
    peerConnection: RTCPeerConnection,
  ) {
    const handleTrack = (ev: RTCTrackEvent) => {
      console.log(`track event:`, ev);
      if (remoteStream() !== ev.streams[0])
        setRemoteStream(ev.streams[0]);
    };
    peerConnection.addEventListener("track", handleTrack);

    const handleError = (
      ev: RTCPeerConnectionIceErrorEvent,
    ) => {
      console.error(ev.errorText);
    };

    peerConnection.addEventListener(
      "icecandidateerror",
      handleError,
    );
    const handleNegotiationneeded = async () => {
      console.log(`on negotiationneeded`);
      if (peerConnection.signalingState !== "stable") {
        console.log("Negotiation needed");

        await createOfferAndSend(peerConnection);
      }
    };

    peerConnection.addEventListener(
      "negotiationneeded",
      handleNegotiationneeded,
    );

    const connectionstatechangeHandler = () => {
      switch (peerConnection.connectionState) {
        case "connected":
          setCallStatus("connected");
          break;
        case "connecting":
          setCallStatus("waiting");
          break;
        case "closed":
        case "disconnected":
        case "failed":
        case "new":
          setCallStatus("closed");
          break;
      }
    };

    peerConnection.addEventListener(
      "connectionstatechange",
      connectionstatechangeHandler,
    );

    const iceconnectionstatechangeHandler = () => {
      switch (peerConnection.iceConnectionState) {
        case "checking":
          setCallStatus("waiting");
          break;
        case "connected":
          setCallStatus("connected");
        case "completed":
          break;
          break;
        case "closed":
        case "disconnected":
        case "failed":
        case "new":
          setCallStatus("closed");
          break;
      }
    };

    peerConnection.addEventListener(
      "iceconnectionstatechange",
      iceconnectionstatechangeHandler,
    );

    const signalingstatechangeHandler = () => {
      switch (peerConnection.signalingState) {
        case "have-local-offer":
        case "have-remote-offer":
          setCallStatus("waiting");
          break;
        case "have-local-pranswer":
        case "have-remote-pranswer":
          setCallStatus("connected");
          break;
        case "closed":
        case "stable":
          setCallStatus("closed");
      }
    };

    peerConnection.addEventListener(
      "signalingstatechange",
      signalingstatechangeHandler,
    );

    return () => {
      peerConnection.removeEventListener(
        "track",
        handleTrack,
      );
      peerConnection.removeEventListener(
        "icecandidateerror",
        handleError,
      );
      peerConnection.removeEventListener(
        "negotiationneeded",
        handleNegotiationneeded,
      );
      peerConnection.removeEventListener(
        "connectionstatechange",
        connectionstatechangeHandler,
      );
      peerConnection.removeEventListener(
        "signalingstatechange",
        signalingstatechangeHandler,
      );
      peerConnection.removeEventListener(
        "iceconnectionstatechange",
        iceconnectionstatechangeHandler,
      );
    };
  }

  async function openStream() {
    try {
      const newStream =
        await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
      if (localStream()) {
        await updateStream(newStream);
      } else {
        setLocalStream(newStream);
      }
    } catch (err) {
      console.error("Error opening webcam: ", err);
    }
  }
  async function closeWebCam() {
    localStream()
      ?.getTracks()
      .forEach((track) => {
        track.stop();
      });
    setLocalStream(null);
  }

  async function changeStream() {
    const newStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
    await updateStream(newStream);
  }

  const startCall = async () => {
    cancelCallback()?.();
    setCancelCallback(null);
    setIsCaller(true);
    const peerConnection = new RTCPeerConnection();
    const unsubscribeTrack =
      addConnectionEventHandler(peerConnection);
    setPeerConnection(peerConnection);

    // 监听ICE候选者
    const candidateRef = child(roomRef, "callerCandidates");
    const handleIcecandidate = (
      ev: RTCPeerConnectionIceEvent,
    ) => {
      if (ev.candidate) {
        push(candidateRef, ev.candidate.toJSON());
      }
    };
    peerConnection.addEventListener(
      "icecandidate",
      handleIcecandidate,
    );

    // 创建offer并保存
    const offerRef =
      await createOfferAndSend(peerConnection);

    // 监听answer
    const unsubscribeAnswer = onValue(
      child(roomRef, "answer"),
      async (snapshot) => {
        if (
          snapshot.exists() &&
          !peerConnection.currentRemoteDescription
        ) {
          const answer = snapshot.val();
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(answer),
          );
        }
      },
    );

    // 监听Callee的ICE候选者
    const unsubscribeCalleeCandidates = onValue(
      child(roomRef, "calleeCandidates"),
      (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          // if (peerConnection.signalingState === "closed") return;
          const candidate =
            childSnapshot.val() as RTCIceCandidateInit;
          console.log(`calleeCandidates received`);

          peerConnection.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
        });
      },
    );

    setCancelCallback(() => async () => {
      peerConnection.removeEventListener(
        "icecandidate",
        handleIcecandidate,
      );

      unsubscribeTrack();
      peerConnection.close();
      unsubscribeAnswer();
      unsubscribeCalleeCandidates();
      await remove(offerRef);
      await remove(candidateRef);
      setCancelCallback(null);
      setIsCaller(false);
      setPeerConnection(null);
    });
  };

  const joinCall = async (
    offer: RTCSessionDescriptionInit,
  ) => {
    await cancelCallback()?.();
    setIsCaller(false);
    const peerConnection = new RTCPeerConnection();
    const unsubscribeTrack =
      addConnectionEventHandler(peerConnection);
    setPeerConnection(peerConnection);

    // 监听ICE候选者
    const candidateRef = child(roomRef, "calleeCandidates");
    const handleIcecandidate = (
      ev: RTCPeerConnectionIceEvent,
    ) => {
      if (ev.candidate) {
        push(candidateRef, ev.candidate.toJSON());
      }
    };
    let unsubscribeCallerCandidates:
      | Unsubscribe
      | undefined;
    peerConnection.addEventListener(
      "icecandidate",
      handleIcecandidate,
    );
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(offer),
    );
    // 监听Offer并创建Answer
    const answerRef =
      await createAnswerAndSend(peerConnection);
    const unsubiscribeOffer = onValue(
      child(roomRef, "offer"),
      async (snapshot) => {
        if (!snapshot.exists()) return;
        const offer =
          snapshot.val() as RTCSessionDescriptionInit;
        console.log(
          `new offer sdp: ${offer.sdp}`,
          `pc sdp: ${peerConnection.remoteDescription?.sdp}`,
        );

        if (
          offer.sdp ===
          peerConnection.remoteDescription?.sdp
        )
          return;
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(offer),
        );
        await createAnswerAndSend(peerConnection);
      },
    );

    // 监听Caller的ICE候选者
    unsubscribeCallerCandidates = onValue(
      child(roomRef, "callerCandidates"),
      (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          // if (peerConnection.signalingState === "closed") return;
          const candidate =
            childSnapshot.val() as RTCIceCandidateInit;

          console.log(`callerCandidates received`);
          peerConnection.addIceCandidate(
            new RTCIceCandidate(candidate),
          );
          setCallStatus("connected");
        });
      },
    );

    setCancelCallback(() => async () => {
      unsubscribeCallerCandidates?.();
      peerConnection.removeEventListener(
        "icecandidate",
        handleIcecandidate,
      );
      unsubscribeTrack();
      unsubiscribeOffer();
      peerConnection.close();
      setIsCaller(false);
      await remove(answerRef);
      await remove(candidateRef);
      setCancelCallback(null);
      setPeerConnection(null);
    });
  };

  const clearSession = async () => {
    try {
      await cancelCallback()?.();
      await remove(roomRef);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <main class="container flex flex-col gap-2">
      <div
        class="grid w-full grid-cols-1 place-content-center gap-2
          md:grid-cols-2"
      >
        <div class="relative aspect-video w-full overflow-hidden">
          <video
            autoplay
            ref={webcamVideo}
            class="absolute inset-0 h-full w-full bg-black object-contain"
          ></video>
        </div>
        <div class="relative aspect-video w-full overflow-hidden">
          <video
            autoplay
            ref={remoteVideo}
            class="absolute inset-0 h-full w-full bg-black object-contain"
          ></video>
        </div>
      </div>
      <p class="large">Status: {callStatus()}</p>
      <div class="flex w-full max-w-sm flex-col gap-2">
        <Show
          when={!localStream()}
          fallback={
            <div class="flex w-full gap-2">
              <Button
                variant="destructive"
                onClick={() => closeWebCam()}
                class="w-full"
              >
                Close Camera
              </Button>
              <Button
                variant="default"
                onClick={() => changeStream()}
                class="w-full"
              >
                Change Stream
              </Button>
            </div>
          }
        >
          <Button onClick={() => openStream()}>
            Open Camera
          </Button>
        </Show>

        <Show
          when={
            !isCaller() &&
            !cancelCallback() &&
            !acceptCallback()
          }
        >
          <Button onClick={startCall}>Start Call</Button>
        </Show>
        <Show when={!isCaller() && acceptCallback()}>
          {(accept) => (
            <>
              <Button onClick={() => accept()(true)}>
                Accept
              </Button>
              <Button
                onClick={() => accept()(false)}
                variant="destructive"
              >
                Reject
              </Button>
            </>
          )}
        </Show>
        <Show when={cancelCallback()}>
          {(cancel) => (
            <Button
              onClick={cancel()}
              variant="destructive"
            >
              Cancel
            </Button>
          )}
        </Show>
      </div>
    </main>
  );
}
