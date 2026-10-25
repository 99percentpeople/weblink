import {
  AutomationError,
  parseCall,
  type ToolCall,
} from "@weblink/automation";
import type {
  CaptureCapabilities,
  NativeEncoder,
  NativeEncodingPreset,
  PlatformRuntime,
} from "@weblink/platform";
import type { AppOption } from "@/libs/state/app-options";
import {
  resolveEncodingPreset,
  supportedEncodingPresets,
} from "../native-encoding-presets";

// Keep both reads and writes confined to video preferences. Never expose the
// option store itself: it also contains credentials and permission policies.
const fields = {
  resolution: "videoResolution",
  frameRate: "videoFrameRate",
  maxBitrate: "videoMaxBitrate",
  degradationPreference: "degradationPreference",
  encoder: "nativeScreenEncoder",
  readbackBuffers: "nativeReadbackBuffers",
  colorMatrix: "nativeColorMatrix",
  colorRange: "nativeColorRange",
  screenCaptureBackend: "nativeScreenCaptureBackend",
  windowCaptureBackend: "nativeWindowCaptureBackend",
} as const satisfies Record<string, keyof AppOption>;

type Settings = {
  [K in keyof typeof fields]: AppOption[(typeof fields)[K]];
} & { codec: string; preset: NativeEncodingPreset };
type Field = keyof Settings;
const liveFields: readonly Field[] = [
  "resolution",
  "frameRate",
  "maxBitrate",
  "degradationPreference",
];
const nextShareFields: readonly Field[] = [
  "encoder",
  "codec",
  "preset",
  "readbackBuffers",
  "colorMatrix",
  "colorRange",
  "screenCaptureBackend",
  "windowCaptureBackend",
];

function read(options: AppOption): Settings {
  return {
    ...Object.fromEntries(
      Object.entries(fields).map(([field, option]) => [
        field,
        options[option],
      ]),
    ),
    codec: options.nativeScreenCodec ?? "auto",
    preset: resolveEncodingPreset(
      options.nativeEncoderPresets[
        options.nativeScreenEncoder
      ],
    ),
  } as Settings;
}

function invalid(message: string): never {
  throw new AutomationError("INVALID_ARGUMENTS", message);
}

function validateSelection(
  settings: Settings,
  patch: Partial<Settings>,
  encoders: NativeEncoder[],
  backends: CaptureCapabilities,
) {
  if (
    "encoder" in patch ||
    "codec" in patch ||
    "preset" in patch
  ) {
    if (settings.encoder === "auto") {
      if (settings.codec !== "auto")
        invalid("Automatic encoding requires codec=auto");
    } else if (
      !encoders.some(
        (encoder) =>
          encoder.id === settings.encoder &&
          encoder.codecs.includes(settings.codec),
      )
    ) {
      invalid("Unsupported encoder/codec combination");
    }
    if (
      "preset" in patch &&
      settings.preset !== "balanced" &&
      !supportedEncodingPresets(
        encoders,
        settings.encoder,
      ).includes(settings.preset)
    )
      invalid("Unsupported preset for this encoder");
  }
  for (const [field, kind] of [
    ["screenCaptureBackend", "screen"],
    ["windowCaptureBackend", "window"],
  ] as const) {
    if (
      field in patch &&
      settings[field] !== "auto" &&
      !backends[kind].some(
        (backend) => backend.id === settings[field],
      )
    )
      invalid(`Unsupported ${kind} capture backend`);
  }
  if (
    settings.codec === "video/vp8" &&
    (("colorMatrix" in patch &&
      settings.colorMatrix !== "bt601") ||
      ("colorRange" in patch &&
        settings.colorRange !== "limited"))
  )
    invalid("VP8 uses BT.601 limited range");
}

/** Uses the same preferences and live-update path as Settings, without UI input. */
export function createScreenSettings(port: {
  platform: PlatformRuntime;
  read(): AppOption;
  write(patch: Partial<AppOption>): void;
}) {
  return async (
    call: ToolCall,
    signal: AbortSignal,
    check: () => Promise<void>,
  ): Promise<Record<string, unknown>> => {
    if (
      call.name !== "screen.settings.get" &&
      call.name !== "screen.settings.update"
    )
      throw new AutomationError("UNSUPPORTED");
    parseCall(call);
    const patch = call.arguments.patch as
      | Partial<Settings>
      | undefined;
    if (patch && !Object.keys(patch).length)
      invalid("patch must contain at least one setting");
    await check();
    signal.throwIfAborted();
    const { platform } = port;
    if (
      platform.kind !== "desktop" ||
      !platform.capture ||
      !platform.screenShare
    )
      throw new AutomationError("UNSUPPORTED");
    const [encoders, backends] = await Promise.all([
      platform.screenShare.encoders(),
      platform.capture.backends(),
    ]);
    await check();
    signal.throwIfAborted();
    // Read after discovery/authorization so concurrent UI edits are preserved.
    // No awaits between reading, validating and committing the whole patch.
    const options = port.read();
    const previous = read(options);
    if (!patch)
      return {
        settings: previous,
        capabilities: {
          encoders: encoders.map((encoder) => ({
            id: encoder.id,
            name: encoder.name,
            hardware: encoder.hardware,
            codecs: [...encoder.codecs],
            presets: [
              ...new Set([
                "balanced",
                ...supportedEncodingPresets(
                  encoders,
                  encoder.id,
                ),
              ]),
            ],
          })),
          autoPresets: [
            ...new Set([
              "balanced",
              ...supportedEncodingPresets(encoders, "auto"),
            ]),
          ],
          captureBackends: {
            screen: [
              "auto",
              ...backends.screen.map((b) => b.id),
            ],
            window: backends.window.map((b) => b.id),
          },
        },
        application: {
          liveUpdateRequested: liveFields,
          nextShare: nextShareFields,
        },
      };
    const encoder = patch.encoder ?? previous.encoder;
    const settings = {
      ...previous,
      ...patch,
      preset:
        patch.preset ??
        resolveEncodingPreset(
          options.nativeEncoderPresets[encoder],
        ),
    };
    validateSelection(settings, patch, encoders, backends);
    const changed = (
      Object.keys(settings) as Field[]
    ).filter((key) => previous[key] !== settings[key]);
    const update: Partial<AppOption> = Object.fromEntries(
      Object.entries(fields)
        .filter(([field]) => Object.hasOwn(patch, field))
        .map(([field, option]) => [
          option,
          settings[field as keyof typeof fields],
        ]),
    );
    if ("codec" in patch)
      update.nativeScreenCodec =
        settings.codec === "auto" ? null : settings.codec;
    if ("preset" in patch)
      update.nativeEncoderPresets = {
        ...options.nativeEncoderPresets,
        [encoder]: settings.preset,
      };
    port.write(update);
    return {
      updated: true,
      previous,
      settings: read(port.read()),
      application: {
        liveUpdateRequested: changed.filter((field) =>
          liveFields.includes(field),
        ),
        nextShare: changed.filter((field) =>
          nextShareFields.includes(field),
        ),
      },
    };
  };
}
