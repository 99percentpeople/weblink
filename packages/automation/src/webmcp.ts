import {
  tools,
  type ToolCall,
  type ToolResult,
} from "./index";
interface ModelContext {
  registerTool(
    tool: {
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
    },
    options: { signal: AbortSignal },
  ): Promise<void>;
}
export function webMcpContext(
  document: Document,
): ModelContext | undefined {
  const context = (
    document as Document & { modelContext?: ModelContext }
  ).modelContext;
  return typeof context?.registerTool === "function"
    ? context
    : undefined;
}
/** Registration is asynchronous; aborting its signal unregisters the tools. */
export async function registerWebMcp(
  context: ModelContext,
  invoke: (
    call: ToolCall,
    signal?: AbortSignal,
  ) => Promise<ToolResult>,
  available: (name: string) => boolean = () => true,
  signal?: AbortSignal,
): Promise<() => void> {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal?.reason);
  const close = () => {
    signal?.removeEventListener("abort", abort);
    lifetime.abort();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (const tool of tools.filter((t) =>
      available(t.name),
    )) {
      lifetime.signal.throwIfAborted();
      await context.registerTool(
        {
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
        },
        { signal: lifetime.signal },
      );
    }
    lifetime.signal.throwIfAborted();
  } catch (error) {
    close();
    throw error;
  }
  return close;
}
