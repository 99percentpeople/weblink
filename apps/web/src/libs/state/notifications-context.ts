import { createContext, useContext } from "solid-js";
import type { NotificationService } from "@/libs/application/notifications/notification-service";

export type AppNotifications = Pick<
  NotificationService,
  "show" | "dismiss"
>;

export const NotificationsContext =
  createContext<AppNotifications>();

export const useNotifications = () =>
  useContext(NotificationsContext);
