import {
  AutomationError,
  type Approval,
  type AutomationDecision,
  type Principal,
  type ToolCall,
} from "@weblink/automation";
import { createUuid } from "@/libs/domain/ids";

interface Authority {
  principal: Principal;
  decision: AutomationDecision;
  approved: boolean;
  revision: number;
}
interface Pending {
  authority: Authority;
  approval: Approval;
  finish(error?: AutomationError): void;
}

/** Browser diagnostic consent is scoped to a verified connection, never a label. */
export class DiagnosticPeerPermissions {
  private readonly authorities = new Map<
    object,
    Authority
  >();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly changed: () => void) {}

  update(
    key: object,
    principal: Principal,
    decision: AutomationDecision,
  ): void {
    let authority = this.authorities.get(key);
    if (!authority) {
      authority = {
        principal,
        decision,
        approved: false,
        revision: 0,
      };
      this.authorities.set(key, authority);
    } else if (authority.decision !== decision) {
      authority.decision = decision;
      authority.approved = false;
      authority.revision++;
      for (const pending of [...this.pending.values()])
        if (pending.authority === authority)
          pending.finish(
            decision === "allow"
              ? undefined
              : new AutomationError("PERMISSION_DENIED"),
          );
    }
  }

  async authorize(
    key: object,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<() => void> {
    const authority = this.authorities.get(key);
    let revision = authority?.revision;
    const check = () => {
      signal.throwIfAborted();
      if (
        !authority ||
        this.authorities.get(key) !== authority
      )
        throw new AutomationError("TARGET_DISCONNECTED");
      if (
        authority.revision !== revision ||
        (authority.decision !== "allow" &&
          !(
            authority.decision === "ask" &&
            authority.approved
          ))
      )
        throw new AutomationError("PERMISSION_DENIED");
    };
    signal.throwIfAborted();
    if (!authority)
      throw new AutomationError("TARGET_DISCONNECTED");
    if (
      authority.decision === "ask" &&
      !authority.approved
    ) {
      if (this.pending.size >= 8)
        throw new AutomationError("BUSY");
      const id = createUuid();
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          finish(new AutomationError("CANCELLED"));
        const timer = setTimeout(
          () => finish(new AutomationError("TIMEOUT")),
          120000,
        );
        const finish = (error?: AutomationError) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.changed();
          if (error) reject(error);
          else resolve();
        };
        this.pending.set(id, {
          authority,
          approval: {
            id,
            principal: authority.principal,
            scope: "diagnostics.read",
            tool: call.name,
            arguments: call.arguments,
            source: call.source,
            expiresAt: Date.now() + 120000,
          },
          finish,
        });
        signal.addEventListener("abort", abort, {
          once: true,
        });
        this.changed();
      });
      revision = authority.revision;
    }
    check();
    return check;
  }

  decide(id: string, accepted: boolean): void {
    const pending = this.pending.get(id);
    if (
      !pending ||
      pending.approval.expiresAt <= Date.now()
    )
      throw new AutomationError("REQUEST_EXPIRED");
    if (accepted) pending.authority.approved = true;
    for (const current of [...this.pending.values()])
      if (current.authority === pending.authority)
        current.finish(
          accepted &&
            current.approval.expiresAt > Date.now()
            ? undefined
            : new AutomationError("PERMISSION_DENIED"),
        );
  }

  disconnect(key: object): void {
    const authority = this.authorities.get(key);
    this.authorities.delete(key);
    for (const pending of [...this.pending.values()])
      if (pending.authority === authority)
        pending.finish(
          new AutomationError("TARGET_DISCONNECTED"),
        );
  }

  approvals(): Approval[] {
    return [...this.pending.values()].map(
      (p) => p.approval,
    );
  }
}
