// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { DirectoryVerification } from "@/libs/infrastructure/vfs/directory-verification";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { MemoryNativeVolume } from "../support/native-volume";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const volume = new MemoryNativeVolume();
  const payload = new Uint8Array(4 * 1024 * 1024).fill(13);
  const path = "file.dll";
  const stat = await volume.commit(
    path,
    [{ offset: 0, data: payload }],
    payload.length,
  );
  const metadata = {
    name: path,
    type: "",
    lastModified: 0,
  };
  const file = await volume.file(path, metadata);
  const verification = new DirectoryVerification();
  return {
    volume,
    payload,
    path,
    stat,
    metadata,
    file,
    verification,
  };
}
const readBytes = (volume: MemoryNativeVolume) =>
  volume.reads.reduce((sum, read) => sum + read.length, 0);

it("shares a completed verification between concurrent file snapshots", async () => {
  const f = await fixture();
  const other = await f.volume.file(f.path, f.metadata);
  expect(other).not.toBe(f.file);
  const [first, second] = await Promise.all([
    f.verification.verify(f.volume, f.path, f.stat, f.file),
    f.verification.verify(f.volume, f.path, f.stat, other),
  ]);
  expect(first).toEqual(
    await fingerprintBlob(new Blob([f.payload])),
  );
  expect(second).toEqual(first);
  expect(readBytes(f.volume)).toBe(f.payload.length);
  first.digest = "mutated";
  expect(
    await f.verification.verify(
      f.volume,
      f.path,
      f.stat,
      other,
    ),
  ).toEqual(second);
});

it("does not cache cancelled work or cancel a queued caller", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const cancelled = f.verification.verify(
    f.volume,
    f.path,
    f.stat,
    f.file,
    {
      signal: controller.signal,
      onProgress: ({ bytes }) => {
        if (bytes > 0) controller.abort();
      },
    },
  );
  const queued = f.verification.verify(
    f.volume,
    f.path,
    f.stat,
    await f.volume.file(f.path, f.metadata),
  );
  await expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(await queued).toEqual(
    await fingerprintBlob(new Blob([f.payload])),
  );
  expect(readBytes(f.volume)).toBe(
    f.payload.length + 2 * 1024 * 1024,
  );
});

it("rejects a file changed during verification and verifies the new revision from scratch", async () => {
  const f = await fixture();
  const read = f.volume.read.bind(f.volume);
  const spy = vi
    .spyOn(f.volume, "read")
    .mockImplementation(async (path, offset, length) => {
      const bytes = await read(path, offset, length);
      if (offset + length === f.payload.length) {
        f.payload[0]++;
        await f.volume.commit(path, [
          { offset: 0, data: f.payload },
        ]);
      }
      return bytes;
    });
  await expect(
    f.verification.verify(f.volume, f.path, f.stat, f.file),
  ).rejects.toThrow("File changed");
  spy.mockRestore();
  f.volume.reads.length = 0;
  await expect(
    f.verification.verify(f.volume, f.path, f.stat, f.file),
  ).rejects.toThrow("File changed");
  expect(readBytes(f.volume)).toBe(0);
  const stat = (await f.volume.stat(f.path))!;
  const file = await f.volume.file(f.path, f.metadata);
  expect(
    await f.verification.verify(
      f.volume,
      f.path,
      stat,
      file,
    ),
  ).toEqual(await fingerprintBlob(new Blob([f.payload])));
  expect(readBytes(f.volume)).toBe(f.payload.length);
});

it("retries a failed read without retaining a verification result", async () => {
  const f = await fixture();
  vi.spyOn(f.volume, "read").mockRejectedValueOnce(
    new Error("Read failed"),
  );
  await expect(
    f.verification.verify(f.volume, f.path, f.stat, f.file),
  ).rejects.toThrow("Read failed");
  f.volume.reads.length = 0;
  expect(
    await f.verification.verify(
      f.volume,
      f.path,
      f.stat,
      f.file,
    ),
  ).toEqual(await fingerprintBlob(new Blob([f.payload])));
  expect(readBytes(f.volume)).toBe(f.payload.length);
});
