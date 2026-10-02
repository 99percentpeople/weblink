import { browserNotifications } from "../../../src/libs/platform/browser-notifications";
import type { NotificationAction } from "@weblink/platform";
import { renderNotificationAvatar } from "../../../src/libs/application/notifications/notification-avatar";
import { getAvatarFallbackImage } from "../../../src/libs/utils/avatar";
import { BRAND_ASSETS } from "../../../src/branding/brand";
function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error("Notification callback timed out");
}
async function run() {
  if (location.search === "?peer") {
    const received: NotificationAction[] = [];
    const session = await browserNotifications.watch(
      (action) => received.push(action),
    );
    Object.assign(window, {
      notificationPeer: { received, session },
    });
    return;
  }
  const received: NotificationAction[] = [];
  for (const name of [
    "Alice Smith",
    "张三",
    "& <script>",
  ]) {
    const source = getAvatarFallbackImage(name);
    assert(
      source.startsWith("data:image/svg+xml,"),
      "Default UI avatar must be SVG",
    );
    const vector = new Image();
    vector.src = source;
    await vector.decode();
    assert(
      vector.naturalWidth > 0,
      "Shared SVG failed to decode",
    );
  }
  const fallback = await renderNotificationAvatar({
    name: "Alice",
  });
  assert(
    fallback?.startsWith("data:image/png;base64,"),
    "Missing initials avatar",
  );
  const icon = await renderNotificationAvatar({
    name: "Alice",
    avatar: fallback,
  });
  assert(
    icon && icon.startsWith("data:image/png;base64,"),
    "Could not decode uploaded avatar",
  );
  const image = new Image();
  image.src = icon;
  await image.decode();
  assert(
    image.naturalWidth > 0 && image.naturalWidth <= 128,
    "Avatar must fit the native image contract",
  );
  for (const avatar of [
    "data:image/png;base64,YmFk",
    "https://invalid.example/avatar.png",
  ]) {
    assert(
      (await renderNotificationAvatar({
        name: "Alice",
        avatar,
      })) === fallback,
      "Invalid avatars must use initials",
    );
  }
  // Watch before worker installation to exercise the initial registration race.
  const session = await browserNotifications.watch(
    (action) => received.push(action),
  );
  const registration =
    await navigator.serviceWorker.register(
      "./notification-worker.ts",
      { type: "module" },
    );
  await navigator.serviceWorker.ready;
  await until(() => !!registration.active);
  const iframe = document.createElement("iframe");
  iframe.src = "?peer";
  document.body.append(iframe);
  await until(
    () => !!(iframe.contentWindow as any)?.notificationPeer,
  );
  const peer = (iframe.contentWindow as any)
    .notificationPeer;
  const notice = {
    id: "first",
    title: "Notification lifecycle test",
    body: "A control request",
    icon,
    silent: true,
    expiresAt: Date.now() + 60_000,
    actions: [
      { id: "approve", title: "Allow" },
      { id: "decline", title: "Deny" },
    ],
  };
  await session.show(notice);
  await peer.session.show({ ...notice, id: "second" });
  let notices = await registration.getNotifications();
  assert(
    notices.length === 2,
    "Expected two browser notifications",
  );
  const first = notices.find(
    (item) => item.data.id === "first",
  )!;
  const second = notices.find(
    (item) => item.data.id === "second",
  )!;
  assert(
    first.icon === icon && second.icon === icon,
    "Browser notification lost its avatar",
  );
  assert(
    first.badge ===
      new URL(BRAND_ASSETS.monochrome, location.href).href,
    "Application badge must be separate from the sender avatar",
  );
  await session.show({
    ...notice,
    id: "app-icon",
    icon: undefined,
  });
  const appNotice = (
    await registration.getNotifications()
  ).find((item) => item.data.id === "app-icon");
  assert(
    appNotice?.icon ===
      new URL(BRAND_ASSETS.pwa192, location.href).href,
    "A notification without an avatar must use the app icon",
  );
  await session.dismiss("app-icon");
  assert(
    first.data.owner !== second.data.owner,
    "Notifications must belong to distinct clients",
  );
  const click = (tag: string, action: string) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Worker action timed out")),
        5000,
      );
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve();
      };
      registration.active!.postMessage(
        { type: "test-click", tag, action },
        [channel.port2],
      );
    });
  await click(first.tag, "approve");
  await until(() => received.length === 1);
  assert(
    received[0].action === "approve" &&
      received[0].id === "first",
    "Control action identity changed",
  );
  assert(
    peer.received.length === 0,
    "Action leaked into another tab",
  );
  await session.show({ ...notice, id: "dismiss" });
  await session.dismiss("dismiss");
  notices = await registration.getNotifications();
  assert(
    !notices.some((item) => item.data.id === "dismiss"),
    "Dismissed notification remains",
  );
  await session.close();
  notices = await registration.getNotifications();
  assert(
    notices.length === 1 && notices[0].data.id === "second",
    "Closing one watcher affected another tab",
  );
  await click(second.tag, "");
  await until(() => peer.received.length === 1);
  assert(
    peer.received[0].action === "open",
    "Default click did not route to open",
  );
  await peer.session.close();
  await registration.unregister();
  iframe.remove();
  Object.assign(window, {
    __SPEED_TEST_REPORT__: {
      ok: true,
      checks: [
        "late worker registration",
        "decoded PNG avatars and initials fallback",
        "shared SVG decoding for Latin, CJK and escaped names",
        "native browser notification icons",
        "separate app badge and avatar, with app icon fallback",
        "real browser notifications",
        "owning tab isolation",
        "control action routing",
        "dismiss and watcher cleanup",
        "open conversation action",
      ],
    },
  });
}
void run().catch((error) =>
  Object.assign(window, {
    __SPEED_TEST_ERROR__: String(error?.stack ?? error),
  }),
);
