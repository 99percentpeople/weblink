import { expect, it } from "vitest";
import { sanitizePipeline } from "@/libs/application/automation/pipeline-diagnostics";

it("identifies requested and effective presets without exposing native names or paths", () => {
  const result = JSON.parse(
    JSON.stringify(
      sanitizePipeline({
        encoders: [
          {
            controls: [
              {
                name: "encodingPreset",
                requested: 1,
                actual: 0,
                accepted: false,
                error:
                  "Using balanced: C:\\private\\driver 0x80004001",
              },
            ],
            selection: {
              name: "Private adapter name",
              fallback: "private details",
            },
          },
        ],
        name: "private name",
        total: { meanMs: 5, maxMs: Infinity },
      }),
    ),
  );
  expect(result.encoders[0].controls[0]).toEqual({
    name: "encodingPreset",
    requested: 1,
    actual: 0,
    accepted: false,
    error: ["0x80004001"],
  });
  expect(result.encoders[0].selection).toEqual({});
  expect(result.total).toEqual({ meanMs: 5 });
  expect(result.name).toBeUndefined();
});

it("preserves fixed performance outcomes and lifetime while redacting driver details", () => {
  const result = JSON.parse(
    JSON.stringify(
      sanitizePipeline({
        performance: {
          remoteConsumers: 0,
          powerPolicy: {
            backend: "NVIDIA DRS",
            lifetime: "persistentApplication",
            status: {
              state: "failed",
              reason: "C:\\private\\driver: 0x80004001",
            },
          },
          timing: { state: "inactive" },
          gpuScheduling: { state: "alreadyApplied" },
          captureThread: {
            scheduling: { state: "applied" },
            timing: { state: "unsupported" },
          },
          encodeThread: null,
        },
        unknown: {
          state: "C:\\private\\state",
          backend: "Private GPU name",
          lifetime: "private text",
        },
      }),
    ),
  );
  expect(result.performance).toEqual({
    remoteConsumers: 0,
    powerPolicy: {
      backend: "NVIDIA DRS",
      lifetime: "persistentApplication",
      status: { state: "failed", reason: ["0x80004001"] },
    },
    timing: { state: "inactive" },
    gpuScheduling: { state: "alreadyApplied" },
    captureThread: {
      scheduling: { state: "applied" },
      timing: { state: "unsupported" },
    },
    encodeThread: null,
  });
  expect(result.unknown).toEqual({});
});
