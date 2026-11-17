import type { VideoPresentationStats } from "@weblink/platform";

/** All timestamps must belong to ONE frame and ONE receiver clock. */
export function videoFrameLatency(timing: {
  captureTime?: number;
  receiveTime?: number;
  presentationTime?: number;
  expectedDisplayTime?: number;
  processingDuration?: number;
}): VideoPresentationStats {
  const valid = (n?: number): n is number =>
    n !== undefined && Number.isFinite(n) && n >= 0;
  const {
    captureTime: capture,
    receiveTime: receive,
    presentationTime: submit,
    expectedDisplayTime: display,
  } = timing;
  if (!valid(submit)) return {};
  const value: VideoPresentationStats = {
    latencyEndpoint: "compositor-submit",
  };
  if (valid(display) && display >= submit)
    value.displayWaitMs = display - submit;
  if (valid(timing.processingDuration))
    value.frameDecodeMs = timing.processingDuration * 1000;
  // receiveTime also identifies a remote frame: local preview is never E2E.
  if (!valid(receive) || receive > submit) return value;
  value.receiveToPresentMs = submit - receive;
  if (valid(capture) && capture <= receive) {
    value.captureToReceiveMs = receive - capture;
    value.endToEndMs = submit - capture;
    value.endToEndState = "estimated";
  }
  return value;
}
