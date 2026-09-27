import { createPermission } from "@solid-primitives/permission";
import {
  createEffect,
  createMemo,
  createResource,
  createRoot,
  onCleanup,
  onMount,
} from "solid-js";

if (!("mediaDevices" in navigator)) {
  throw new Error(
    "Media Devices API is not supported, please use in secure context",
  );
}

const [mediaDevices, { refetch: refetchDevices }] =
  createResource(
    () => navigator.mediaDevices.enumerateDevices(),
    {
      initialValue: [],
    },
  );

export const createCameras = () => {
  const cameras = createMemo(() =>
    mediaDevices().filter(
      (device) => device.kind === "videoinput",
    ),
  );

  return cameras;
};

export const createMicrophones = () => {
  const microphones = createMemo(() =>
    mediaDevices().filter(
      (device) => device.kind === "audioinput",
    ),
  );

  return microphones;
};

export const createSpeakers = () => {
  const speakers = createMemo(() =>
    mediaDevices().filter(
      (device) => device.kind === "audiooutput",
    ),
  );

  return speakers;
};

createRoot(() => {
  const cameraPermission = createPermission("camera");
  const microphonePermission =
    createPermission("microphone");

  createEffect(() => {
    if (cameraPermission()) {
      refetchDevices();
    }
  });

  createEffect(() => {
    if (microphonePermission()) {
      refetchDevices();
    }
  });

  onMount(() => {
    navigator.mediaDevices.addEventListener(
      "devicechange",
      refetchDevices,
    );

    onCleanup(() => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refetchDevices,
      );
    });
  });
});

export { refetchDevices };
