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
