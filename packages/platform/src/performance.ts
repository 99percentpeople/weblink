/** Native performance diagnostics shared by desktop IPC and automation. */
export interface NativePipelineStats {
  performance?: {
    /** Startup preference; independent of temporary stream scheduling. */
    powerPolicy?: NativePowerPolicyReport;
    remoteConsumers: number;
    timing: NativePerformanceStatus;
    gpuScheduling: NativePerformanceStatus;
    captureThread: NativeThreadPerformance | null;
    encodeThread: NativeThreadPerformance | null;
  };
  frames: number;
  inputSize: [number, number];
  readbackSize: [number, number];
  gpuScaled: boolean;
  scaleFallback: string | null;
  peers: number;
  hardwareEncoders: number;
  encoders: Record<string, unknown>[];
  peerErrors: string[];
  [stage: string]: unknown;
}
export type NativePerformanceStatus =
  | {
      state:
        | "inactive"
        | "applied"
        | "alreadyApplied"
        | "unsupported";
    }
  | { state: "failed"; reason: string };
export interface NativeThreadPerformance {
  scheduling: NativePerformanceStatus;
  timing: NativePerformanceStatus;
}
export interface NativePowerPolicyReport {
  backend: string | null;
  lifetime: "persistentApplication";
  status:
    | {
        state: "applied" | "alreadyApplied" | "unsupported";
      }
    | { state: "failed"; reason: string };
}
