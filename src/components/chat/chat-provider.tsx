import { localStream } from "@/libs/stream";
import { WebRTCProvider } from "@/libs/core/rtc-context";
import { ParentComponent } from "solid-js";
import { appOptions } from "@/options";

function changeAudioEncoding(
  parameters: RTCRtpSendParameters,
): RTCRtpSendParameters | null {
  if (!parameters.encodings || !parameters.encodings[0]) {
    return null;
  }
  const encoding = parameters.encodings[0];
  encoding.active = true;
  encoding.maxBitrate = appOptions.audioMaxBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";
  return parameters;
}

function changeVideoEncoding(
  parameters: RTCRtpSendParameters,
): RTCRtpSendParameters | null {
  parameters.degradationPreference = "maintain-framerate";

  if (!parameters.encodings || !parameters.encodings[0]) {
    return null;
  }
  const encoding = parameters.encodings[0];
  encoding.active = true;
  encoding.maxBitrate = appOptions.videoMaxBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";

  // encoding.scaleResolutionDownBy = 2;
  return parameters;
}

const ChatProvider: ParentComponent = (props) => {
  return (
    <>
      <WebRTCProvider
        localStream={localStream()}
        onTrackChanged={(target, pc) => {
          const senders = pc.getSenders();
          senders.forEach((s) => {
            if (s.track?.kind === "audio") {
              const parameters = changeAudioEncoding(
                s.getParameters(),
              );
              if (parameters) {
                s.setParameters(parameters);
              }

              console.log(
                `setting track ${s.track.id} audio encoding parameters: `,
                s.getParameters(),
              );
            } else if (s.track?.kind === "video") {
              const parameters = changeVideoEncoding(
                s.getParameters(),
              );
              if (parameters) {
                s.setParameters(parameters);
              }

              console.log(
                `setting track ${s.track.id} video encoding parameters: `,
                s.getParameters(),
              );
            }
          });
          const receivers = pc.getReceivers();
          receivers.forEach((receiver: any) => {
            // if (receiver.track.kind === "video") {
            // }
            // console.log(receiver);
            if (receiver.jitterBufferTarget !== undefined) {
              receiver.jitterBufferTarget = 0;
            }

            if (receiver.playoutDelayHint !== undefined) {
              receiver.playoutDelayHint = 0;
            }
          });
        }}
      >
        {props.children}
      </WebRTCProvider>
    </>
  );
};

export default ChatProvider;
