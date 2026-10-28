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
  /** Required when control acquisition also prepares capture. */
  screenGrantId?: string;
  /** Verified native principal, never read from tool arguments. */
  requesterId?: string;
}

interface ScreenUse {
  shared: SharedScreen;
  established?: boolean;
}
interface ScreenEntry {
  screen?: ScreenUse;
  control?: ScreenUse;
}
interface Owner {
  abort: AbortController;
  screens: Map<string, ScreenEntry>;
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
    purpose: "screen" | "control" = "screen",
    requesterId?: string,
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
        requesterId,
      );
      if (lifetime.signal.aborted) {
        shared.release();
        lifetime.signal.throwIfAborted();
      }
      let entry = owner.screens.get(shared.trackId);
      if (!entry) {
        entry = {};
        owner.screens.set(shared.trackId, entry);
      }
      const previous = entry[purpose];
      if (previous) shared.release();
      else {
        const use: ScreenUse = { shared };
        entry[purpose] = use;
        const current = owner;
        // Cancellation after publication but before the tool reply must not
        // leak a share, or cancel an earlier successful start of the same track.
        signal.addEventListener(
          "abort",
          () => {
            if (
              use.established ||
              current.screens.get(shared.trackId)?.[
                purpose
              ] !== use
            )
              return;
            this.removeUse(
              current,
              shared.trackId,
              purpose,
            );
          },
          { once: true },
        );
      }
      return shared;
    } finally {
      lifetime.dispose();
    }
  }

  retain(id: string | undefined, track: string) {
    const owner = id && this.owners.get(id);
    if (!owner) return;
    const entry = owner.screens.get(track);
    for (const use of [entry?.screen, entry?.control]) {
      if (!use) continue;
      const video = use.shared.stream.getVideoTracks()[0];
      this.sharing.retain(video);
      use.established = true;
    }
  }

  failedAcquire(id: string | undefined, track: string) {
    const owner = id && this.owners.get(id);
    const entry = owner
      ? owner.screens.get(track)
      : undefined;
    if (
      owner &&
      entry?.control &&
      !entry.control.established
    )
      this.removeUse(owner, track, "control");
  }

  stop(ids: readonly string[], track: string) {
    let shared: SharedScreen | undefined;
    for (const id of ids) {
      const owner = this.owners.get(id);
      const entry = owner?.screens.get(track);
      if (!owner || !entry) continue;
      shared = (entry.screen ?? entry.control)?.shared;
    }
    if (!shared || !shared.createdByCaller)
      throw new AutomationError("PERMISSION_DENIED");
    if (!shared.close())
      throw new AutomationError("CONTROL_BUSY");
    for (const owner of this.owners.values()) {
      this.removeUse(owner, track, "screen");
      this.removeUse(owner, track, "control");
    }
    const stopped = shared.stream
      .getVideoTracks()
      .every((t) => t.readyState !== "live");
    return { stopped, released: true, retained: !stopped };
  }

  private removeUse(
    owner: Owner,
    track: string,
    purpose: keyof ScreenEntry,
  ) {
    const entry = owner.screens.get(track);
    const use = entry?.[purpose];
    if (!entry || !use) return;
    delete entry[purpose];
    if (!entry.screen && !entry.control)
      owner.screens.delete(track);
    use.shared.release();
  }

  release(id: string | undefined) {
    if (!id) return;
    const owner = this.owners.get(id);
    if (!owner) return;
    this.owners.delete(id);
    owner.abort.abort();
    for (const entry of owner.screens.values()) {
      entry.screen?.shared.release();
      entry.control?.shared.release();
    }
  }

  synchronize(grants: readonly string[]) {
    for (const id of this.owners.keys()) {
      if (!grants.includes(id)) this.release(id);
    }
  }

  dispose() {
    for (const id of this.owners.keys()) this.release(id);
  }
}
