import { t } from "@/i18n";
import type en from "@/assets/i18n/en-us.json";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import { LocalFileSystemError } from "@weblink/platform";

type ErrorKey = `errors.${keyof typeof en.errors}`;

const writeStages: Partial<
  Record<
    LocalFileSystemError["operation"],
    "create" | "write" | "commit"
  >
> = {
  resize: "create",
  write: "write",
  sync: "commit",
  move: "commit",
};

const messages: readonly [RegExp, ErrorKey][] = [
  [
    /^Room is already open in another tab$/i,
    "errors.room_in_use",
  ],
  [
    /^Room takeover timed out$/i,
    "errors.room_takeover_timeout",
  ],
  [/^password required$/i, "errors.password_required"],
  [
    /^(incorrect|invalid) password$/i,
    "errors.incorrect_password",
  ],
  [
    /^(?:(connection|join acknowledgement) timeout|connect timeout: after \d+ms)$/i,
    "errors.connection_timeout",
  ],
  [
    /^(socket connection error|connection failed|failed to fetch|network error|network unavailable)$/i,
    "errors.connection_failed",
  ],
  [
    /^(disconnected$|socket closed\b|socket is not (connected|open)|service is closed|.*session .* is closed)/i,
    "errors.connection_closed",
  ],
  [
    /^(invalid backend type|invalid URL|.*invalid url)/i,
    "errors.connection_config",
  ],
  [
    /^(invalid join acknowledgement|received join acknowledgement|invalid signaling|unexpected token|.*is not valid JSON)/i,
    "errors.connection_response",
  ],
  [
    /^(Member is not connected|The file recipient is not connected|.*message channel.*(closed|not ready|not open))/i,
    "errors.member_offline",
  ],
  [
    /^Shared file access is disabled$/i,
    "errors.sharing_disabled",
  ],
  [
    /^This file is no longer shared$/i,
    "errors.file_not_shared",
  ],
  [
    /^Member does not support shared file downloads$/i,
    "errors.shared_unsupported",
  ],
  [
    /^(Shared file verification failed|File content verification failed)/i,
    "errors.verification_failed",
  ],
  [
    /^(File content is unavailable|Shared content is unavailable|File offer was removed|(?:The )?file message was removed|cache .*(?:file )?not found|Received file is unavailable)$/i,
    "errors.file_unavailable",
  ],
  [
    /^(File is incomplete|cache .* is not complete)$/i,
    "errors.file_incomplete",
  ],
  [
    /^(file .* already has an active|This file is being imported)/i,
    "errors.file_busy",
  ],
  [
    /^(File library is unavailable|db is not initialized|IndexedDB.*failed)$/i,
    "errors.storage_unavailable",
  ],
  [
    /^(?:UnknownError: )?Error preparing Blob\/File data to be stored in object store$/i,
    "errors.storage_unavailable",
  ],
  [
    /^(Storage full|.*quota.*exceeded)$/i,
    "errors.storage_full",
  ],
  [
    /^(User cancelled|Transfer cancelled|.*operation was aborted)$/i,
    "errors.cancelled",
  ],
  [
    /^TURN credentials request failed:/i,
    "errors.ice_credentials",
  ],
  [
    /^parseTurnServer: invalid method/i,
    "errors.ice_config",
  ],
  [
    /^(request .*(?:timeout|timed out)|timeout|send-timeout)$/i,
    "errors.request_timeout",
  ],
];

/** Translate at the presentation boundary. Keep diagnostic errors intact in services/history. */
export function userErrorMessage(
  error: unknown,
  fallback: ErrorKey = "errors.unexpected",
): string {
  if (error instanceof LocalFileSystemError) {
    const stage = writeStages[error.operation];
    if (stage)
      return t("storage.write_failed", {
        fileName:
          error.path.split("/").at(-1) ?? error.path,
        stage: t(`storage.stage_${stage}`),
      });
  }
  if (error instanceof DirectoryWriteError) {
    if (
      error.stage === "create" &&
      /Name is not allowed/i.test(error.detail ?? "")
    )
      return t("storage.name_blocked", {
        fileName: error.fileName,
      });
    if (
      error.stage === "commit" &&
      /Blocked by Safe Browsing|Aborted due to security policy/i.test(
        error.detail ?? "",
      )
    )
      return t("storage.write_blocked", {
        fileName: error.fileName,
      });
    return t("storage.write_failed", {
      fileName: error.fileName,
      stage: t(`storage.stage_${error.stage}`),
    });
  }
  const value =
    typeof error === "object" && error !== null
      ? (error as {
          name?: string;
          code?: string;
          message?: unknown;
          cause?: unknown;
        })
      : undefined;
  if (
    value?.code === "prepare-failed" &&
    value.cause !== undefined &&
    value.cause !== error
  )
    return userErrorMessage(value.cause, fallback);
  const message = (
    typeof error === "string"
      ? error
      : typeof value?.message === "string"
        ? value.message
        : ""
  )
    .replace(/^\[[\w.]+\]\s*/, "")
    .trim();
  if (value?.name === "AbortError")
    return t("errors.cancelled");
  if (value?.name === "QuotaExceededError")
    return t("errors.storage_full");
  if (value?.name === "DataCloneError")
    return t("errors.storage_unavailable");
  if (
    value?.name === "NotAllowedError" ||
    value?.name === "SecurityError"
  )
    return t("errors.permission_denied");
  const line =
    /^(config error|auth method error), line (\d+)\b/.exec(
      message,
    );
  if (line)
    return t(
      line[1] === "config error"
        ? "errors.ice_config_line"
        : "errors.ice_auth_line",
      { line: line[2] },
    );
  const known = messages.find(([pattern]) =>
    pattern.test(message),
  );
  if (known) return t(known[1]);
  switch (value?.code) {
    case "peer-connection-config":
      return t("errors.peer_connection_config");
    case "timeout":
    case "send-timeout":
      return t("errors.request_timeout");
    case "closed":
      return t("errors.connection_closed");
    case "aborted":
      return t("errors.cancelled");
    case "invalid-message":
      return t("errors.connection_response");
    case "unsupported-protocol":
      return t("errors.unsupported_protocol");
  }
  // Never expose unknown server messages, internal class names, IDs or stack traces.
  return t(fallback);
}
