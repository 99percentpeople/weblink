import type {
  SystemNotifications,
  SystemNotification,
  NotificationAction,
} from "@weblink/platform";
import { createUuid } from "@/libs/domain/ids";
import { BRAND_ASSETS } from "@/branding/brand";

const supported = () =>
  typeof Notification !== "undefined" &&
  window.isSecureContext;
const registration = () =>
  "serviceWorker" in navigator
    ? navigator.serviceWorker
        .getRegistration()
        .catch(() => undefined)
    : Promise.resolve(undefined);

const permissionListeners = new Set<() => void>();

// Reconcile both browser APIs when one still reports `default`. Neither API
// can establish whether an OS notification channel or Do Not Disturb allows delivery.
async function readPermission() {
  if (!supported()) return "unavailable" as const;
  let observed: PermissionState | undefined;
  try {
    observed = (
      await navigator.permissions?.query({
        name: "notifications",
      })
    )?.state;
  } catch {
    // Safari and older WebViews may not implement this permission descriptor.
  }
  const current = Notification.permission;
  if (current === "denied" || observed === "denied")
    return "denied";
  if (current === "granted" || observed === "granted")
    return "granted";
  return "default";
}

/** Bind worker actions to the creating page, never to an arbitrary open tab. */
async function ownerId(
  worker: ServiceWorker,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (id?: string) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(id);
    };
    const timer = setTimeout(() => finish(), 1000);
    channel.port1.onmessage = (event) =>
      finish(
        typeof event.data === "string"
          ? event.data
          : undefined,
      );
    worker.postMessage(
      { type: "weblink-notification-owner" },
      [channel.port2],
    );
  });
}

export const browserNotifications: SystemNotifications = {
  async capabilities() {
    const [permission, reg] = await Promise.all([
      readPermission(),
      registration(),
    ]);
    const active = reg?.active;
    return {
      permission,
      actions:
        supported() &&
        !!active &&
        (
          Notification as typeof Notification & {
            maxActions?: number;
          }
        ).maxActions !== 0,
      reply: false,
    };
  },
  requestPermission() {
    if (!supported()) return Promise.resolve("unavailable");
    if (Notification.permission !== "default")
      return Promise.resolve(Notification.permission);
    // Invoke synchronously so the browser still sees the user's click.
    return Notification.requestPermission().then(
      (permission) => {
        for (const listener of permissionListeners)
          listener();
        return permission;
      },
    );
  },
  onPermissionChange(listener) {
    const controller = new AbortController();
    permissionListeners.add(listener);
    if (supported() && navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: "notifications" })
        .then((status) => {
          if (controller.signal.aborted) return;
          status.addEventListener("change", listener, {
            signal: controller.signal,
          });
          // Cover changes while permission observation was being established.
          listener();
        })
        .catch(() => {
          // Some browsers cannot observe notifications. Focus refresh still works.
        });
    }
    return () => {
      controller.abort();
      permissionListeners.delete(listener);
    };
  },
  async watch(onAction) {
    const watchId = createUuid();
    const direct = new Map<string, Notification>();
    const shown = new Map<string, SystemNotification>();
    const controller = new AbortController();
    let closed = false;
    let reg: ServiceWorkerRegistration | undefined;
    let owner: string | undefined;
    let worker: ServiceWorker | undefined;
    const refreshWorker = async () => {
      reg = await registration();
      if (reg?.active && worker !== reg.active) {
        const active = reg.active;
        owner = await ownerId(active);
        worker = owner ? active : undefined;
      }
    };
    const dismiss = async (id: string) => {
      shown.delete(id);
      direct.get(id)?.close();
      direct.delete(id);
      if (reg)
        for (const item of await reg.getNotifications({
          tag: `${watchId}:${id}`,
        }))
          item.close();
    };
    const dispatch = (action: NotificationAction) => {
      const notification = shown.get(action.id);
      if (
        closed ||
        !notification ||
        notification.expiresAt <= Date.now()
      )
        return;
      if (
        action.action !== "open" &&
        !notification.actions?.some(
          (item) => item.id === action.action,
        )
      )
        return;
      // Consume before focusing: focus events may update notification preferences.
      shown.delete(action.id);
      onAction(action);
    };
    const close = async () => {
      closed = true;
      controller.abort();
      await Promise.all([...shown.keys()].map(dismiss));
    };
    window.addEventListener(
      "pagehide",
      (event) => {
        reg?.active?.postMessage({
          type: "weblink-notification-close",
          watchId,
        });
        if (event.persisted)
          void Promise.all([...shown.keys()].map(dismiss));
        else void close();
      },
      { signal: controller.signal },
    );
    navigator.serviceWorker?.addEventListener(
      "message",
      (event) => {
        if (
          event.source !== reg?.active ||
          event.data?.type !==
            "weblink-notification-action" ||
          event.data.watchId !== watchId
        )
          return;
        if (
          typeof event.data.id === "string" &&
          typeof event.data.action === "string"
        )
          dispatch({
            id: event.data.id,
            action: event.data.action,
          });
      },
      { signal: controller.signal },
    );
    return {
      async show(notification) {
        if (
          closed ||
          !supported() ||
          (await readPermission()) !== "granted"
        )
          return;
        shown.set(notification.id, notification);
        await refreshWorker();
        if (closed || !shown.has(notification.id)) return;
        const options = {
          body: notification.body,
          icon: notification.icon ?? BRAND_ASSETS.pwa192,
          badge: BRAND_ASSETS.monochrome,
          tag: `${watchId}:${notification.id}`,
          silent: notification.silent,
        };
        if (reg?.active && owner) {
          await reg.showNotification(notification.title, {
            ...options,
            actions: notification.actions?.map(
              ({ id, title }) => ({ action: id, title }),
            ),
            requireInteraction:
              !!notification.actions?.length,
            data: {
              type: "weblink-notification",
              watchId,
              owner,
              id: notification.id,
              expiresAt: notification.expiresAt,
            },
          } as NotificationOptions);
          if (closed || !shown.has(notification.id))
            await dismiss(notification.id);
        } else {
          const notice = new Notification(
            notification.title,
            options,
          );
          direct.set(notification.id, notice);
          notice.onclick = () => {
            dispatch({
              id: notification.id,
              action: "open",
            });
            window.focus();
            notice.close();
          };
          notice.onclose = () => {
            direct.delete(notification.id);
          };
          notice.onerror = () => {
            void dismiss(notification.id);
          };
        }
      },
      dismiss,
      close,
    };
  },
};
