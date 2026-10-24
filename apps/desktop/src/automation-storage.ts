import { AutomationError } from "@weblink/automation";

export const MCP_STORAGE_KEY = "mcp_registry";
type Invoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;
interface Opened {
  epoch: string;
  registry: Record<string, unknown>;
}
interface Prepared<T> {
  revision: number;
  registry: Record<string, unknown>;
  result: T;
}

/** The current WebView profile owns persistence; native code owns validation. */
export function createAutomationStorage(
  invoke: Invoke,
  storage: () => Pick<
    Storage,
    "getItem" | "setItem"
  > = () => localStorage,
) {
  let current = "";
  let generation = 0;
  let queue = Promise.resolve();
  const serial = <T>(
    work: () => Promise<T>,
  ): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const check = (epoch: string) => {
    if (!epoch || current !== epoch)
      throw new AutomationError("SESSION_CLOSED");
  };
  const read = () => {
    let raw: string | null;
    try {
      raw = storage().getItem(MCP_STORAGE_KEY);
    } catch {
      throw new AutomationError(
        "AUTOMATION_STORAGE_UNAVAILABLE",
      );
    }
    if (raw === null) return null;
    try {
      if (raw.length > 512 * 1024) throw new Error();
      const value: unknown = JSON.parse(raw);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      )
        throw new Error();
      return value;
    } catch {
      throw new AutomationError(
        "INVALID_AUTOMATION_REGISTRY",
      );
    }
  };
  const save = (registry: Record<string, unknown>) => {
    try {
      storage().setItem(
        MCP_STORAGE_KEY,
        JSON.stringify(registry),
      );
    } catch {
      throw new AutomationError(
        "AUTOMATION_STORAGE_UNAVAILABLE",
      );
    }
  };
  const close = (epoch: string) => {
    if (current === epoch) {
      current = "";
      generation++;
    }
    return invoke<void>("automation_close", { epoch });
  };
  return {
    open(args: Record<string, unknown>): Promise<string> {
      const opening = ++generation;
      current = "";
      return serial(async () => {
        if (opening !== generation)
          throw new AutomationError("SESSION_CLOSED");
        const opened = await invoke<Opened>(
          "automation_open",
          {
            ...args,
            registry: read(),
          },
        );
        try {
          if (opening !== generation)
            throw new AutomationError("SESSION_CLOSED");
          save(opened.registry);
          current = opened.epoch;
          return current;
        } catch (error) {
          await close(opened.epoch).catch(() => {});
          throw error;
        }
      });
    },
    close,
    change<T>(
      command: string,
      args: Record<string, unknown> & { epoch: string },
    ): Promise<T> {
      return serial(async () => {
        check(args.epoch);
        const prepared = await invoke<Prepared<T>>(
          command,
          args,
        );
        check(args.epoch);
        // Persist the hashes/configuration before native credentials become active.
        // A failed write leaves both the stored and active registry unchanged.
        save(prepared.registry);
        try {
          await invoke<void>("automation_registry_apply", {
            epoch: args.epoch,
            revision: prepared.revision,
            registry: prepared.registry,
          });
        } catch (error) {
          // The saved state is authoritative on the next open. Do not roll it
          // back (which could restore a revoked token) after an uncertain IPC.
          await close(args.epoch).catch(() => {});
          throw error;
        }
        check(args.epoch);
        return prepared.result;
      });
    },
  };
}
