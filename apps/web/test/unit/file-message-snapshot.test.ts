import { describe, expect, it } from "vitest";
import { createStore } from "solid-js/store";
import { snapshotStoreMessage } from "@/libs/application/messaging/message-snapshot";
import type { FileTransferMessage } from "@/libs/domain/message";

describe("file message persistence", () => {
  it("detaches content metadata from Solid proxies and excludes transient local jobs", () => {
    const [message] = createStore<FileTransferMessage>({
      id: "message",
      type: "file",
      client: "alice",
      target: "bob",
      createdAt: 1,
      fid: "attachment",
      fileName: "file",
      fileSize: 3,
      chunkSize: 2,
      status: "received",
      fingerprint: {
        version: 1,
        algorithm: "blake3-256",
        digest: "a".repeat(64),
        size: 3,
      },
      localContentPending: true,
      completionSource: "local",
    });
    const saved = structuredClone(
      snapshotStoreMessage(message),
    );
    expect(saved).toMatchObject({
      fingerprint: { algorithm: "blake3-256", size: 3 },
      completionSource: "local",
    });
    expect(
      saved.type === "file" && saved.localContentPending,
    ).toBeUndefined();
  });
});
