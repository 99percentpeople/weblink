import type {
  NotificationAction,
  NotificationSession,
  SystemNotification,
  SystemNotifications,
} from "@weblink/platform";
import type { NotificationOptions } from "@/libs/domain/notification-options";

export interface NotificationIntent {
  notification: Omit<SystemNotification, "silent">;
  category:
    | "messages"
    | "controlRequests"
    | "speedTestRequests"
    | "transfers";
  current(): boolean;
  /** Defer image work until display is allowed; cancellation is checked again afterwards. */
  prepareIcon?(): Promise<string | undefined>;
  respond(action: NotificationAction): Promise<void>;
}

/** Only live, locally owned notifications may act on application state. */
export class NotificationService {
  private readonly pending = new Map<
    string,
    NotificationIntent
  >();
  private readonly session: Promise<NotificationSession>;
  private closed = false;
  constructor(
    private readonly platform: SystemNotifications,
    private readonly options: () => NotificationOptions,
    private readonly focused: () => boolean,
    private readonly onError: (error: unknown) => void,
  ) {
    this.session = platform.watch(
      (action) => void this.respond(action),
    );
    void this.session.catch(onError);
  }
  private allowed(intent: NotificationIntent) {
    const options = this.options();
    return (
      !this.closed &&
      options.enabled &&
      options[intent.category] &&
      (!options.backgroundOnly || !this.focused()) &&
      intent.current() &&
      intent.notification.expiresAt > Date.now()
    );
  }
  async show(intent: NotificationIntent): Promise<void> {
    const id = intent.notification.id;
    if (!this.allowed(intent) || this.pending.has(id))
      return;
    if (this.pending.size >= 64)
      this.dismiss(this.pending.keys().next().value!);
    this.pending.set(id, intent);
    try {
      const [session, capabilities] = await Promise.all([
        this.session,
        this.platform.capabilities(),
      ]);
      if (this.pending.get(id) !== intent) return;
      if (
        !this.allowed(intent) ||
        (capabilities.permission !== "granted" &&
          capabilities.permission !== "unknown")
      ) {
        this.dismiss(id);
        return;
      }
      const icon = await intent.prepareIcon?.();
      if (this.pending.get(id) !== intent) return;
      if (!this.allowed(intent)) {
        this.dismiss(id);
        return;
      }
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
      // Cancellation may race an asynchronous OS display call.
      if (
        this.pending.get(id) !== intent ||
        !this.allowed(intent)
      )
        await session.dismiss(id);
    } catch (error) {
      this.dismiss(id);
      this.onError(error);
    }
  }
  dismiss(id: string): void {
    this.pending.delete(id);
    void this.session
      .then((session) => session.dismiss(id))
      .catch(this.onError);
  }
  reconcile(): void {
    for (const [id, intent] of this.pending)
      if (
        !this.options().enabled ||
        !this.options()[intent.category] ||
        !intent.current() ||
        intent.notification.expiresAt <= Date.now()
      )
        this.dismiss(id);
  }
  private async respond(
    action: NotificationAction,
  ): Promise<void> {
    const intent = this.pending.get(action.id);
    if (!intent || this.closed) return;
    // Clicking the toast can focus the app; focus is a display policy, not action authorization.
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
    this.dismiss(action.id); // Consume before awaiting; duplicate callbacks must be harmless.
    try {
      await intent.respond(action);
    } catch (error) {
      this.onError(error);
    }
  }
  clear(): void {
    for (const id of this.pending.keys()) this.dismiss(id);
  }
  close(): void {
    this.closed = true;
    this.pending.clear();
    void this.session
      .then((session) => session.close())
      .catch(this.onError);
  }
}
