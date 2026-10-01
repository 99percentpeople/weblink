import { createSignal } from "solid-js";
import { createUuid } from "../domain/ids";

/** One pending picker-free share; capture still belongs to the meeting media owner. */
export class RemoteScreenConsent {
  private readonly pendingState = createSignal<{
    consentId: string;
    clientId: string;
    sourceId: string;
    sharing: true;
  } | null>(null);
  readonly pending = this.pendingState[0];
  private current?: {
    id: string;
    clientId: string;
    generation: string;
    abort: AbortController;
    responding?: boolean;
    resolve(sourceId?: string): void;
  };
  private approved?: {
    clientId: string;
    generation: string;
    sourceId: string;
    expires: number;
  };
  share?: (
    signal: AbortSignal,
  ) => Promise<string | undefined>;

  request(
    clientId: string,
    generation: string,
    signal: AbortSignal,
  ) {
    if (this.current || signal.aborted || !this.share)
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
        if (this.current?.id === id) {
          this.current = undefined;
          this.pendingState[1](null);
        }
        resolve(sourceId);
      };
      abort.signal.addEventListener(
        "abort",
        () => finish(),
        { once: true },
      );
      this.current = {
        id,
        clientId,
        generation,
        abort,
        resolve: finish,
      };
      this.pendingState[1]({
        consentId: id,
        clientId,
        sourceId: "",
        sharing: true,
      });
    });
  }
  async respond(id: string, accepted: boolean) {
    const request = this.current;
    if (!request || request.id !== id) return false;
    if (!accepted) {
      request.abort.abort();
      return true;
    }
    if (request.responding) return false;
    request.responding = true;
    try {
      const sourceId = await this.share?.(
        request.abort.signal,
      );
      if (
        this.current !== request ||
        request.abort.signal.aborted
      )
        return false;
      if (!sourceId)
        throw new Error("Could not start screen sharing");
      this.approved = {
        clientId: request.clientId,
        generation: request.generation,
        sourceId,
        expires: Date.now() + 30_000,
      };
      request.resolve(sourceId);
      return true;
    } finally {
      request.responding = false;
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
    if (consume) this.approved = undefined;
    return true;
  }
  cancelPeer(clientId: string, generation: string) {
    if (
      this.current?.clientId === clientId &&
      this.current.generation === generation
    )
      this.current.abort.abort();
    if (
      this.approved?.clientId === clientId &&
      this.approved.generation === generation
    )
      this.approved = undefined;
  }
  close() {
    this.current?.abort.abort();
    this.approved = undefined;
  }
}
