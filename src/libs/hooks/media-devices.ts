import { createSignal, onCleanup, onMount } from "solid-js";

export function createMediaDevices() {
  const [devices, setDevices] = createSignal<
    MediaDeviceInfo[]
  >([]);
  const [error, setError] = createSignal<Error | null>(
    null,
  );

  const updateDevices = async () => {
    try {
      const deviceList =
        await navigator.mediaDevices.enumerateDevices();
      setDevices(deviceList);
    } catch (err) {
      setError(err as Error);
    }
  };

  const handleDeviceChange = () => {
    updateDevices();
  };

  onMount(() => {
    updateDevices();
    navigator.mediaDevices.addEventListener(
      "devicechange",
      handleDeviceChange,
    );
  });

  onCleanup(() => {
    navigator.mediaDevices.removeEventListener(
      "devicechange",
      handleDeviceChange,
    );
  });

  return {
    devices,
    error,
    updateDevices,
  };
}
