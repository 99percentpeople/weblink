import { createSignal, onCleanup, onMount } from "solid-js";

export function createMediaDevices() {
  const [devices, setDevices] = createSignal<
    MediaDeviceInfo[]
  >([]);
  const [error, setError] = createSignal<Error | null>(
    null,
  );
  const [refreshing, setRefreshing] = createSignal(false);
  let generation = 0;
  let disposed = false;

  const updateDevices = async () => {
    if (disposed) return;
    const current = ++generation;
    setRefreshing(true);
    setError(null);
    try {
      const media = navigator.mediaDevices;
      const deviceList = media?.enumerateDevices
        ? await media.enumerateDevices()
        : [];
      if (!disposed && current === generation)
        setDevices(deviceList);
    } catch (err) {
      if (!disposed && current === generation)
        setError(
          err instanceof Error
            ? err
            : new Error(String(err)),
        );
    } finally {
      if (!disposed && current === generation)
        setRefreshing(false);
    }
  };

  const handleDeviceChange = () => void updateDevices();

  onMount(() => {
    void updateDevices();
    const media = navigator.mediaDevices;
    media?.addEventListener?.(
      "devicechange",
      handleDeviceChange,
    );
    onCleanup(() => {
      media?.removeEventListener?.(
        "devicechange",
        handleDeviceChange,
      );
    });
  });

  onCleanup(() => {
    disposed = true;
    ++generation;
  });

  return {
    devices,
    error,
    refreshing,
    updateDevices,
  };
}
