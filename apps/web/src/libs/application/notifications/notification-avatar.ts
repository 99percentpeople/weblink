import { getAvatarFallbackImage } from "@/libs/utils/avatar";

export interface NotificationAvatar {
  name: string;
  avatar?: string | null;
}

function loadAvatar(source?: string | null) {
  // Profiles carry inline raster images. Never fetch a peer-supplied URL for a toast.
  if (
    !source ||
    source.length > 256 * 1024 ||
    !/^data:image\/(png|jpeg|webp);base64,/i.test(source)
  )
    return Promise.resolve(undefined);
  return loadImage(source);
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement | undefined>(
    (resolve) => {
      const image = new Image();
      const finish = (loaded?: HTMLImageElement) => {
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        if (!loaded) image.removeAttribute("src");
        resolve(loaded);
      };
      const timeout = setTimeout(() => finish(), 1500);
      image.onload = () =>
        finish(
          image.naturalWidth > 0 &&
            image.naturalHeight > 0 &&
            image.naturalWidth <= 4096 &&
            image.naturalHeight <= 4096
            ? image
            : undefined,
        );
      image.onerror = () => finish();
      image.src = source;
    },
  );
}

/** A portable, small circle; the same initials and colors as ClientAvatar. */
export async function renderNotificationAvatar(
  profile: NotificationAvatar,
): Promise<string | undefined> {
  try {
    const image =
      (await loadAvatar(profile.avatar)) ??
      (await loadImage(
        getAvatarFallbackImage(profile.name),
      ));
    if (!image) return;
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.beginPath();
    context.arc(
      size / 2,
      size / 2,
      size / 2,
      0,
      2 * Math.PI,
    );
    context.clip();
    const side = Math.min(
      image.naturalWidth,
      image.naturalHeight,
    );
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    const icon = canvas.toDataURL("image/png");
    return icon.length <= 128 * 1024 ? icon : undefined;
  } catch {
    // An image failure must not suppress the message itself.
    return undefined;
  }
}
