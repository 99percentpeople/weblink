import type {
  NativeScreenOptions,
  NativeScreenShare,
  NativeSendCodecs,
} from "@weblink/platform";
import { commonCodecs } from "../domain/media-codecs";
import type { MediaDecodeCapabilities } from "../domain/protocol/media-codecs";

interface NativeCodecSelection {
  setReceivers(
    receivers: readonly (
      | MediaDecodeCapabilities
      | undefined
    )[],
  ): void;
  onCodecsChanged(changed: () => void): () => void;
  selected(): NativeSendCodecs | undefined;
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

/** One choice belongs to a capture publication, shared by all of its senders. */
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
  const listeners = new Set<() => void>();
  let selected: NativeSendCodecs | undefined;
  let initialized = false;
  let key: string | undefined;
  return {
    setReceivers(
      receivers: readonly (
        | MediaDecodeCapabilities
        | undefined
      )[],
    ) {
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
      const nextKey = JSON.stringify(next);
      initialized = true;
      if (key === nextKey) return;
      key = nextKey;
      selected = next;
      for (const changed of listeners) changed();
    },
    onCodecsChanged(changed: () => void) {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    selected(): NativeSendCodecs | undefined {
      if (!initialized) return;
      if (
        !selected?.video ||
        (options?.audio && !selected.audio)
      )
        throw new Error(
          "No common native media codec for all connected receivers",
        );
      return {
        video: selected.video,
        audio: selected.audio || "audio/opus",
      };
    },
  };
}
