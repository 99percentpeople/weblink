type CheckIceServerAvailabilityOptions = {
  iceTransportPolicy: "relay" | "all";
  candidateType?: "relay" | "host" | "srflx";
  timeout: number;
};

export async function checkIceServerAvailability(
  iceServer: RTCIceServer,
  {
    iceTransportPolicy = "relay",
    candidateType,
    timeout = 5000,
  }: Partial<CheckIceServerAvailabilityOptions>,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    console.log("check ice server:", iceServer);
    const configuration: RTCConfiguration = {
      iceServers: [iceServer],
      iceTransportPolicy,
    };

    const pc = new RTCPeerConnection(configuration);

    let isIceAvailable = false;
    let isCompleted = false; // prevent multiple calls to resolve or reject

    const triggerCompleted = (errMsg?: string) => {
      if (isCompleted) return;
      isCompleted = true;
      clearTimeout(timer);
      pc.close();
      if (!isIceAvailable) {
        reject(
          new Error(
            errMsg || "ice server is not available",
          ),
        );
      } else {
        resolve(true);
      }
    };

    // set timeout handler
    const timer = setTimeout(() => {
      triggerCompleted("check ice server timeout");
    }, timeout);

    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
        console.log(
          "collect ice candidate:",
          event.candidate.candidate,
        );
        if (
          candidateType &&
          event.candidate.type !== candidateType &&
          !event.candidate.candidate.includes(candidateType)
        ) {
          return;
        }
        isIceAvailable = true;
      }
      triggerCompleted(
        "ice candidate collection completed",
      );
    };

    // Modify the error handler to not reject immediately
    pc.onicecandidateerror = (event) => {
      console.error("ice candidate error:", event);
      // Do not reject immediately, allow ICE gathering to continue
    };

    pc.createDataChannel("test"); // create data channel, trigger ICE collection

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch((error) => {
        console.error("create offer failed:", error);
        if (!isCompleted) {
          isCompleted = true;
          clearTimeout(timer);
          reject(error);
          pc.close();
        }
      });
  });
}
