// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";
import { createSettingsWriter } from "@/components/settings/create-settings-writer";

it("serializes writes and skips superseded queued edits", async () => {
  let release!: () => void;
  const calls: number[] = [];
  const settled = vi.fn();
  const [writer, dispose] = createRoot(
    (dispose) =>
      [
        createSettingsWriter<number>(async (value) => {
          calls.push(value);
          if (value === 1)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
        }),
        dispose,
      ] as const,
  );
  try {
    const first = writer.save(1, () => settled(1));
    await Promise.resolve();
    const second = writer.save(2, () => settled(2));
    const third = writer.save(3, () => settled(3));
    expect(calls).toEqual([1]);
    release();
    expect(
      await Promise.all([first, second, third]),
    ).toEqual([true, false, true]);
    expect(calls).toEqual([1, 3]);
    expect(settled.mock.calls).toEqual([[3]]);
    expect(writer.saving()).toBe(false);
  } finally {
    dispose();
  }
});

it("reports failed persistence and permits the next automatic write to recover", async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const [writer, dispose] = createRoot(
    (dispose) =>
      [
        createSettingsWriter<number>(write),
        dispose,
      ] as const,
  );
  try {
    expect(await writer.save(1)).toBe(false);
    expect(writer.error()).toBe("disk full");
    expect(await writer.flush()).toBe(false);
    expect(await writer.save(2)).toBe(true);
    expect(await writer.flush()).toBe(true);
    expect(writer.error()).toBe("");
  } finally {
    dispose();
  }
});
