import type {
  NotificationAction,
  NotificationSession,
  SystemNotification,
  SystemNotifications,
} from "@weblink/platform";
import type { NotificationOptions } from "@/libs/domain/notification-options";

export interface InAppNotification {
  dismiss(): void;
  /** Refresh an existing progress notice without creating a new reminder. */
  update?(): void;
}

export interface NotificationIntent {
  notification: Omit<SystemNotification, "silent">;
  category:
    | "messages"
    | "controlRequests"
    | "speedTestRequests"
    | "updates"
    | "recordings"
    | "transfers";
  current(): boolean;
  /** Keep in-app feedback while current(), independently of native notification expiry. */
  retainInApp?: boolean;
  /** Display policy only; opening a notification may change it before its action arrives. */
  canDisplay?(): boolean;
  /** Defer image work until display is allowed; cancellation is checked again afterwards. */
  prepareIcon?(): Promise<string | undefined>;
  /** Show the shared toast while visible, including after an explicit native body click. */
  present?(): InAppNotification | undefined;
  /** Bring the app forward and reuse present() when the system notice body is clicked. */
  openInApp?(): void | Promise<void>;
  respond(action: NotificationAction): Promise<void>;
}

interface Delivery {
  intent: NotificationIntent;
  state:
    | "waiting"
    | "preparing"
    | "dispatching"
    | "opening"
    | "toast"
    | "system"
    | "dismissed";
  revision: number;
  presentation?: InAppNotification;
}

/** One event uses one channel; an explicit native body click can transfer it to the existing toast. */
export class NotificationService {
  private readonly deliveries = new Map<string, Delivery>();
  private readonly pending = new Map<string, Delivery>();
  private readonly session?: Promise<NotificationSession>;
  private closed = false;
  constructor(
    private readonly platform:
      | SystemNotifications
      | undefined,
    private readonly options: () => NotificationOptions,
    private readonly visible: () => boolean,
    private readonly onError: (error: unknown) => void,
  ) {
    this.session = platform?.watch(
      (action) => void this.respond(action),
    );
    void this.session?.catch(onError);
  }
  private current(
    intent: NotificationIntent,
    inApp = false,
  ) {
    return (
      !this.closed &&
      intent.current() &&
      (intent.notification.expiresAt > Date.now() ||
        (inApp &&
          !!intent.present &&
          intent.retainInApp === true))
    );
  }
  private allowed(intent: NotificationIntent) {
    const options = this.options();
    return (
      !!this.platform &&
      options.enabled &&
      options[intent.category] &&
      !this.visible() &&
      (intent.canDisplay?.() ?? true) &&
      this.current(intent)
    );
  }
  private present(delivery: Delivery): void {
    if (
      (delivery.state !== "waiting" &&
        delivery.state !== "opening") ||
      !this.visible() ||
      !this.current(delivery.intent, true) ||
      !delivery.intent.present
    )
      return;
    delivery.state = "toast";
    try {
      delivery.presentation = delivery.intent.present();
      if (!delivery.presentation)
        delivery.state = "waiting";
    } catch (error) {
      delivery.state = "waiting";
      this.onError(error);
    }
  }
  async show(intent: NotificationIntent): Promise<void> {
    const id = intent.notification.id;
    if (!this.current(intent, true)) return;
    let delivery = this.deliveries.get(id);
    if (delivery) {
      delivery.intent.notification.expiresAt = Math.max(
        delivery.intent.notification.expiresAt,
        intent.notification.expiresAt,
      );
      if (delivery.state !== "waiting") return;
    } else {
      // Chat and other system-only events are not queued while the app is visible.
      if (!intent.present && !this.allowed(intent)) return;
      delivery = { intent, state: "waiting", revision: 0 };
      this.deliveries.set(id, delivery);
    }
    this.present(delivery);
    if (
      delivery.state !== "waiting" ||
      !this.allowed(delivery.intent)
    )
      return;
    await this.dispatch(delivery);
  }
  private async dispatch(
    delivery: Delivery,
  ): Promise<void> {
    const intent = delivery.intent;
    const id = intent.notification.id;
    const revision = ++delivery.revision;
    delivery.state = "preparing";
    if (this.pending.size >= 64)
      this.dismiss(this.pending.keys().next().value!);
    this.pending.set(id, delivery);
    const preparing = () =>
      delivery.revision === revision &&
      delivery.state === "preparing" &&
      this.pending.get(id) === delivery;
    try {
      const [session, capabilities] = await Promise.all([
        this.session!,
        this.platform!.capabilities(),
      ]);
      if (!preparing()) return;
      if (
        !this.allowed(intent) ||
        (capabilities.permission !== "granted" &&
          capabilities.permission !== "unknown")
      ) {
        return;
      }
      const icon = await intent.prepareIcon?.();
      if (!preparing() || !this.allowed(intent)) return;
      // Once native dispatch starts, wait for its outcome before permitting a toast.
      delivery.state = "dispatching";
      await session.show({
        ...intent.notification,
        icon: icon ?? intent.notification.icon,
        silent: !this.options().sound,
        actions: capabilities.actions
          ? intent.notification.actions
          : undefined,
        reply: capabilities.reply
          ? intent.notification.reply
          : undefined,
      });
      if (delivery.state === "dispatching")
        delivery.state = "system";
      // Cancellation may race an asynchronous OS display call.
      if (
        this.pending.get(id) !== delivery ||
        !this.allowed(intent)
      ) {
        this.pending.delete(id);
        await session.dismiss(id);
      }
    } catch (error) {
      this.onError(error);
      if (
        delivery.revision === revision &&
        delivery.state === "dispatching"
      ) {
        // A failed adapter call may have partially created a notice. Retract it
        // before allowing another channel, and ignore any late native actions.
        this.pending.delete(id);
        await this.session!.then((session) =>
          session.dismiss(id),
        ).catch(this.onError);
      }
      if (
        delivery.revision === revision &&
        (delivery.state === "preparing" ||
          delivery.state === "dispatching")
      ) {
        delivery.state = "waiting";
        this.pending.delete(id);
      }
    } finally {
      if (preparing()) {
        delivery.state = "waiting";
        this.pending.delete(id);
      }
      this.present(delivery);
    }
  }
  update(id: string, expiresAt?: number): void {
    const delivery = this.deliveries.get(id);
    if (delivery && expiresAt)
      delivery.intent.notification.expiresAt = expiresAt;
    if (
      delivery?.state === "toast" &&
      this.current(delivery.intent, true)
    )
      delivery.presentation?.update?.();
  }
  dismiss(id: string): void {
    const delivery = this.deliveries.get(id);
    if (delivery && delivery.state !== "dismissed") {
      delivery.revision++;
      delivery.state = "dismissed";
      delivery.presentation?.dismiss();
      delivery.presentation = undefined;
    }
    if (this.pending.delete(id))
      void this.session
        ?.then((session) => session.dismiss(id))
        .catch(this.onError);
  }
  private cancelPreparation(delivery: Delivery): void {
    delivery.revision++;
    delivery.state = "waiting";
    this.pending.delete(delivery.intent.notification.id);
  }
  reconcile(): void {
    for (const [id, delivery] of this.deliveries) {
      const intent = delivery.intent;
      const inApp =
        delivery.state === "waiting" ||
        delivery.state === "opening" ||
        delivery.state === "preparing" ||
        delivery.state === "toast";
      if (!this.current(intent, inApp)) {
        this.dismiss(id);
        // An expired event can no longer act; discard its callbacks and delivery record.
        if (intent.notification.expiresAt <= Date.now())
          this.deliveries.delete(id);
        continue;
      }
      if (
        delivery.state === "preparing" &&
        !this.allowed(intent)
      )
        this.cancelPreparation(delivery);
      if (
        this.pending.has(id) &&
        (!this.options().enabled ||
          !this.options()[intent.category])
      )
        this.dismiss(id);
      this.present(delivery);
    }
  }
  private async respond(
    action: NotificationAction,
  ): Promise<void> {
    const delivery = this.pending.get(action.id);
    if (!delivery || this.closed) return;
    const intent = delivery.intent;
    // Opening a notification may show the app; visibility only controls display, not action authorization.
    if (
      !this.options().enabled ||
      !this.options()[intent.category] ||
      !intent.current() ||
      intent.notification.expiresAt <= Date.now()
    ) {
      this.dismiss(action.id);
      return;
    }
    if (
      action.action !== "open" &&
      !(
        action.action === "reply" &&
        intent.notification.reply &&
        action.text?.trim()
      ) &&
      !intent.notification.actions?.some(
        (item) => item.id === action.action,
      )
    )
      return;
    if (
      action.action === "open" &&
      intent.openInApp &&
      intent.present
    ) {
      // Consume before focusing. Focus can synchronously reconcile visibility,
      // and duplicate OS callbacks must not create another toast or grant consent.
      this.pending.delete(action.id);
      delivery.revision++;
      delivery.state = "opening";
      void this.session
        ?.then((session) => session.dismiss(action.id))
        .catch(this.onError);
      try {
        await intent.openInApp();
      } catch (error) {
        this.onError(error);
      } finally {
        this.present(delivery);
      }
      return;
    }
    this.dismiss(action.id); // Consume before awaiting; duplicate callbacks must be harmless.
    try {
      await intent.respond(action);
    } catch (error) {
      this.onError(error);
    }
  }
  clear(): void {
    // Notification preferences affect native notices, never an in-app confirmation.
    for (const [id, delivery] of this.pending) {
      if (delivery.state === "preparing")
        this.cancelPreparation(delivery);
      else this.dismiss(id);
    }
  }
  close(): void {
    this.closed = true;
    for (const id of this.deliveries.keys())
      this.dismiss(id);
    this.deliveries.clear();
    void this.session
      ?.then((session) => session.close())
      .catch(this.onError);
  }
}
