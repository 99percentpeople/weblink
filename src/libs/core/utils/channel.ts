export async function waitChannel(channel: RTCDataChannel) {
  return new Promise<void>((reslove, reject) => {
    if (channel.readyState === "open") {
      reslove();
    } else if (channel.readyState === "closed") {
      reject(new Error(`channel ${channel.label} closed`));
    } else {
      const onOpen = () => {
        channel.removeEventListener("open", onOpen);
        reslove();
      };
      const onClose = () => {
        channel.removeEventListener("close", onClose);
        reject(new Error(`channel ${channel.label} close`));
      };
      const onError = () => {
        channel.removeEventListener("error", onError);
        reject(new Error(`channel ${channel.label} error`));
      };
      channel.addEventListener("open", onOpen);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onError);
    }
  });
}

export async function waitBufferedAmountLowThreshold(
  channel: RTCDataChannel,
  bufferedAmountLowThreshold: number,
) {
  channel.bufferedAmountLowThreshold =
    bufferedAmountLowThreshold;
  return new Promise<RTCDataChannel>((reslove) => {
    if (
      channel.bufferedAmount <=
      channel.bufferedAmountLowThreshold
    ) {
      return reslove(channel);
    }

    channel.addEventListener("bufferedamountlow", () => {
      reslove(channel);
    });
  });
}
