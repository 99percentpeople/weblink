import { AutomationError } from "@weblink/automation";
import type { NativeMcpTokenUsedEvent } from "@weblink/platform";

export const MCP_STORAGE_KEY = "mcp_registry";
type Invoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;
interface Registry extends Record<string, unknown> {
  clients: Record<
    string,
    Record<string, unknown> & { lastUsedAt?: number | null }
  >;
}
interface Opened {
  epoch: string;
  registry: Registry;
}
interface Prepared<T> {
  revision: number;
  registry: Registry;
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
  let savedRegistry: Registry | undefined;
  const usage = new Map<string, number>();
  let usageDirty = false;
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
  const save = (candidate: Registry): Registry => {
    // A prepared edit may predate a token-used event. Merge metadata only;
    // never restore clients or configuration from an older registry.
    const registry: Registry = {
      ...candidate,
      clients: Object.fromEntries(
        Object.entries(candidate.clients).map(
          ([id, client]) => {
            const at = usage.get(id);
            return [
              id,
              at !== undefined &&
              at > (client.lastUsedAt ?? 0)
                ? { ...client, lastUsedAt: at }
                : client,
            ];
          },
        ),
      ),
    };
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
    savedRegistry = registry;
    usageDirty = false;
    for (const id of usage.keys())
      if (!Object.hasOwn(registry.clients, id))
        usage.delete(id);
    return registry;
  };
  const recordUsage = (id: string, at: number | null) => {
    const client = savedRegistry?.clients[id];
    if (
      !client ||
      at === null ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > 253402300799999 ||
      at <=
        Math.max(usage.get(id) ?? 0, client.lastUsedAt ?? 0)
    )
      return;
    usage.set(id, at);
    usageDirty = true;
  };
  const flushUsage = () => {
    if (!usageDirty || !savedRegistry) return;
    try {
      save(savedRegistry);
    } catch {
      // Usage metadata must not interrupt authenticated calls. Keep it dirty
      // and retry on the next notification, registry edit or explicit close.
    }
  };
  const close = (epoch: string) => {
    if (current === epoch) {
      flushUsage();
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
          usage.clear();
          usageDirty = false;
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
    used(event: NativeMcpTokenUsedEvent): boolean {
      if (
        !current ||
        event.epoch !== current ||
        !savedRegistry ||
        !Object.hasOwn(savedRegistry.clients, event.id)
      )
        return false;
      recordUsage(event.id, event.lastUsedAt);
      flushUsage();
      return true;
    },
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
        const registry = save(prepared.registry);
        try {
          await invoke<void>("automation_registry_apply", {
            epoch: args.epoch,
            revision: prepared.revision,
            registry,
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
