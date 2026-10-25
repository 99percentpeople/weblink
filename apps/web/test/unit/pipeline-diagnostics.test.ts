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
