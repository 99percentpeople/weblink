// @vitest-environment node
import { expect, it } from "vitest";
import { WebmRecordingMetadata } from "@/libs/application/recording-webm";

const join = (...parts: Uint8Array[]) =>
  new Uint8Array(parts.flatMap((part) => [...part]));
const scale = new Uint8Array([
  0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40,
]);
const payload = new Uint8Array([
  0x1f, 0x43, 0xb6, 0x75, 0xff, 0xa3, 0x84, 1, 2, 3, 4,
]);
function file(info = scale, finite = false) {
  return join(
    new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67,
    ]),
    finite
      ? new Uint8Array([
          0x80 | (5 + info.length + payload.length),
        ])
      : new Uint8Array([
          1, 255, 255, 255, 255, 255, 255, 255,
        ]),
    new Uint8Array([
      0x15,
      0x49,
      0xa9,
      0x66,
      0x80 | info.length,
    ]),
    info,
    payload,
  );
}
function finish(
  metadata: WebmRecordingMetadata,
  output: Uint8Array,
  elapsed = 12345,
) {
  const result = metadata.finish(elapsed);
  const content = join(output, result.tail);
  for (const patch of result.patches)
    content.set(patch.data, patch.offset);
  return { content, patches: result.patches };
}

it.each([1, 4, 9, 20, 26, 100])(
  "reserves the duration across %i-byte input blocks and preserves media",
  (block) => {
    const metadata = new WebmRecordingMetadata();
    const input = file();
    const output = [];
    for (
      let offset = 0;
      offset < input.length;
      offset += block
    )
      output.push(
        metadata.write(input.slice(offset, offset + block)),
      );
    const result = finish(metadata, join(...output));
    expect(result.content.length).toBe(input.length + 11);
    expect(result.content.slice(-payload.length)).toEqual(
      payload,
    );
    expect(result.patches).toHaveLength(1);
    expect(
      new DataView(
        result.patches[0].data.buffer,
      ).getFloat64(0),
    ).toBe(12345);
    expect(
      result.content.slice(
        result.patches[0].offset - 3,
        result.patches[0].offset,
      ),
    ).toEqual(new Uint8Array([0x44, 0x89, 0x88]));
  },
);
it("grows the Info size integer without overwriting payload", () => {
  const info = join(
    scale,
    new Uint8Array([0xec, 0x80 | 117]),
    new Uint8Array(117),
  );
  const metadata = new WebmRecordingMetadata();
  const input = file(info);
  const result = finish(metadata, metadata.write(input));
  expect(result.content.length).toBe(input.length + 12);
  expect([...result.content.slice(21, 23)]).toEqual([
    0x40, 137,
  ]);
  expect(result.content.slice(-payload.length)).toEqual(
    payload,
  );
});
it("uses TimestampScale and fills an existing float32 duration without shifting indexed content", () => {
  const info = new Uint8Array([
    0x2a, 0xd7, 0xb1, 0x83, 0x1e, 0x84, 0x80, 0x44, 0x89,
    0x84, 0, 0, 0, 0,
  ]);
  const metadata = new WebmRecordingMetadata();
  const input = file(info, true);
  const result = finish(
    metadata,
    metadata.write(input),
    5000,
  );
  expect(result.content.length).toBe(input.length);
  expect(
    new DataView(result.patches[0].data.buffer).getFloat32(
      0,
    ),
  ).toBe(2500);
});
it("preserves an existing finite duration", () => {
  const duration = new Uint8Array(7);
  duration.set([0x44, 0x89, 0x84]);
  new DataView(duration.buffer).setFloat32(3, 1500);
  const input = file(join(scale, duration));
  const metadata = new WebmRecordingMetadata();
  const result = finish(metadata, metadata.write(input));
  expect(result.content).toEqual(input);
  expect(result.patches).toEqual([]);
});
it("preserves finite or checksummed containers that cannot safely grow", () => {
  for (const input of [
    file(scale, true),
    file(
      join(scale, new Uint8Array([0xbf, 0x84, 0, 0, 0, 0])),
    ),
  ]) {
    const metadata = new WebmRecordingMetadata();
    const result = finish(metadata, metadata.write(input));
    expect(result.content).toEqual(input);
    expect(result.patches).toEqual([]);
  }
});
it("retains incomplete header bytes and bounds pending header memory", () => {
  const metadata = new WebmRecordingMetadata();
  expect(
    metadata.write(new Uint8Array([0x1a])),
  ).toHaveLength(0);
  expect(metadata.finish(1).tail).toEqual(
    new Uint8Array([0x1a]),
  );
  const input = new Uint8Array(65536);
  input.set([0x1a, 0x45, 0xdf, 0xa3, 0x20, 0xff, 0xff]);
  expect(new WebmRecordingMetadata().write(input)).toEqual(
    input,
  );
});
