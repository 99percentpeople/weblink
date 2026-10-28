import { createSignal } from "solid-js";
import { createUuid } from "../domain/ids";

interface ScreenRequest {
  id: string;
  clientId: string;
  generation: string;
  abort: AbortController;
  resolve(sourceId?: string): void;
}

export interface ControlScreenShare {
  sourceId: string;
  release(): void;
  /** Transfer a successful share to the room's lifetime. */
  retain?(): void;
  canClose?(): boolean;
  close?(): boolean | void;
}

/** Consent queues independently; only the selected request reserves capture and handoff. */
export class RemoteScreenConsent {
  private readonly reserved = createSignal<{
    clientId: string;
    sourceId: string;
  } | null>(null);
  readonly reservation = this.reserved[0];
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly pendingState = createSignal<
    {
      consentId: string;
      clientId: string;
      sourceId: string;
      sharing: true;
    }[]
  >([]);
  readonly pending = this.pendingState[0];
  private readonly requests = new Map<
    string,
    ScreenRequest
  >();
  private selected?: ScreenRequest;
  private approved?: {
    clientId: string;
    generation: string;
    sourceId: string;
    expires: number;
  };
  private shared?: ControlScreenShare & {
    clientId: string;
    generation: string;
    active: boolean;
  };
  private readonly retained = new Map<
    string,
    ControlScreenShare & {
      clientId: string;
      generation: string;
    }
  >();
  share?: (
    signal: AbortSignal,
    clientId: string,
  ) => Promise<string | ControlScreenShare | undefined>;

  request(
    clientId: string,
    generation: string,
    signal: AbortSignal,
  ) {
    if (
      this.reservation() ||
      signal.aborted ||
      !this.share ||
      this.requests.size >= 32 ||
      [...this.requests.values()].some(
        (request) => request.clientId === clientId,
      )
    )
      return Promise.resolve(undefined);
    const id = createUuid();
    const abort = new AbortController();
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => abort.abort(), 60_000);
      const cancel = () => abort.abort();
      signal.addEventListener("abort", cancel, {
        once: true,
      });
      const finish = (sourceId?: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.requests.delete(id);
        if (this.selected?.id === id) {
          this.selected = undefined;
          if (!sourceId) this.reserved[1](null);
        }
        this.pendingState[1]((pending) =>
          pending.filter((p) => p.consentId !== id),
        );
        resolve(sourceId);
      };
      abort.signal.addEventListener(
        "abort",
        () => finish(),
        { once: true },
      );
      this.requests.set(id, {
        id,
        clientId,
        generation,
        abort,
        resolve: finish,
      });
      this.pendingState[1]((pending) => [
        ...pending,
        {
          consentId: id,
          clientId,
          sourceId: "",
          sharing: true,
        },
      ]);
    });
  }
  async respond(id: string, accepted: boolean) {
    const request = this.requests.get(id);
    if (!request) return false;
    if (!accepted) {
      request.abort.abort();
      return true;
    }
    if (this.reservation()) return false;
    // Reserve synchronously before starting capture or allowing a second answer.
    this.selected = request;
    this.reserved[1]({
      clientId: request.clientId,
      sourceId: "",
    });
    for (const other of this.requests.values()) {
      if (other !== request) other.abort.abort();
    }
    try {
      const result = await this.share?.(
        request.abort.signal,
        request.clientId,
      );
      const share =
        typeof result === "string"
          ? { sourceId: result, release: () => {} }
          : result;
      if (
        this.selected !== request ||
        request.abort.signal.aborted
      ) {
        share?.release();
        return false;
      }
      const sourceId = share?.sourceId;
      if (!sourceId)
        throw new Error("Could not start screen sharing");
      this.releaseShared();
      this.shared = {
        ...share!,
        clientId: request.clientId,
        generation: request.generation,
        active: false,
      };
      this.approved = {
        clientId: request.clientId,
        generation: request.generation,
        sourceId,
        expires: Date.now() + 30_000,
      };
      this.reserved[1]({
        clientId: request.clientId,
        sourceId,
      });
      clearTimeout(this.expiry);
      this.expiry = setTimeout(
        () => this.clearApproval(),
        30_000,
      );
      request.resolve(sourceId);
      return true;
    } catch (error) {
      if (this.selected === request) {
        this.selected = undefined;
        this.reserved[1](null);
      }
      throw error;
    }
  }
  consume(
    clientId: string,
    generation: string | undefined,
    sourceId: string,
    consume = true,
  ) {
    const grant = this.approved;
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.generation !== generation ||
      grant.sourceId !== sourceId ||
      grant.expires < Date.now()
    )
      return false;
    if (consume) {
      if (this.shared) this.shared.active = true;
      this.clearApproval();
    }
    return true;
  }
  cancelPeer(clientId: string, generation: string) {
    this.cancelRequest(clientId, generation);
    for (const [source, share] of this.retained) {
      if (
        share.clientId !== clientId ||
        share.generation !== generation
      )
        continue;
      this.retained.delete(source);
      share.release();
    }
  }
  cancelRequest(clientId: string, generation: string) {
    for (const request of this.requests.values()) {
      if (
        request.clientId === clientId &&
        request.generation === generation
      )
        request.abort.abort();
    }
    if (
      this.approved?.clientId === clientId &&
      this.approved.generation === generation
    )
      this.clearApproval();
    if (
      this.shared?.clientId === clientId &&
      this.shared.generation === generation
    )
      this.releaseShared();
  }
  cancelClient(clientId: string) {
    for (const [source, share] of this.retained) {
      if (share.clientId !== clientId) continue;
      this.retained.delete(source);
      share.release();
    }
    for (const request of this.requests.values()) {
      if (request.clientId === clientId)
        request.abort.abort();
    }
    if (this.approved?.clientId === clientId)
      this.clearApproval();
    if (this.shared?.clientId === clientId)
      this.releaseShared();
  }
  synchronize(
    clientId: string | null,
    sourceId?: string | null,
  ) {
    const shared = this.shared;
    if (!shared) return;
    if (
      shared.clientId === clientId &&
      shared.sourceId === sourceId
    )
      shared.active = true;
    if (shared.active) this.retainShared();
  }
  canClose(
    clientId: string,
    generation: string,
    sourceId: string,
  ) {
    const share = this.ownedShare(
      clientId,
      generation,
      sourceId,
    );
    return !!share?.close && share.canClose?.() !== false;
  }
  closeScreen(
    clientId: string,
    generation: string,
    sourceId: string,
  ) {
    const share = this.ownedShare(
      clientId,
      generation,
      sourceId,
    );
    if (
      !share?.close ||
      share.canClose?.() === false ||
      share.close() === false
    )
      return false;
    const retained = this.retained.get(sourceId);
    this.retained.delete(sourceId);
    if (this.shared === share) {
      this.shared = undefined;
      this.clearApproval();
    }
    share.release();
    if (retained !== share) retained?.release();
    return true;
  }
  private ownedShare(
    clientId: string,
    generation: string,
    sourceId: string,
  ) {
    return [this.shared, this.retained.get(sourceId)].find(
      (share) =>
        share?.sourceId === sourceId &&
        share.clientId === clientId &&
        share.generation === generation,
    );
  }
  cancelPending() {
    for (const request of this.requests.values())
      request.abort.abort();
    this.clearApproval();
  }
  close() {
    this.cancelPending();
    this.releaseShared();
    for (const share of this.retained.values())
      share.release();
    this.retained.clear();
  }
  private retainShared() {
    const share = this.shared;
    if (!share?.active) return;
    share.retain?.();
    this.shared = undefined;
    const previous = this.retained.get(share.sourceId);
    if (previous?.close && !share.close) {
      share.release();
      return;
    }
    this.retained.set(share.sourceId, share);
    previous?.release();
  }
  private releaseShared() {
    const shared = this.shared;
    this.shared = undefined;
    shared?.release();
  }
  private clearApproval() {
    clearTimeout(this.expiry);
    this.approved = undefined;
    if (this.shared?.active) this.retainShared();
    else this.releaseShared();
    if (!this.selected) this.reserved[1](null);
  }
}
