/** Per-viewer limits. Missing values follow the publisher; FPS may also follow the viewer's display. */
export interface VideoQualityPreference {
  height?: number;
  fps?: number;
  refreshRate?: number;
  bitrate?: number;
}
/** Persisted receive defaults exclude the transient display measurement. */
export type ReceiveVideoQuality = Omit<
  VideoQualityPreference,
  "refreshRate"
>;
export function resolveReceiveVideoQuality(
  value: unknown,
): ReceiveVideoQuality {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return {};
  const saved = value as Record<string, unknown>;
  const preference: ReceiveVideoQuality = {};
  for (const [key, max] of [
    ["height", 32768],
    ["fps", 1000],
    ["bitrate", 1_000_000_000],
  ] as const) {
    if (validNumber(saved[key], max))
      preference[key] = saved[key];
  }
  return preference;
}
export interface VideoQualityLimits {
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  maxBitrate: number;
}
export interface VideoQualitySource {
  id: string;
  locator: string;
  transport: string;
  limits: VideoQualityLimits;
}
export function resolveVideoQuality(
  limits: VideoQualityLimits,
  preference: VideoQualityPreference,
): VideoQualityLimits {
  const height = preference.height ?? limits.maxHeight;
  const width = preference.height
    ? Math.min(
        limits.maxWidth,
        Math.round((height * 16) / 9),
      )
    : limits.maxWidth;
  const scale = Math.min(
    1,
    width / limits.maxWidth,
    height / limits.maxHeight,
  );
  return {
    maxWidth: Math.max(
      2,
      Math.floor((limits.maxWidth * scale) / 2) * 2,
    ),
    maxHeight: Math.max(
      2,
      Math.floor((limits.maxHeight * scale) / 2) * 2,
    ),
    frameRate: Math.min(
      limits.frameRate,
      preference.fps ??
        preference.refreshRate ??
        limits.frameRate,
    ),
    maxBitrate: Math.min(
      limits.maxBitrate,
      preference.bitrate ?? limits.maxBitrate,
    ),
  };
}
export function isQualityLimits(
  value: unknown,
): value is VideoQualityLimits {
  if (!value || typeof value !== "object") return false;
  const v = value as VideoQualityLimits;
  return (
    validNumber(v.maxWidth, 32768) &&
    validNumber(v.maxHeight, 32768) &&
    validNumber(v.frameRate, 1000) &&
    validNumber(v.maxBitrate, 1_000_000_000)
  );
}
function validNumber(
  value: unknown,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= max
  );
}
export function isQualityPreference(
  value: unknown,
): value is VideoQualityPreference {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return false;
  return Object.entries(value).every(([key, value]) => {
    const max = {
      height: 32768,
      fps: 1000,
      refreshRate: 1000,
      bitrate: 1_000_000_000,
    }[key];
    return max !== undefined && validNumber(value, max);
  });
}

export class VideoQualityControl extends EventTarget {
  preference: VideoQualityPreference = {};
  applied?: VideoQualityLimits;
  pending = false;
  available = false;
  error = false;
  revision = 0;
  constructor(
    public source: VideoQualitySource,
    private readonly request: (
      control: VideoQualityControl,
    ) => void,
  ) {
    super();
  }
  set(preference: VideoQualityPreference): void {
    this.preference = { ...preference };
    this.error = false;
    this.request(this);
  }
  changed(): void {
    this.dispatchEvent(new Event("change"));
  }
}

type QualityMessage =
  | {
      type: "quality-sources";
      sources: VideoQualitySource[];
    }
  | {
      type: "quality-request";
      id: string;
      revision: number;
      transport: string;
      preference: VideoQualityPreference;
    }
  | {
      type: "quality-result";
      id: string;
      revision: number;
      applied?: VideoQualityLimits;
    };
function parse(data: unknown): QualityMessage | undefined {
  if (typeof data !== "string" || data.length > 16384)
    return;
  try {
    const v = JSON.parse(data);
    const id = (s: unknown) =>
      typeof s === "string" &&
      s.length > 0 &&
      s.length <= 256;
    if (
      v?.type === "quality-sources" &&
      Array.isArray(v.sources) &&
      v.sources.length <= 32 &&
      v.sources.every(
        (s: VideoQualitySource) =>
          s &&
          id(s.id) &&
          id(s.locator) &&
          typeof s.transport === "string" &&
          s.transport.length <= 256 &&
          isQualityLimits(s.limits),
      )
    )
      return v;
    if (
      !id(v?.id) ||
      !Number.isSafeInteger(v.revision) ||
      v.revision < 1
    )
      return;
    if (
      v.type === "quality-request" &&
      id(v.transport) &&
      isQualityPreference(v.preference)
    )
      return v;
    if (
      v.type === "quality-result" &&
      (v.applied === undefined ||
        isQualityLimits(v.applied))
    )
      return v;
  } catch {
    /* Unknown messages share the authenticated media channel. */
  }
}

/** Bound to the existing authenticated media channel; old peers simply ignore these additions. */
export class VideoQualityPeer extends EventTarget {
  private channel?: RTCDataChannel;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private signature = "";
  private readonly controls = new Map<
    string,
    VideoQualityControl
  >();
  private readonly timers = new Map<
    VideoQualityControl,
    ReturnType<typeof setTimeout>
  >();
  private readonly requests = new Map<string, number>();
  private readonly sentPreferences = new Map<
    string,
    {
      preference: VideoQualityPreference;
      source: string;
      applied: VideoQualityLimits;
    }
  >();
  senderBitrate(id: string): number | undefined {
    return this.sentPreferences.get(id)?.applied.maxBitrate;
  }
  private queue: Promise<void> = Promise.resolve();
  private refreshRate?: number;
  private preference: ReceiveVideoQuality = {};
  constructor(
    private readonly port: {
      sources(): VideoQualitySource[];
      apply(
        source: VideoQualitySource,
        preference: VideoQualityPreference,
      ): Promise<VideoQualityLimits>;
    },
  ) {
    super();
  }
  get(locator: string): VideoQualityControl | undefined {
    return [...this.controls.values()].find(
      (c) => c.source.locator === locator,
    );
  }
  receivers(): readonly VideoQualityControl[] {
    return [...this.controls.values()];
  }
  setPreference(preference: ReceiveVideoQuality): void {
    const next = resolveReceiveVideoQuality(preference);
    if (
      JSON.stringify(next) ===
      JSON.stringify(this.preference)
    )
      return;
    this.preference = next;
    for (const control of this.controls.values())
      control.set(next);
  }
  setRefreshRate(fps: number): void {
    if (this.refreshRate === fps) return;
    this.refreshRate = fps;
    for (const c of this.controls.values())
      if (!c.preference.fps) this.request(c);
  }
  bind(channel: RTCDataChannel): void {
    this.disconnect();
    this.channel = channel;
    const abort = (this.abort = new AbortController());
    const publish = () => {
      if (channel.readyState !== "open") return;
      const sources = this.port.sources();
      for (const id of this.sentPreferences.keys())
        if (!sources.some((s) => s.id === id))
          this.sentPreferences.delete(id);
      for (const source of sources) {
        const previous = this.sentPreferences.get(
          source.id,
        );
        const signature = JSON.stringify(source);
        if (
          !previous ||
          previous.source === signature ||
          !source.transport
        )
          continue;
        previous.source = signature;
        this.queue = this.queue
          .then(async () => {
            if (
              abort.signal.aborted ||
              this.sentPreferences.get(source.id) !==
                previous ||
              !this.port
                .sources()
                .some(
                  (s) => JSON.stringify(s) === signature,
                )
            )
              return;
            previous.applied = await this.port.apply(
              source,
              previous.preference,
            );
          })
          .catch(() => {});
      }
      const signature = JSON.stringify(sources);
      if (signature === this.signature) return;
      this.signature = signature;
      this.send({ type: "quality-sources", sources });
    };
    channel.addEventListener(
      "message",
      ({ data }) => {
        const message = parse(data);
        if (!message) return;
        if (message.type === "quality-request") {
          if (
            !this.port
              .sources()
              .some(
                (s) =>
                  s.id === message.id &&
                  s.transport === message.transport,
              )
          ) {
            this.send({
              type: "quality-result",
              id: message.id,
              revision: message.revision,
            });
            return;
          }
          const previous =
            this.requests.get(message.id) ?? 0;
          if (message.revision <= previous) return;
          this.requests.set(message.id, message.revision);
          this.queue = this.queue
            .then(async () => {
              if (
                abort.signal.aborted ||
                this.requests.get(message.id) !==
                  message.revision
              )
                return;
              const source = this.port
                .sources()
                .find(
                  (s) =>
                    s.id === message.id &&
                    s.transport === message.transport,
                );
              let applied: VideoQualityLimits | undefined;
              if (source)
                try {
                  applied = await this.port.apply(
                    source,
                    message.preference,
                  );
                  if (!abort.signal.aborted)
                    this.sentPreferences.set(source.id, {
                      preference: message.preference,
                      source: JSON.stringify(source),
                      applied,
                    });
                } catch {
                  /* Keep the last accepted profile. */
                }
              if (!abort.signal.aborted)
                this.send({
                  type: "quality-result",
                  id: message.id,
                  revision: message.revision,
                  applied,
                });
            })
            .catch(() => {});
        } else if (message.type === "quality-result") {
          const c = this.controls.get(message.id);
          if (!c || c.revision !== message.revision) return;
          clearTimeout(this.timers.get(c));
          this.timers.delete(c);
          c.pending = false;
          c.error = !message.applied;
          if (message.applied) c.applied = message.applied;
          c.changed();
        } else {
          const ids = new Set(
            message.sources.map((s) => s.id),
          );
          for (const [id, c] of this.controls)
            if (!ids.has(id)) {
              c.available = false;
              c.pending = false;
              clearTimeout(this.timers.get(c));
              this.timers.delete(c);
              this.controls.delete(id);
              c.changed();
            }
          for (const source of message.sources) {
            let c = this.controls.get(source.id);
            const changed =
              !c ||
              JSON.stringify(c.source) !==
                JSON.stringify(source) ||
              !c.available;
            if (!c) {
              this.controls.set(
                source.id,
                (c = new VideoQualityControl(source, (c) =>
                  this.request(c),
                )),
              );
              c.preference = { ...this.preference };
            }
            c.source = source;
            c.available = !!source.transport;
            if (changed) this.request(c);
            c.changed();
          }
          this.dispatchEvent(new Event("change"));
        }
      },
      { signal: abort.signal },
    );
    channel.addEventListener("open", publish, {
      signal: abort.signal,
    });
    channel.addEventListener(
      "close",
      () => this.disconnect(),
      { signal: abort.signal },
    );
    // Capture bounds and negotiated mids can change independently of room metadata.
    this.timer = setInterval(publish, 1000);
    publish();
  }
  private request(c: VideoQualityControl): void {
    clearTimeout(this.timers.get(c));
    ++c.revision;
    c.pending = c.available;
    c.changed();
    if (!c.available) return;
    this.timers.set(
      c,
      setTimeout(() => {
        this.send({
          type: "quality-request",
          id: c.source.id,
          transport: c.source.transport,
          revision: c.revision,
          preference: {
            ...c.preference,
            ...(!c.preference.fps && this.refreshRate
              ? { refreshRate: this.refreshRate }
              : {}),
          },
        });
        this.timers.set(
          c,
          setTimeout(() => {
            c.pending = false;
            c.error = true;
            c.changed();
          }, 10000),
        );
      }, 150),
    );
  }
  private send(message: QualityMessage): void {
    if (
      this.channel?.readyState === "open" &&
      this.channel.bufferedAmount < 262144
    )
      this.channel.send(JSON.stringify(message));
  }
  disconnect(): void {
    this.abort?.abort();
    this.channel = undefined;
    clearInterval(this.timer);
    for (const timer of this.timers.values())
      clearTimeout(timer);
    this.timers.clear();
    this.requests.clear();
    this.signature = "";
    for (const c of this.controls.values()) {
      c.available = false;
      c.pending = false;
      ++c.revision;
      c.changed();
    }
    this.dispatchEvent(new Event("change"));
  }
  dispose(): void {
    this.disconnect();
    this.controls.clear();
    this.sentPreferences.clear();
    this.dispatchEvent(new Event("change"));
  }
}
