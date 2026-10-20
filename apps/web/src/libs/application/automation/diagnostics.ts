import {
  videoStatsValue,
  type VideoStatsBatch,
  type VideoStatsSample,
} from "@/libs/domain/video-stats";
export interface DiagnosticSample {
  sequence: number;
  at: number;
  gapMs: number;
  streams: Record<string, unknown>[];
  errors: string[];
}
/** One application-owned sampler. It deliberately never serializes RTCStatsReport or SDP. */
export class AutomationDiagnostics {
  private history: DiagnosticSample[] = [];
  private previous = new Map<string, VideoStatsSample>();
  private keys = new WeakMap<object, number>();
  private nextKey = 0;
  private sequence = 0;
  private lastAt = 0;
  private bytes = 0;
  private sizes: number[] = [];
  private detailUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly sources: () => {
      id: string;
      read(): Promise<VideoStatsBatch[]>;
      state(
        detailed: boolean,
      ):
        | Record<string, unknown>
        | Promise<Record<string, unknown>>;
    }[],
    private readonly now = Date.now,
  ) {}
  start(): void {
    if (!this.timer && !this.closed) void this.poll();
  }
  async sample(): Promise<void> {
    const sources = this.sources();
    if (!sources.length) {
      this.prune();
      this.previous.clear();
      this.lastAt = 0;
      return;
    }
    const at = this.now();
    const detail = at < this.detailUntil;
    const used = new Set<string>();
    const errors: string[] = [];
    const streams = (
      await Promise.all(
        sources.slice(0, 32).map(async (source) => {
          try {
            const batches = await source.read();
            const state = await source.state(detail);
            if (!batches.length)
              return [
                {
                  trackId: source.id,
                  unavailable: true,
                  ...state,
                },
              ];
            return batches.flatMap((batch) =>
              batch.samples.slice(0, 32).map((sample) => {
                let transport = batch.key;
                if (typeof transport === "object") {
                  if (!this.keys.has(transport))
                    this.keys.set(
                      transport,
                      ++this.nextKey,
                    );
                  transport = String(
                    this.keys.get(transport),
                  );
                }
                const key = `${source.id}/${transport}/${batch.direction}/${sample.id}`;
                used.add(key);
                const value = videoStatsValue(
                  sample,
                  this.previous.get(key),
                );
                this.previous.set(key, sample);
                // Samples are typed domain counters, never arbitrary browser reports.
                const counters = Object.fromEntries(
                  Object.entries(sample).filter(
                    ([, v]) =>
                      typeof v === "number" &&
                      Number.isFinite(v),
                  ),
                );
                return {
                  trackId: source.id,
                  transportId: String(transport),
                  direction: batch.direction,
                  preview: !!batch.preview,
                  ...state,
                  ...value,
                  ...(detail ? { counters } : {}),
                };
              }),
            );
          } catch {
            errors.push(`STATS_UNAVAILABLE:${source.id}`);
            return [];
          }
        }),
      )
    ).flat();
    if (this.closed) return;
    for (const key of this.previous.keys())
      if (!used.has(key)) this.previous.delete(key);
    const sample: DiagnosticSample = {
      sequence: ++this.sequence,
      at,
      gapMs: this.lastAt
        ? Math.max(0, at - this.lastAt - 1000)
        : 0,
      streams,
      errors,
    };
    this.lastAt = at;
    const size = JSON.stringify(sample).length * 2;
    this.history.push(sample);
    this.sizes.push(size);
    this.bytes += size;
    this.prune();
  }
  private prune(): void {
    while (
      this.history.length &&
      (this.history[0].at < this.now() - 300000 ||
        this.bytes > 8 * 1024 * 1024)
    ) {
      this.history.shift();
      this.bytes -= this.sizes.shift()!;
    }
  }
  private async poll(): Promise<void> {
    try {
      await this.sample();
    } finally {
      if (!this.closed)
        this.timer = setTimeout(
          () => void this.poll(),
          1000,
        );
    }
  }
  snapshot(): Record<string, unknown> {
    this.prune();
    const latest = this.history.at(-1);
    return {
      latest: latest ?? null,
      stale: !latest || this.now() - latest.at > 3000,
      detailUntil: this.detailUntil,
      sampledAt: this.now(),
    };
  }
  read(after = 0): Record<string, unknown> {
    this.prune();
    const samples: DiagnosticSample[] = [];
    let bytes = 0;
    for (const sample of this.history) {
      if (sample.sequence <= after) continue;
      const size = JSON.stringify(sample).length;
      if (
        samples.length &&
        (samples.length >= 30 || bytes + size > 1024 * 1024)
      )
        break;
      samples.push(sample);
      bytes += size;
    }
    return {
      samples,
      nextCursor: samples.at(-1)?.sequence ?? after,
      lost:
        !!after &&
        !!this.history.length &&
        after < this.history[0].sequence - 1,
      hasMore:
        (samples.at(-1)?.sequence ?? after) <
        (this.history.at(-1)?.sequence ?? 0),
    };
  }
  detail(duration = 300000): Record<string, unknown> {
    this.detailUntil = duration
      ? this.now() + Math.min(duration, 300000)
      : 0;
    return { detailUntil: this.detailUntil };
  }
  dispose(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.previous.clear();
  }
}
