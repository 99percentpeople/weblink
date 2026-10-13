export interface NativeUpdateInfo {
  version: string;
  notes: string | null;
  canInstall: boolean;
  downloadKind: "installer" | "portable";
  downloadUrl: string;
}

export type NativeUpdateCheck =
  | { status: "current" }
  | {
      status: "unavailable";
      reason: "development" | "platform";
    }
  | { status: "available"; update: NativeUpdateInfo };

export interface NativeUpdateProgress {
  phase: "downloading" | "installing";
  downloaded: number;
  total: number | null;
}

export interface NativeUpdates {
  check(): Promise<NativeUpdateCheck>;
  /** Installs only a previously checked, signed installer update. */
  install(
    version: string,
    onProgress: (progress: NativeUpdateProgress) => void,
  ): Promise<void>;
}
