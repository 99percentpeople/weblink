import rules from "./error-codes.json";

export type OperationOutcome =
  | "not_applied"
  | "applied"
  | "unknown";
export type RecoveryAction =
  | "fix_arguments"
  | "inspect_capabilities"
  | "enable_automation"
  | "request_permission"
  | "wait_for_approval"
  | "retry"
  | "reconnect"
  | "observe"
  | "stop"
  | "acquire_control"
  | "start_capture"
  | "reduce_result"
  | "inspect_job";

/** Recovery fields are optional when accepting results from older peers. */
export interface ToolError {
  code: string;
  message: string;
  retryable?: boolean;
  outcome?: OperationOutcome;
  nextAction?: RecoveryAction;
  retryAfterMs?: number;
}
export interface RecoveryContext {
  readOnly?: boolean;
  /** False only when the caller knows execution has not been dispatched. */
  dispatched?: boolean;
  outcome?: OperationOutcome;
  /** Preserve a destination's explicit no-retry decision for mutations. */
  retryable?: boolean;
}
interface Rule {
  message: string;
  nextAction: RecoveryAction;
  transient?: boolean;
  retryAfterMs?: number;
}
const policies = rules as Record<string, Rule>;

/** A timeout, revocation or lost response never proves that a mutation did not run. */
export function failureDetails(
  code: string,
  message = code,
  context: RecoveryContext = {},
): ToolError {
  const known = Object.hasOwn(policies, code)
    ? policies[code]
    : undefined;
  const rule = known ?? policies.EXECUTION_FAILED;
  const reported = context.outcome;
  const outcome =
    context.readOnly || context.dispatched === false
      ? "not_applied"
      : reported === "not_applied" ||
          reported === "applied" ||
          reported === "unknown"
        ? reported
        : "unknown";
  const retryable =
    outcome === "not_applied" &&
    rule.transient === true &&
    (context.readOnly === true ||
      context.retryable !== false);
  return {
    code,
    message:
      message === code && known ? rule.message : message,
    retryable,
    outcome,
    nextAction:
      rule.nextAction === "retry" && !retryable
        ? "observe"
        : rule.nextAction,
    ...(retryable && rule.retryAfterMs !== undefined
      ? { retryAfterMs: rule.retryAfterMs }
      : {}),
  };
}
