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
  share?: (
    signal: AbortSignal,
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
    else if (shared.active) this.releaseShared();
  }
  cancelPending() {
    for (const request of this.requests.values())
      request.abort.abort();
    this.clearApproval();
  }
  close() {
    this.cancelPending();
    this.releaseShared();
  }
  private releaseShared() {
    const shared = this.shared;
    this.shared = undefined;
    shared?.release();
  }
  private clearApproval() {
    clearTimeout(this.expiry);
    this.approved = undefined;
    if (!this.shared?.active) this.releaseShared();
    if (!this.selected) this.reserved[1](null);
  }
}
