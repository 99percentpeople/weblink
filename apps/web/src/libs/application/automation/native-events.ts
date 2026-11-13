import type { NativeAutomationEvent } from "@weblink/platform";
import { EventBus } from "@weblink/platform/events";
import { SubscriptionScope } from "@weblink/platform/subscription-scope";

type Events = {
  [Kind in NativeAutomationEvent["kind"]]: Extract<
    NativeAutomationEvent,
    { kind: Kind }
  >;
};

/** One page-owned automation channel, buffered until its native epoch is known. */
export class NativeAutomationEvents {
  private readonly bus = new EventBus<Events>("automation");
  private readonly scope: SubscriptionScope;
  private pending: NativeAutomationEvent[] = [];
  private epoch = "";
  readonly events = this.bus.events;

  constructor(signal: AbortSignal) {
    this.scope = new SubscriptionScope(signal);
    this.scope.add(() => {
      this.pending = [];
      this.bus.dispose();
    });
  }

  readonly receive = (
    event: NativeAutomationEvent,
  ): void => {
    if (this.scope.signal.aborted) return;
    if (!this.epoch) {
      this.pending.push(event);
      return;
    }
    if ("epoch" in event && event.epoch !== this.epoch)
      return;
    this.bus.emit(event.kind, event);
  };

  activate(epoch: string): void {
    if (this.scope.signal.aborted) return;
    this.epoch = epoch;
    const pending = this.pending;
    this.pending = [];
    pending.forEach(this.receive);
  }

  dispose(): void {
    this.scope.dispose();
  }
}
