import {
  AutomationError,
  permissionScopes,
  type Approval,
  type Audit,
  type Grant,
  type Principal,
  type Scope,
  type ToolCall,
} from "@weblink/automation";
/** Browser authority. Native callers use the Rust authority instead. */
export class AutomationPermissions {
  readonly grants = new Map<string, Grant>();
  readonly pending = new Map<string, Approval>();
  readonly audit: Audit[] = [];
  private waiters = new Map<
    string,
    (allow: boolean) => void
  >();
  private lifetimes = new Map<string, AbortController>();
  constructor(
    private readonly changed: () => void,
    private readonly now = Date.now,
  ) {}
  async require(
    principal: Principal,
    scope: Scope,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<AbortSignal> {
    signal.throwIfAborted();
    this.expire();
    const existing = [...this.grants.values()].find(
      (g) =>
        g.principal.id === principal.id &&
        g.scopes.includes(scope) &&
        g.target === call.arguments.target,
    );
    if (existing)
      return this.lifetimes.get(existing.id)!.signal;
    if (this.pending.size >= 8)
      throw new AutomationError("BUSY");
    const id = crypto.randomUUID();
    const request: Approval = {
      source: call.source,
      id,
      principal,
      scope,
      tool: call.name,
      arguments: call.arguments,
      expiresAt: this.now() + 120000,
    };
    const allowed = await new Promise<boolean>(
      (resolve) => {
        const finish = (allow: boolean) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.waiters.delete(id);
          this.pending.delete(id);
          this.changed();
          resolve(allow);
        };
        const abort = () => finish(false);
        const timer = setTimeout(abort, 120000);
        this.waiters.set(id, finish);
        this.pending.set(id, request);
        signal.addEventListener("abort", abort, {
          once: true,
        });
        this.changed();
      },
    );
    signal.throwIfAborted();
    if (!allowed)
      throw new AutomationError("PERMISSION_DENIED");
    return this.require(principal, scope, call, signal);
  }
  decide(id: string, minutes: number): void {
    const request = this.pending.get(id);
    if (!request) return;
    const scopes = permissionScopes(request.scope);
    const allow =
      [5, 15, 60].includes(minutes) &&
      request.expiresAt > this.now();
    if (allow) {
      const grant: Grant = {
        target: String(request.arguments.target),
        id: crypto.randomUUID(),
        principal: request.principal,
        scopes: [...scopes],
        expiresAt: this.now() + minutes * 60000,
      };
      this.grants.set(grant.id, grant);
      this.lifetimes.set(grant.id, new AbortController());
    }
    for (const pending of [...this.pending.values()]) {
      if (
        pending.principal.id === request.principal.id &&
        pending.principal.kind === request.principal.kind &&
        pending.arguments.target ===
          request.arguments.target &&
        scopes.includes(pending.scope)
      )
        this.waiters.get(pending.id)?.(
          allow && pending.expiresAt > this.now(),
        );
    }
    this.changed();
  }
  revoke(id: string): void {
    this.lifetimes
      .get(id)
      ?.abort(new AutomationError("GRANT_EXPIRED"));
    this.lifetimes.delete(id);
    this.grants.delete(id);
    this.changed();
  }
  expire(): void {
    for (const g of this.grants.values())
      if (g.expiresAt !== null && g.expiresAt <= this.now())
        this.revoke(g.id);
  }
  disconnect(principal: string): void {
    for (const p of this.pending.values())
      if (p.principal.id === principal)
        this.waiters.get(p.id)?.(false);
    for (const g of this.grants.values())
      if (g.principal.id === principal) this.revoke(g.id);
  }
  stop(): void {
    for (const finish of [...this.waiters.values()])
      finish(false);
    for (const id of [...this.grants.keys()])
      this.revoke(id);
  }
  record(
    principal: Principal,
    call: ToolCall,
    status: string,
  ): void {
    this.audit.push({
      id: crypto.randomUUID(),
      at: this.now(),
      principal: principal.label,
      tool: call.name,
      target: String(call.arguments.target),
      status,
    });
    if (this.audit.length > 1000) this.audit.shift();
    this.changed();
  }
}
