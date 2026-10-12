import {
  validCapabilityUpdate,
  type CapabilityAnnouncement,
  type CapabilityOffers,
} from "./capabilities";

/** Bounds retained deletion versions as well as updates preceding discovery. */
const MAX_ENTRY_REVISIONS = 128;

/** Per-entry revisions preserve independent updates on an unordered transport. */
export class CapabilityState {
  private generation?: string;
  private baseline = -1;
  private minimumSnapshot = -1;
  private highestSeen = -1;
  private revisions = new Map<string, number>();
  private services: CapabilityOffers = {};

  get value(): CapabilityOffers | undefined {
    return this.baseline < 0 ? undefined : this.services;
  }

  apply(
    update: CapabilityAnnouncement,
  ): "changed" | "ignored" | "resync" {
    if (
      this.generation &&
      this.generation !== update.generation
    )
      return "ignored";
    this.generation = update.generation;
    const { revision } = update;
    this.highestSeen = Math.max(this.highestSeen, revision);
    if (revision < this.minimumSnapshot) return "ignored";
    if (
      update.kind === "snapshot" &&
      revision <= this.baseline
    )
      return "ignored";

    const next = { ...this.services };
    const revisions = new Map(this.revisions);
    const keys =
      update.kind === "snapshot"
        ? new Set([
            ...Object.keys(next),
            ...Object.keys(update.services),
          ])
        : Object.keys(update.services);
    for (const key of keys) {
      if (revision <= (revisions.get(key) ?? this.baseline))
        continue;
      const value = Object.hasOwn(update.services, key)
        ? update.services[key]
        : null;
      if (value === null || value === undefined)
        delete next[key];
      else next[key] = value;
      if (update.kind === "patch")
        revisions.set(key, revision);
    }
    if (update.kind === "snapshot") {
      for (const [key, seen] of revisions)
        if (seen <= revision) revisions.delete(key);
    }
    if (
      revisions.size > MAX_ENTRY_REVISIONS ||
      !validCapabilityUpdate({
        kind: "snapshot",
        generation: update.generation,
        revision,
        services: next,
      })
    ) {
      this.minimumSnapshot = this.highestSeen;
      this.baseline = -1;
      this.services = {};
      this.revisions.clear();
      return "resync";
    }
    const wasReady = this.baseline >= 0;
    const changed =
      JSON.stringify(next) !==
      JSON.stringify(this.services);
    this.services = next;
    this.revisions = revisions;
    if (update.kind === "snapshot")
      this.baseline = revision;
    return this.baseline >= 0 && (!wasReady || changed)
      ? "changed"
      : "ignored";
  }
}
