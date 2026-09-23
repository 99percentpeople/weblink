import type { Accessor } from "solid-js";

export type MeetingDeviceAccessState =
  | PermissionState
  | "checking"
  | "unavailable"
  | "unsupported";

export type MeetingDeviceAccess = {
  state(kind: MediaDeviceKind): MeetingDeviceAccessState;
  requesting: Accessor<MediaDeviceKind | null>;
  needsPermission: Accessor<boolean>;
  outputNeedsMicrophone(): boolean;
  request(kind: MediaDeviceKind): Promise<void>;
};

export type MeetingDeviceControls = {
  access: MeetingDeviceAccess;
  list: Accessor<readonly MediaDeviceInfo[]>;
  refreshing: Accessor<boolean>;
  refresh(): void;
  microphoneId: Accessor<string>;
  cameraId: Accessor<string>;
  selectMicrophone(id: string): Promise<void>;
  selectCamera(id: string): Promise<void>;
  outputId: Accessor<string>;
  outputSupported: Accessor<boolean>;
  outputBusy: Accessor<boolean>;
  selectOutput(id: string): Promise<void>;
};
