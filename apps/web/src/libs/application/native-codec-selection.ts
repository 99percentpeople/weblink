import type {
  NativeScreenOptions,
  NativeScreenShare,
  NativeSendCodecs,
} from "@weblink/platform";
import { commonCodecs } from "../domain/media-codecs";
import type { MediaDecodeCapabilities } from "../domain/protocol/media-codecs";

interface NativeCodecSelection {
  select(
    receiver?: MediaDecodeCapabilities,
  ): NativeSendCodecs;
  recording(): NativeSendCodecs | undefined;
}
type NativeCodecPreferences = Partial<
  Pick<
    NativeScreenOptions,
    | "codec"
    | "audioCodec"
    | "encoder"
    | "audio"
    | "colorMatrix"
    | "colorRange"
  >
>;

/** Probe a capture once, then choose independently for each receiver. */
export async function createNativeCodecSelection(
  share: NativeScreenShare,
  options?: NativeCodecPreferences,
): Promise<NativeCodecSelection> {
  const [encoders, audio] = await Promise.all([
    Promise.resolve()
      .then(() => share.encoders())
      .catch(() => null),
    Promise.resolve()
      .then(() => share.codecs("audio"))
      .catch(() => null),
  ]);
  const available = (encoders ?? []).filter(
    (encoder) =>
      !options?.encoder ||
      options.encoder === "auto" ||
      encoder.id === options.encoder,
  );
  // Capture converts pixels once. VP8 cannot describe a BT.709/full-range source.
  const vp8 =
    options?.colorRange !== "full" &&
    (options?.colorMatrix === "bt601" ||
      (options?.colorMatrix !== "bt709" &&
        (!options?.codec ||
          options.codec === "video/vp8")));
  const video = encoders
    ? [
        ...new Set(
          available.flatMap((encoder) => encoder.codecs),
        ),
      ].filter((codec) => codec !== "video/vp8" || vp8)
    : vp8
      ? null
      : ["video/h264"];
  const hardware = available
    .filter((encoder) => encoder.hardware)
    .flatMap((encoder) => encoder.codecs);
  const select = (
    receiver?: MediaDecodeCapabilities,
  ): NativeSendCodecs => {
    const receivers = [receiver];
    const next = {
      video:
        options?.codec ??
        commonCodecs(
          "video",
          video,
          receivers,
          hardware,
        )[0] ??
        "",
      audio:
        options?.audioCodec ??
        (options?.audio
          ? commonCodecs("audio", audio, receivers)[0]
          : "audio/opus") ??
        "",
    };
    if (!next.video || (options?.audio && !next.audio))
      throw new Error(
        "No common native media codec for this receiver",
      );
    return next;
  };
  return {
    select,
    recording() {
      // The packet recorder currently accepts AVC/HEVC. Use the same hardware
      // preference and codec ordering as streaming, constrained by its own sink.
      if (
        options?.codec &&
        !["video/h264", "video/h265"].includes(
          options.codec,
        )
      )
        return;
      try {
        return select({
          video: ["video/h264", "video/h265"],
          audio,
        });
      } catch {
        return;
      }
    },
  };
}
