import {
  tools,
  type ToolCall,
  type ToolResult,
} from "./index";
interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: object;
    annotations: {
      readOnlyHint: boolean;
      untrustedContentHint: boolean;
      consequentialHint: boolean;
    };
    execute(
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<ToolResult>;
  }): void;
  unregisterTool(name: string): void;
}
export function webMcpContext(
  document: Document,
): ModelContext | undefined {
  return (
    document as Document & { modelContext?: ModelContext }
  ).modelContext;
}
/** Draft 2026-10-16 API isolated here; no guessed Agent identity or cross-origin exposure. */
export function registerWebMcp(
  context: ModelContext,
  invoke: (
    call: ToolCall,
    signal?: AbortSignal,
  ) => Promise<ToolResult>,
  available: (name: string) => boolean = () => true,
): () => void {
  const registered: string[] = [];
  try {
    for (const tool of tools.filter((t) =>
      available(t.name),
    )) {
      context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          untrustedContentHint: true,
          consequentialHint: !tool.readOnly,
        },
        execute: (args, options) =>
          invoke(
            { name: tool.name, arguments: args },
            options?.signal,
          ),
      });
      registered.push(tool.name);
    }
  } catch (error) {
    for (const name of registered)
      context.unregisterTool(name);
    throw error;
  }
  return () => {
    for (const name of registered)
      context.unregisterTool(name);
  };
}
