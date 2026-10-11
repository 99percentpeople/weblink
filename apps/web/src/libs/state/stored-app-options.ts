import { resolveAudioSampling } from "../application/meeting-audio-settings";
import { resolveApplicationOptions } from "../domain/application-options";
import { sanitizeTurnServers } from "../domain/ice-server";
import { resolveNotificationOptions } from "../domain/notification-options";
import { resolveRemoteFileLimit } from "../domain/protocol/remote-file-limits";
import { resolveRemoteGamepadOptions } from "../domain/remote-control/gamepad-options";
import { resolveRemoteKeyboardOptions } from "../domain/remote-control/keyboard-options";
import { resolveRemotePointerOptions } from "../domain/remote-control/pointer-options";
import { resolveRemoteTouchOptions } from "../domain/remote-control/touch-options";
import { normalizeLocalePreference } from "../i18n/locale";
import {
  getDefaultAppOptions,
  type AppOption,
  type ClientConfig,
  type RoomConfig,
} from "./app-options";

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

function readConfigs<T>(
  value: unknown,
  read: (entry: Record<string, unknown>) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).flatMap(
      ([id, entry]) =>
        isRecord(entry) ? [[id, read(entry)]] : [],
    ),
  );
}

/** Read only the current settings shape; unknown fields are never persisted again. */
export function resolveStoredAppOptions(
  value: unknown,
  defaults = getDefaultAppOptions(),
): AppOption {
  const saved = isRecord(value) ? value : {};
  const options = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => {
      const candidate = Object.hasOwn(saved, key)
        ? saved[key]
        : undefined;
      const valid =
        fallback === null
          ? candidate === null ||
            typeof candidate === "string"
          : fallback === undefined
            ? typeof candidate === "string"
            : typeof fallback === "object"
              ? isRecord(candidate)
              : typeof candidate === typeof fallback &&
                (typeof candidate !== "number" ||
                  Number.isFinite(candidate));
      return [key, valid ? candidate : fallback];
    }),
  ) as AppOption;

  options.locale = normalizeLocalePreference(
    options.locale,
  );
  Object.assign(options, resolveAudioSampling(options));
  options.application = resolveApplicationOptions(
    options.application,
  );
  options.notifications = resolveNotificationOptions(
    options.notifications,
  );
  options.remoteFileMaxSize = resolveRemoteFileLimit(
    options.remoteFileMaxSize,
  );
  options.remotePointer = resolveRemotePointerOptions(
    options.remotePointer,
  );
  options.remoteTouch = resolveRemoteTouchOptions(
    options.remoteTouch,
  );
  options.remoteKeyboard = resolveRemoteKeyboardOptions(
    options.remoteKeyboard,
  );
  options.remoteGamepad = resolveRemoteGamepadOptions(
    options.remoteGamepad,
  );
  options.clientConfigs = readConfigs<ClientConfig>(
    options.clientConfigs,
    (entry) => ({
      name:
        typeof entry.name === "string"
          ? entry.name
          : undefined,
      provideFileList: entry.provideFileList !== false,
      remoteControl:
        entry.remoteControl === "allow" ||
        entry.remoteControl === "deny"
          ? entry.remoteControl
          : undefined,
    }),
  );
  options.roomConfigs = readConfigs<RoomConfig>(
    options.roomConfigs,
    (entry) => ({
      name:
        typeof entry.name === "string"
          ? entry.name
          : undefined,
      autoDownloadFiles: entry.autoDownloadFiles === true,
    }),
  );
  if (
    !Number.isSafeInteger(options.autoDownloadMaxSize) ||
    options.autoDownloadMaxSize <= 0
  )
    options.autoDownloadMaxSize =
      defaults.autoDownloadMaxSize;

  const servers = options.servers;
  options.servers = {
    stuns: Array.isArray(servers.stuns)
      ? servers.stuns.filter(
          (url): url is string => typeof url === "string",
        )
      : defaults.servers.stuns,
    turns: sanitizeTurnServers(
      servers.turns ?? defaults.servers.turns,
    ).map(({ url, username, password, authMethod }) => ({
      url,
      username,
      password,
      authMethod,
    })),
  };

  if (
    !Number.isSafeInteger(
      options.bufferedAmountLowThreshold,
    ) ||
    options.bufferedAmountLowThreshold < 0
  )
    options.bufferedAmountLowThreshold =
      defaults.bufferedAmountLowThreshold;
  if (
    !Number.isSafeInteger(
      options.bufferedAmountHighWaterMark,
    ) ||
    options.bufferedAmountHighWaterMark <= 0
  )
    options.bufferedAmountHighWaterMark =
      defaults.bufferedAmountHighWaterMark;
  if (
    options.bufferedAmountLowThreshold >=
    options.bufferedAmountHighWaterMark
  ) {
    options.bufferedAmountLowThreshold =
      defaults.bufferedAmountLowThreshold;
    options.bufferedAmountHighWaterMark =
      defaults.bufferedAmountHighWaterMark;
  }
  if (
    options.nativeWindowCaptureBackend !== "wgc" &&
    options.nativeWindowCaptureBackend !== "dxgi"
  )
    options.nativeWindowCaptureBackend =
      defaults.nativeWindowCaptureBackend;
  // Settings offer either fully automatic encoding or a concrete encoder/format pair.
  if (
    (options.nativeScreenEncoder === "auto") !==
    (options.nativeScreenCodec === null)
  ) {
    options.nativeScreenEncoder =
      defaults.nativeScreenEncoder;
    options.nativeScreenCodec = defaults.nativeScreenCodec;
  }
  return options;
}
