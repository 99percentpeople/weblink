import type {
  Audit,
  Principal,
  ToolCall,
} from "@weblink/automation";
/** Local WebMCP activity only; the destination desktop owns authorization. */
export class AutomationAudit {
  readonly entries: Audit[] = [];
  constructor(
    private readonly changed: () => void,
    private readonly now = Date.now,
  ) {}
  record(
    principal: Principal,
    call: ToolCall,
    status: string,
  ): void {
    this.entries.push({
      id: crypto.randomUUID(),
      at: this.now(),
      principal: principal.label,
      tool: call.name,
      target: String(call.arguments.target),
      status,
    });
    if (this.entries.length > 1000) this.entries.shift();
    this.changed();
  }
}
