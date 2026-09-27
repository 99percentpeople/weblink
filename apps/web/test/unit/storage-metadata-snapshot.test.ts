import { File } from "node:buffer";
import { createStore } from "solid-js/store";
import { describe, expect, it } from "vitest";
import type { ChunkMetaData } from "@/libs/domain/file";
import type { ContentRecord } from "@/libs/domain/file-library";
import {
  snapshotContentRecord,
  snapshotFileMetadata,
} from "@/libs/infrastructure/storage/metadata-snapshot";

function metadata(): ChunkMetaData {
  return {
    id: "file-id",
    fileName: "source.txt",
    fileSize: 7,
    fingerprint: {
      version: 1,
      algorithm: "blake3-256",
      digest: "a".repeat(64),
      size: 7,
    },
    aliases: ["alias.txt"],
    roomAttachment: true,
    roomOfferId: "offer-id",
  };
}

describe("storage metadata snapshots", () => {
  it("removes both root and nested store proxies", () => {
    const original = metadata();
    const [state] = createStore(original);
    expect(() => structuredClone({ ...state })).toThrow();
    for (const input of [state, { ...state }]) {
      expect(
        structuredClone(snapshotFileMetadata(input)),
      ).toEqual(original);
    }
  });

  it("isolates a snapshot from subsequent reactive updates", () => {
    const [state, setState] = createStore(metadata());
    const snapshot = snapshotFileMetadata(state);
    setState("fingerprint", "digest", "b".repeat(64));
    setState("aliases", 0, "changed.txt");
    setState("fileName", "changed.txt");
    expect(snapshot).toEqual(metadata());
  });

  it("does not expose mutable store data through the snapshot", () => {
    const [state] = createStore(metadata());
    const snapshot = snapshotFileMetadata(state);
    snapshot.fingerprint!.digest = "b".repeat(64);
    snapshot.aliases!.push("changed.txt");
    expect(state.fingerprint!.digest).toBe("a".repeat(64));
    expect([...state.aliases!]).toEqual(["alias.txt"]);
  });

  it("preserves native File values without JSON serialization", async () => {
    const file = new File(["content"], "source.txt", {
      type: "text/plain",
      lastModified: 123,
    });
    const [state] = createStore({ ...metadata(), file });
    const snapshot = snapshotFileMetadata(state);
    expect(snapshot.file).toBe(file);
    expect(await snapshot.file.text()).toBe("content");
    expect(snapshot.file.name).toBe("source.txt");
    expect(snapshot.file.type).toBe("text/plain");
    expect(snapshot.file.lastModified).toBe(123);
  });

  it("accepts legacy metadata without fingerprints or aliases", () => {
    const [state] = createStore({
      id: "legacy-id",
      fileName: "legacy.txt",
      fileSize: 7,
    });
    expect(
      structuredClone(snapshotFileMetadata(state)),
    ).toEqual({
      id: "legacy-id",
      fileName: "legacy.txt",
      fileSize: 7,
    });
  });

  it("snapshots reactive content records independently of later mutations", () => {
    const original: ContentRecord = {
      key: "content-key",
      fingerprint: metadata().fingerprint!,
      storageId: "storage-id",
      createdAt: 123,
      state: "pending",
      isShared: true,
      sharedReferenceId: "reference-id",
    };
    const [state, setState] = createStore(original);
    expect(() => structuredClone({ ...state })).toThrow();
    const snapshot = snapshotContentRecord({ ...state });
    expect(structuredClone(snapshot)).toEqual(original);
    setState("fingerprint", "digest", "b".repeat(64));
    setState("state", "ready");
    expect(snapshot.fingerprint.digest).toBe(
      "a".repeat(64),
    );
    expect(snapshot.state).toBe("pending");
    expect(snapshot.sharedReferenceId).toBe("reference-id");
  });
});
