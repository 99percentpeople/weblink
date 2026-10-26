import catalog from "./catalog.json";
import {
  failureDetails,
  type RecoveryContext,
  type ToolError,
} from "./errors";
export * from "./errors";
export * from "./permission-groups";
export type * from "./coordinates";
export type * from "./keyboard";
export type * from "./control";
export type Scope =
  | "diagnostics.read"
  | "screen.read"
  | "screen.manage"
  | "screen.configure"
  | "accessibility.read"
  | "input.control"
  | "shell.execute";
export type AutomationDecision = "ask" | "allow" | "deny";
export type AutomationPolicy = Partial<
  Record<Scope, AutomationDecision>
>;
/** Ignore unknown scopes and malformed persisted decisions. Missing scopes ask. */
export function readAutomationPolicy(
  value: unknown,
): AutomationPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return {};
  const entries = value as Record<string, unknown>;
  return Object.fromEntries(
    scopes.flatMap((scope) =>
      ["ask", "allow", "deny"].includes(
        String(entries[scope]),
      ) && typeof entries[scope] === "string"
        ? [[scope, entries[scope]]]
        : [],
    ),
  );
}
export interface ToolDefinition {
  name: string;
  description: string;
  scope: Scope;
  native: boolean;
  readOnly: boolean;
  inputSchema: Schema;
  outputSchema: Schema;
}
export interface Schema {
  type?: string | string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  items?: Schema;
  uniqueItems?: boolean;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  description?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export const tools = catalog as unknown as ToolDefinition[];
/** Diagnostics stay available independently of OS automation. */
export const isDiagnosticTool = (name: string): boolean =>
  [
    "diagnostics.snapshot",
    "diagnostics.history",
    "diagnostics.export",
    "diagnostics.start",
    "diagnostics.stop",
  ].includes(name);
export const scopes: readonly Scope[] = [
  "diagnostics.read",
  "screen.read",
  "screen.manage",
  "screen.configure",
  "accessibility.read",
  "input.control",
  "shell.execute",
];
export interface ToolCall {
  source?: { kind: "mcp" | "webmcp"; label: string };
  name: string;
  arguments: Record<string, unknown>;
}
export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ToolError };
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly recovery: RecoveryContext = {},
  ) {
    super(message);
  }
}
export function failure(
  error: unknown,
  context: RecoveryContext = {},
): ToolResult {
  return {
    ok: false,
    error: failureDetails(
      error instanceof AutomationError
        ? error.code
        : "EXECUTION_FAILED",
      error instanceof Error
        ? error.message
        : String(error),
      {
        ...(error instanceof AutomationError
          ? error.recovery
          : {}),
        ...context,
      },
    ),
  };
}
/** Enrich legacy peer errors without treating a lost mutation result as safe to retry. */
export function withRecovery(
  result: ToolResult,
  context: RecoveryContext = {},
): ToolResult {
  // Peer JSON is untrusted even when its TypeScript envelope is declared.
  // Reject malformed envelopes before a pending transport call loses its resolver.
  if (
    !result ||
    typeof result !== "object" ||
    (result.ok !== true && result.ok !== false) ||
    (result.ok
      ? !result.data ||
        typeof result.data !== "object" ||
        Array.isArray(result.data)
      : !result.error ||
        typeof result.error !== "object" ||
        Array.isArray(result.error) ||
        typeof result.error.code !== "string" ||
        typeof result.error.message !== "string")
  )
    return {
      ok: false,
      error: failureDetails(
        "INVALID_RESULT",
        "The target returned an invalid automation result.",
        context,
      ),
    };
  if (result.ok) return result;
  const details = failureDetails(
    result.error.code,
    result.error.message,
    {
      ...context,
      outcome: result.error.outcome ?? context.outcome,
    },
  );
  const error = {
    ...result.error,
    ...details,
    ...(result.error.retryable === false &&
    !context.readOnly
      ? { retryable: false }
      : {}),
  };
  if (
    !error.retryable ||
    details.retryAfterMs === undefined
  )
    delete error.retryAfterMs;
  if (!error.retryable) {
    if (error.nextAction === "retry")
      error.nextAction = "observe";
  }
  return { ok: false, error };
}
export function validate(
  schema: Schema,
  value: unknown,
): boolean {
  if (
    schema.oneOf &&
    schema.oneOf.filter((branch) => validate(branch, value))
      .length !== 1
  )
    return false;
  if (
    schema.anyOf &&
    !schema.anyOf.some((branch) => validate(branch, value))
  )
    return false;
  if (schema.enum && !schema.enum.includes(value))
    return false;
  if (Array.isArray(schema.type))
    return schema.type.some((type) =>
      validate({ ...schema, type }, value),
    );
  switch (schema.type) {
    case "object": {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      )
        return false;
      const obj = value as Record<string, unknown>;
      return (
        Object.keys(obj).length >=
          (schema.minProperties ?? 0) &&
        Object.keys(obj).length <=
          (schema.maxProperties ?? Infinity) &&
        (schema.required ?? []).every((k) =>
          Object.hasOwn(obj, k),
        ) &&
        Object.entries(obj).every(([k, v]) =>
          schema.properties &&
          Object.hasOwn(schema.properties, k)
            ? validate(schema.properties[k], v)
            : typeof schema.additionalProperties ===
                "object"
              ? validate(schema.additionalProperties, v)
              : schema.additionalProperties !== false,
        )
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? Infinity) &&
        (!schema.uniqueItems ||
          new Set(value).size === value.length) &&
        !!schema.items &&
        value.every((item) => validate(schema.items!, item))
      );
    case "string":
      return (
        typeof value === "string" &&
        [...value].length >= (schema.minLength ?? 0) &&
        [...value].length <= (schema.maxLength ?? Infinity)
      );
    case "integer":
      if (!Number.isSafeInteger(value)) return false;
    // fall through
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case undefined:
      return true;
    default:
      return false;
  }
}
export function parseCall(call: ToolCall): ToolDefinition {
  if (
    call.source &&
    (!["mcp", "webmcp"].includes(call.source.kind) ||
      typeof call.source.label !== "string" ||
      call.source.label.length > 128)
  )
    throw new AutomationError(
      "INVALID_ARGUMENTS",
      undefined,
      { dispatched: false },
    );
  const tool = tools.find((t) => t.name === call.name);
  if (!tool)
    throw new AutomationError(
      "UNSUPPORTED",
      "Unknown tool",
      { dispatched: false },
    );
  if (!validate(tool.inputSchema, call.arguments))
    throw new AutomationError(
      "INVALID_ARGUMENTS",
      undefined,
      { dispatched: false },
    );
  return tool;
}
export interface Principal {
  id: string;
  label: string;
  kind: "webmcp" | "mcp" | "peer";
  generation?: string;
}
export interface Grant {
  target: string;
  id: string;
  principal: Principal;
  scopes: Scope[];
  expiresAt: number | null;
}
export interface Approval {
  source?: ToolCall["source"];
  id: string;
  principal: Principal;
  scope: Scope;
  tool: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}
export interface Audit {
  id: string;
  at: number;
  principal: string;
  tool: string;
  target: string;
  status: string;
}
