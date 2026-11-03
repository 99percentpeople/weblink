import type { MediaReceiverFactory } from "../domain/media-receiver";
import { createSignal } from "solid-js";
import type { NativeMediaReceive } from "@weblink/platform";
import {
  ScreenReceiver,
  type ScreenReceiverFactory,
} from "../domain/native-screen/receiver";
import { browserDecodeCapabilities } from "../domain/media-codecs";
import { NativeMediaReceiver } from "./native-media-receiver";
import {
  ScreenDecodeError,
  ScreenDecodeStallError,
} from "../domain/native-screen/errors";
import { screenControlData } from "./screen-control-data";

/** Capability discovery and failure policy belong to the application, not the
 * browser receiver. A failed native codec is suppressed for this app session. */
export class MediaReceiveService {
  private readonly nativeCodecs = createSignal<string[]>(
    [],
  );
  private readonly disabled = createSignal<
    readonly string[]
  >([]);
  private busy = false;
  readonly ready: Promise<void>;
  constructor(
    private readonly native?: NativeMediaReceive,
  ) {
    this.ready = native
      ? native
          .codecs()
          .then((codecs) => {
            this.nativeCodecs[1]([
              ...new Set(
                codecs.map((c) => c.toLowerCase()),
              ),
            ]);
          })
          .catch((error) =>
            console.warn(
              "Native receiver discovery failed",
              error,
            ),
          )
      : Promise.resolve();
  }
  cameraCapabilities() {
    const codecs = this.nativeCodecs[0]();
    const video = codecs.filter((c) =>
      c.startsWith("video/"),
    );
    return video.length
      ? {
          video,
          audio: codecs.filter((c) =>
            c.startsWith("audio/"),
          ),
        }
      : null;
  }
  readonly createCameraReceiver: MediaReceiverFactory = (
    _sdp,
    configuration,
    changed,
    failed,
    candidate,
  ) => {
    if (!this.native || !this.cameraCapabilities())
      throw new ScreenDecodeError(
        "Native camera receiver unavailable",
      );
    return new NativeMediaReceiver(
      this.native,
      configuration,
      {
        source: "camera",
        changed,
        failed,
        candidate,
        retryNativeDecode: true,
        rejectCodec: () =>
          new ScreenDecodeError(
            "Camera format unavailable",
          ),
      },
    );
  };
  capabilities() {
    const browser = browserDecodeCapabilities();
    const native = this.nativeCodecs[0]().filter(
      (codec) =>
        codec.startsWith("video/") &&
        !this.disabled[0]().includes(codec),
    );
    return {
      audio: browser.audio,
      video:
        this.native?.allowBrowserFallback === false
          ? native
          : native.length
            ? [
                ...new Set([
                  ...(browser.video ?? []),
                  ...native,
                ]),
              ]
            : browser.video,
    };
  }
  readonly createScreenReceiver: ScreenReceiverFactory = (
    sdp,
    ...args
  ) => {
    const section =
      sdp
        .split(/(?=^m=)/m)
        .find((s) => s.startsWith("m=video ")) ?? "";
    const codecs = [
      ...section.matchAll(/^a=rtpmap:\d+ ([^/\s]+)\//gim),
    ].map((m) => `video/${m[1].toLowerCase()}`);
    const codec = codecs.find(
      (c) =>
        this.nativeCodecs[0]().includes(c) &&
        !this.disabled[0]().includes(c),
    );
    if (!this.native || !codec || this.busy || !args[3]) {
      if (this.native?.allowBrowserFallback === false) {
        if (this.busy)
          throw new Error(
            "Native screen receive lane is already in use",
          );
        throw new ScreenDecodeError(
          !args[3]
            ? "Native screen receiving requires trickle ICE"
            : "No native decoder is available for this screen format",
        );
      }
      return new ScreenReceiver(...args);
    }
    this.busy = true;
    return new NativeMediaReceiver(this.native, args[0], {
      source: "screen",
      changed: args[1],
      failed: args[2],
      candidate: args[3],
      released: () => {
        this.busy = false;
      },
      rejectCodec: () => {
        this.disabled[1]((codecs) => [...codecs, codec]);
        if (this.native?.allowBrowserFallback === false) {
          // Reject only this format. Automatic negotiation can select another
          // native decoder; fixed sender choices keep their existing semantics.
          return new ScreenDecodeError();
        }
        // This first native backend is a single receive lane. A failed backend
        // returns subsequent offers to the established browser path for the
        // session, including another codec after HEVC rejection.
        this.disabled[1](this.nativeCodecs[0]());
        // Retry the format through the browser when it can receive it; otherwise
        // the existing sender policy negotiates another mutually supported codec.
        return browserDecodeCapabilities().video?.includes(
          codec,
        )
          ? new ScreenDecodeStallError()
          : new ScreenDecodeError();
      },
      retryNativeDecode:
        this.native.allowBrowserFallback === false,
      data: args[4] && screenControlData(args[4]),
    });
  };
}
