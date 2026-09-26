import { describe, expect, it, vi } from "vitest";
import en from "@/assets/i18n/en-us.json";
import cn from "@/assets/i18n/zh-cn.json";
import tw from "@/assets/i18n/zh-tw.json";
import { userErrorMessage } from "@/libs/user-error";
import { P2PProtocolError } from "@/libs/domain/protocol/errors";

const language = vi.hoisted(() => ({ current: "zh-cn" }));
const dictionaries = {
  "en-us": en,
  "zh-cn": cn,
  "zh-tw": tw,
};
vi.mock("@/i18n", () => ({
  t: (key: string, args?: Record<string, string>) => {
    const dictionary =
      dictionaries[
        language.current as keyof typeof dictionaries
      ];
    const message = key
      .split(".")
      .reduce<unknown>(
        (value, segment) =>
          (value as Record<string, unknown>)?.[segment],
        dictionary,
      );
    return typeof message === "string"
      ? message.replace(
          /\{\{(\w+)\}\}/g,
          (_, name) => args?.[name] ?? "",
        )
      : key;
  },
}));

describe.each(Object.keys(dictionaries))(
  "user-facing errors in %s",
  (locale) => {
    it.each([
      [
        new Error("Room is already open in another tab"),
        "room_in_use",
      ],
      [
        new Error(
          "[WebSocketSignalingService] socket is not open",
        ),
        "connection_closed",
      ],
      [
        new Error(
          "[WebSocketClientService] connection timeout",
        ),
        "connection_timeout",
      ],
      [
        new Error(
          "[WebSocketClientService] socket connection error",
        ),
        "connection_failed",
      ],
      [
        new Error(
          "[WebSocketClientService] socket closed 1006 internal details",
        ),
        "connection_closed",
      ],
      [
        new Error(
          "[WebSocketClientService] incorrect password",
        ),
        "incorrect_password",
      ],
      [new Error("password required"), "password_required"],
      [
        new Error(
          "[WebSocketClientService] invalid join acknowledgement",
        ),
        "connection_response",
      ],
      [
        new P2PProtocolError(
          "timeout",
          "Request secret-id timed out",
        ),
        "request_timeout",
      ],
      [
        new P2PProtocolError(
          "remote-error",
          "Shared file access is disabled",
        ),
        "sharing_disabled",
      ],
      ["This file is no longer shared", "file_not_shared"],
      [
        "File content verification failed; request the file again",
        "verification_failed",
      ],
      [
        new DOMException(
          "Internal storage details",
          "QuotaExceededError",
        ),
        "storage_full",
      ],
      [
        new DOMException(
          "Error preparing Blob/File data to be stored in object store",
          "UnknownError",
        ),
        "storage_unavailable",
      ],
      [
        "UnknownError: Error preparing Blob/File data to be stored in object store",
        "storage_unavailable",
      ],
      [
        new Error("Member is not connected"),
        "member_offline",
      ],
    ] as const)("translates %s", (error, key) => {
      language.current = locale;
      expect(userErrorMessage(error)).toBe(
        dictionaries[locale as keyof typeof dictionaries]
          .errors[key],
      );
    });
    it("uses a localized fallback instead of arbitrary server text or identifiers", () => {
      language.current = locale;
      const error = new Error(
        "[WebSocketClientService] InternalServerFailure token=secret",
      );
      expect(
        userErrorMessage(error, "errors.connection_failed"),
      ).toBe(
        dictionaries[locale as keyof typeof dictionaries]
          .errors.connection_failed,
      );
      expect(error.message).toContain(
        "InternalServerFailure",
      );
    });
    it("keeps the actionable TURN line number without exposing input credentials", () => {
      language.current = locale;
      const result = userErrorMessage(
        "auth method error, line 4 given secret expected longterm or hmac",
      );
      expect(result).toContain("4");
      expect(result).not.toContain("secret");
      expect(result).not.toContain("{{line}}");
    });
  },
);

it("translates stored errors using the current language each time", () => {
  const error = new Error(
    "[WebSocketClientService] incorrect password",
  );
  language.current = "zh-cn";
  expect(userErrorMessage(error)).toBe(
    cn.errors.incorrect_password,
  );
  language.current = "en-us";
  expect(userErrorMessage(error)).toBe(
    en.errors.incorrect_password,
  );
});
