interface NativePeer {
  state: {
    cancelled: boolean;
    started: boolean;
    settled: boolean;
  };
  offer: Promise<string>;
  closing?: Promise<void>;
}

/** One capture's retiring encoders must be released before admitting new peers. */
export class NativeScreenPeers {
  private readonly peers = new Map<string, NativePeer>();
  private cleanup: Promise<void> = Promise.resolve();

  constructor(
    private readonly closeNative: (
      id: string,
    ) => Promise<void>,
  ) {}

  offer(
    id: string,
    create: () => Promise<string>,
  ): Promise<string> {
    const state = {
      cancelled: false,
      started: false,
      settled: false,
    };
    const offer = this.cleanup
      .then(() => {
        if (state.cancelled)
          throw new DOMException(
            "Native offer cancelled",
            "AbortError",
          );
        state.started = true;
        return create();
      })
      .finally(() => {
        state.settled = true;
      });
    this.peers.set(id, { state, offer });
    return offer;
  }

  close(id: string): Promise<void> {
    const peer = this.peers.get(id);
    if (!peer) return Promise.resolve();
    if (peer.closing) return peer.closing;
    const pending = !peer.state.settled;
    peer.state.cancelled = true;
    // Wake native ICE gathering immediately. An in-flight offer may not have
    // registered its encoder yet, so also release it after that offer settles.
    const early = peer.state.started
      ? Promise.resolve().then(() => this.closeNative(id))
      : Promise.resolve();
    const closing = Promise.allSettled([early, peer.offer])
      .then(async () => {
        if (peer.state.started && pending)
          await this.closeNative(id);
        else await early;
      })
      .finally(() => {
        this.peers.delete(id);
      });
    peer.closing = closing;
    // Includes every retiring peer of this publication, not just the sender
    // being replaced. Failed cleanup must not poison all future admissions.
    this.cleanup = Promise.allSettled([
      this.cleanup,
      closing,
    ]).then(() => {});
    return closing;
  }
}
