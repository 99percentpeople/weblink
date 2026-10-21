import {
  permissionGroup,
  type PermissionGroup,
  type Scope,
} from "@weblink/automation";
import { t } from "@/i18n";

export const groupLabel = (group: PermissionGroup) =>
  t(`automation.permissions.${group}.title`);
export const groupDescription = (group: PermissionGroup) =>
  t(`automation.permissions.${group}.description`);
export const scopeLabel = (scope: Scope) =>
  groupLabel(permissionGroup(scope));

const jobStatusKeys = {
  running: "automation.job_status.running",
  completed: "automation.job_status.completed",
  cancelled: "automation.job_status.cancelled",
  timed_out: "automation.job_status.timed_out",
} as const;

export function jobStatusLabel(status: string): string {
  return Object.hasOwn(jobStatusKeys, status)
    ? t(jobStatusKeys[status as keyof typeof jobStatusKeys])
    : status;
}

export function callStatusLabel(status: string): string {
  if (status === "ok")
    return t("automation.call_status.ok");
  if (status === "error")
    return t("automation.call_status.error");
  // Keep the protocol error code available for diagnosis.
  return t("automation.call_status.error_code", {
    code: status,
  });
}
