import { AutomationError } from "@weblink/automation";
import { combineAbortSignals } from "@/libs/utils/abort-signals";
import type {
  ScreenSharing,
  SharedScreen,
} from "../screen-sharing";

export interface AutomationScreenAuthority {
  grantId: string;
  /** Screen and input scopes may have been approved separately. */
  screenGrantIds: readonly string[];
}

interface Owner {
  abort: AbortController;
  screens: Map<
    string,
    { shared: SharedScreen; lease?: string }
  >;
}

/** Native permission IDs fence cleanup across callers, reconnects and reapproval. */
export class AutomationScreenShares {
  private readonly owners = new Map<string, Owner>();
  constructor(private readonly sharing: ScreenSharing) {}

  async start(
    id: string | undefined,
    source: string,
    signal: AbortSignal,
    capture: (signal: AbortSignal) => Promise<MediaStream>,
    check: () => Promise<void>,
  ): Promise<SharedScreen> {
    if (!id) throw new AutomationError("PERMISSION_DENIED");
    let owner = this.owners.get(id);
    if (!owner) {
      owner = {
        abort: new AbortController(),
        screens: new Map(),
      };
      this.owners.set(id, owner);
    }
    const lifetime = combineAbortSignals([
      signal,
      owner.abort.signal,
    ]);
    try {
      const shared = await this.sharing.start(
        source,
        lifetime.signal,
        () => capture(lifetime.signal),
        check,
        true,
      );
      if (lifetime.signal.aborted) {
        shared.release();
        lifetime.signal.throwIfAborted();
      }
      const previous = owner.screens.get(shared.trackId);
      if (previous) shared.release();
      else {
        const entry = { shared };
        owner.screens.set(shared.trackId, entry);
        const current = owner;
        // Cancellation after publication but before the tool reply must not
        // leak a share, or cancel an earlier successful start of the same track.
        signal.addEventListener(
          "abort",
          () => {
            if (
              current.screens.get(shared.trackId) !== entry
            )
              return;
            current.screens.delete(shared.trackId);
            shared.release();
          },
          { once: true },
        );
      }
      return shared;
    } finally {
      lifetime.dispose();
    }
  }

  acquired(
    id: string | undefined,
    track: string,
    lease: string,
  ) {
    const owner = id && this.owners.get(id);
    if (!owner) return;
    for (const [key, entry] of owner.screens) {
      if (key === track) entry.lease = lease;
      else if (entry.lease && entry.lease !== lease) {
        owner.screens.delete(key);
        entry.shared.release();
      }
    }
  }

  failedAcquire(id: string | undefined, track: string) {
    const owner = id && this.owners.get(id);
    const entry = owner && owner.screens.get(track);
    if (owner && entry && !entry.lease) {
      owner.screens.delete(track);
      entry.shared.release();
    }
  }

  stop(ids: readonly string[], track: string) {
    let shared: SharedScreen | undefined;
    for (const id of ids) {
      const owner = this.owners.get(id);
      const entry = owner?.screens.get(track);
      if (!owner || !entry) continue;
      shared = entry.shared;
      owner.screens.delete(track);
      shared.release();
    }
    if (!shared)
      throw new AutomationError("PERMISSION_DENIED");
    const stopped = shared.stream
      .getVideoTracks()
      .every((t) => t.readyState !== "live");
    return { stopped, released: true, retained: !stopped };
  }

  release(id: string | undefined) {
    if (!id) return;
    const owner = this.owners.get(id);
    if (!owner) return;
    this.owners.delete(id);
    owner.abort.abort();
    for (const { shared } of owner.screens.values())
      shared.release();
  }

  synchronize(
    grants: readonly string[],
    lease: string | null,
  ) {
    for (const [id, owner] of this.owners) {
      if (!grants.includes(id)) this.release(id);
      else
        for (const [track, entry] of owner.screens) {
          if (entry.lease && entry.lease !== lease) {
            owner.screens.delete(track);
            entry.shared.release();
          }
        }
    }
  }

  dispose() {
    for (const id of this.owners.keys()) this.release(id);
  }
}
