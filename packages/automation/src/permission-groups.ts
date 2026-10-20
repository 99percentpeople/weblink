import catalog from "./permission-groups.json";
import type {
  AutomationDecision,
  AutomationPolicy,
  Scope,
} from "./index";

export type PermissionGroup = keyof typeof catalog;
export const permissionGroups = catalog as Record<
  PermissionGroup,
  readonly Scope[]
>;
export const permissionGroupIds = Object.keys(
  permissionGroups,
) as PermissionGroup[];

export function permissionGroup(
  scope: Scope,
): PermissionGroup {
  const group = permissionGroupIds.find((id) =>
    permissionGroups[id].includes(scope),
  );
  if (!group)
    throw new Error(`Unknown permission scope: ${scope}`);
  return group;
}

export const permissionScopes = (
  scope: Scope,
): readonly Scope[] =>
  permissionGroups[permissionGroup(scope)];

/** Null preserves a legacy mixed policy until the user explicitly replaces it. */
export function groupDecision(
  policy: AutomationPolicy | undefined,
  group: PermissionGroup,
): AutomationDecision | null {
  const decisions = permissionGroups[group].map(
    (scope) => policy?.[scope] ?? "ask",
  );
  return decisions.every((value) => value === decisions[0])
    ? decisions[0]
    : null;
}

export function setGroupDecision(
  policy: AutomationPolicy | undefined,
  group: PermissionGroup,
  decision: AutomationDecision,
): AutomationPolicy {
  return {
    ...policy,
    ...Object.fromEntries(
      permissionGroups[group].map((scope) => [
        scope,
        decision,
      ]),
    ),
  };
}
