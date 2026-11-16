export interface AudioPlaybackState {
  playing: boolean;
  outputSupported: boolean;
  outputDeviceId: string;
  outputBusy: boolean;
}

interface Playback {
  element: HTMLAudioElement;
  track: MediaStreamTrack;
  ready: boolean;
  playing: boolean;
  version: number;
  binding?: Promise<void>;
}

/** Each borrowed track needs its own renderer: Chromium does not mix multiple
 * Web Audio/native bridge tracks attached to a single media element. */
export class AudioPlayback {
  private readonly players = new Map<
    HTMLAudioElement,
    Playback
  >();
  private readonly streams = new WeakMap<
    MediaStreamTrack,
    MediaStream
  >();
  private readonly owners = new WeakMap<
    MediaStreamTrack,
    HTMLAudioElement
  >();
  private probe?: HTMLAudioElement;
  private wanted = true;
  private device = "";
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly changed: (
      state: AudioPlaybackState,
    ) => void,
  ) {}

  private notify() {
    this.changed({
      playing:
        this.wanted &&
        this.players.size > 0 &&
        [...this.players.values()].every(
          (player) => player.ready && player.playing,
        ),
      outputSupported:
        typeof this.probe?.setSinkId === "function",
      outputDeviceId: this.device,
      outputBusy: !this.disposed && this.pending > 0,
    });
  }

  private aborted() {
    return new DOMException(
      "Audio player was detached or disposed",
      "AbortError",
    );
  }

  private enqueue(run: () => Promise<void>) {
    if (this.disposed)
      return Promise.reject(this.aborted());
    this.pending++;
    this.notify();
    const result = this.queue.then(() => {
      if (this.disposed) throw this.aborted();
      return run();
    });
    // A denied device must not poison later selections or new track bindings.
    this.queue = result.catch(() => {});
    return result.finally(() => {
      this.pending--;
      if (!this.disposed) this.notify();
    });
  }

  private async sink(
    element: HTMLAudioElement,
    id: string,
  ) {
    if (typeof element.setSinkId === "function") {
      await element.setSinkId(id);
    } else if (id !== "") {
      throw new DOMException(
        "Audio output selection is unavailable",
        "NotSupportedError",
      );
    }
  }

  private attached(element: HTMLAudioElement) {
    return (
      !this.disposed &&
      (this.probe === element || this.players.has(element))
    );
  }

  setOutputDevice(id: string): Promise<void> {
    return this.enqueue(async () => {
      const probe = this.probe;
      if (!probe)
        throw new DOMException(
          "Audio player is not ready",
          "InvalidStateError",
        );
      const previous = this.device;
      const elements = [probe, ...this.players.keys()];
      const results = await Promise.allSettled(
        elements.map((element) => this.sink(element, id)),
      );
      const failure = results.find(
        (result, index) =>
          result.status === "rejected" &&
          this.attached(elements[index]),
      );
      const aborted = this.disposed || this.probe !== probe;
      if (aborted || failure?.status === "rejected") {
        // Roll back successful live renderers before reporting a partial failure.
        await Promise.all(
          elements.map(async (element, index) => {
            if (
              results[index].status !== "fulfilled" ||
              !this.attached(element)
            )
              return;
            try {
              await this.sink(element, previous);
            } catch {
              const player = this.players.get(element);
              if (player) {
                player.ready = false;
                this.pause(player);
              }
            }
          }),
        );
        this.notify();
        throw failure?.status === "rejected" && !aborted
          ? failure.reason
          : this.aborted();
      }
      this.device = id;
      for (const element of elements) {
        const player = this.players.get(element);
        if (!player) continue;
        player.ready = true;
        this.play(player);
      }
      this.notify();
    });
  }

  private bind(player: Playback) {
    if (player.binding) return;
    player.binding = this.enqueue(async () => {
      if (!this.attached(player.element)) return;
      // Resolve the device inside the queue, after pending selections settle.
      await this.sink(player.element, this.device);
      if (!this.attached(player.element)) return;
      player.ready = true;
      this.play(player);
    })
      .catch(() => {
        // Keep a failed renderer silent; explicit playback or device selection
        // can retry without leaking audio to the system default device.
        if (this.attached(player.element)) {
          player.ready = false;
          this.pause(player);
          this.notify();
        }
      })
      .finally(() => {
        player.binding = undefined;
      });
  }

  private pause(player: Playback) {
    player.version++;
    player.element.pause();
    player.playing = false;
  }

  private play(player: Playback) {
    if (!this.wanted || !player.ready || player.playing)
      return;
    const version = ++player.version;
    void player.element.play().then(
      () => {
        if (
          !this.attached(player.element) ||
          player.version !== version
        )
          return;
        player.playing = this.wanted;
        this.notify();
      },
      () => {
        if (
          !this.attached(player.element) ||
          player.version !== version
        )
          return;
        player.playing = false;
        this.notify();
      },
    );
  }

  setPlay(wanted: boolean): void {
    this.wanted = wanted;
    for (const player of this.players.values()) {
      if (!wanted) this.pause(player);
      else if (!player.ready) this.bind(player);
      // Retry blocked autoplay directly in the user gesture, even when the
      // preference was already true. One blocked track keeps the action visible.
      else this.play(player);
    }
    this.notify();
  }

  attach(
    element: HTMLAudioElement,
    track?: MediaStreamTrack,
  ): void {
    if (this.disposed) return;
    if (!track) {
      // An empty element keeps output-device selection available before anyone
      // sends audio. It never plays or owns a capture track.
      this.probe = element;
      if (this.device || this.pending)
        void this.enqueue(async () => {
          if (this.probe === element)
            await this.sink(element, this.device);
        }).catch(() => {});
    } else {
      const previous = this.owners.get(track);
      if (previous) this.detach(previous);
      this.owners.set(track, element);
      let stream = this.streams.get(track);
      if (!stream) {
        stream = new MediaStream([track]);
        this.streams.set(track, stream);
      }
      element.srcObject = stream;
      const player: Playback = {
        element,
        track,
        ready: !this.device && !this.pending,
        playing: false,
        version: 0,
      };
      this.players.set(element, player);
      if (player.ready) this.play(player);
      else this.bind(player);
    }
    this.notify();
  }

  detach(element: HTMLAudioElement): void {
    const player = this.players.get(element);
    if (player) {
      this.players.delete(element);
      if (this.owners.get(player.track) === element)
        this.owners.delete(player.track);
      this.pause(player);
      element.srcObject = null;
    }
    if (this.probe === element) this.probe = undefined;
    this.notify();
  }

  onPlaying(element: HTMLAudioElement): void {
    const player = this.players.get(element);
    if (!player) return;
    if (!this.wanted || !player.ready) this.pause(player);
    else player.playing = true;
    this.notify();
  }

  onPause(element: HTMLAudioElement): void {
    const player = this.players.get(element);
    if (!player || !element.paused) return;
    player.version++;
    player.playing = false;
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    for (const element of this.players.keys())
      this.detach(element);
    this.probe = undefined;
    this.notify();
  }
}
