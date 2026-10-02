export type NotificationPermissionState =
  // Native OS has no per-app record yet; dispatch is permitted without a prompt.
  | "unknown"
  | "default"
  | "granted"
  | "denied"
  | "unavailable";

export interface NotificationCapabilities {
  permission: NotificationPermissionState;
  actions: boolean;
  reply: boolean;
}

export interface SystemNotification {
  id: string;
  title: string;
  body: string;
  /** Optional PNG data URL, at most 128 KiB encoded and 128 × 128 pixels. */
  icon?: string;
  silent: boolean;
  expiresAt: number;
  actions?: { id: string; title: string }[];
  reply?: { title: string; placeholder: string };
}

export interface NotificationAction {
  id: string;
  action: string;
  text?: string;
}

export interface NotificationSession {
  show(notification: SystemNotification): Promise<void>;
  dismiss(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface SystemNotifications {
  capabilities(): Promise<NotificationCapabilities>;
  requestPermission(): Promise<NotificationPermissionState>;
  /** Observe permission changes where the platform supports it. */
  onPermissionChange?(listener: () => void): () => void;
  watch(
    onAction: (action: NotificationAction) => void,
  ): Promise<NotificationSession>;
}
