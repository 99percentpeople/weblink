import catalog from "./catalog.json";
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
  type: string;
  oneOf?: Schema[];
  items?: Schema;
  uniqueItems?: boolean;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export const tools = catalog as unknown as ToolDefinition[];
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
  | { ok: false; error: { code: string; message: string } };
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
export function failure(error: unknown): ToolResult {
  return {
    ok: false,
    error: {
      code:
        error instanceof AutomationError
          ? error.code
          : "EXECUTION_FAILED",
      message:
        error instanceof Error
          ? error.message
          : String(error),
    },
  };
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
  if (schema.enum && !schema.enum.includes(value))
    return false;
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
        (schema.required ?? []).every((k) =>
          Object.hasOwn(obj, k),
        ) &&
        Object.entries(obj).every(([k, v]) =>
          schema.properties?.[k]
            ? validate(schema.properties[k], v)
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
    throw new AutomationError("INVALID_ARGUMENTS");
  const tool = tools.find((t) => t.name === call.name);
  if (!tool)
    throw new AutomationError(
      "UNSUPPORTED",
      "Unknown tool",
    );
  if (!validate(tool.inputSchema, call.arguments))
    throw new AutomationError("INVALID_ARGUMENTS");
  return tool;
}
export interface Principal {
  id: string;
  label: string;
  kind: "webmcp" | "mcp" | "peer";
  fingerprint?: string;
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
