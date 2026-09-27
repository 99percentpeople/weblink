import { toast } from "solid-sonner";
import { t } from "@/i18n";

export function reportMeetingPipError(error: unknown) {
  console.warn("Unable to enter picture-in-picture", error);
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error
      ? error.name
      : "";
  toast.error(
    t(
      name === "NotAllowedError" || name === "SecurityError"
        ? "meeting.pip_permission_denied"
        : name === "NotSupportedError"
          ? "meeting.pip_not_supported"
          : "meeting.pip_failed",
    ),
  );
}
