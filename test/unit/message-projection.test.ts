import { describe, expect, it } from "vitest";
import {
  applyTrackedResponse,
  projectIncomingMessage,
  projectOutgoingMessage,
  projectRetry,
} from "@/libs/application/messaging/message-projection";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { directConversationId } from "@/libs/domain/conversation";

const peer = {
  clientId: "local",
  targetClientId: "remote",
};

describe("message projection", () => {
  it("projects outgoing text without leaking local state into the wire message", () => {
    const wire = createSessionMessage(
      peer,
      "send-text",
      { data: "hello" },
      { id: "m1", createdAt: 1 },
    );

    const stored = projectOutgoingMessage(wire);

    expect(wire).not.toHaveProperty("status");
    expect(wire).not.toHaveProperty("conversationId");
    expect(wire).not.toHaveProperty("room");
    expect(wire).not.toHaveProperty("deliveries");
    expect(stored).toEqual({
      ...wire,
      conversationId: directConversationId(
        "local",
        "remote",
      ),
      type: "text",
      status: "sending",
    });
  });

  it("projects a received request-file into the local transfer direction", () => {
    const wire = createSessionMessage(
      peer,
      "request-file",
      {
        fid: "f1",
        fileName: "a.txt",
        fileSize: 12,
        chunkSize: 4,
        resume: false,
      },
      { id: "m2", createdAt: 2 },
    );

    expect(projectIncomingMessage(wire)).toMatchObject({
      id: "m2",
      type: "file",
      status: "received",
      client: "remote",
      target: "local",
      fid: "f1",
      transferStatus: "init",
    });
  });

  it("resets a file retry without changing stable history identity", () => {
    const current = projectOutgoingMessage(
      createSessionMessage(
        peer,
        "send-file",
        {
          fid: "f1",
          fileName: "old.txt",
          fileSize: 8,
          chunkSize: 4,
        },
        { id: "m3", createdAt: 3 },
      ),
    )!;

    const retried = projectRetry(
      {
        ...current,
        status: "error",
        error: "failed",
      },
      createSessionMessage(
        peer,
        "send-file",
        {
          fid: "f2",
          fileName: "new.txt",
          fileSize: 16,
          chunkSize: 8,
        },
        { id: "m3", createdAt: 99 },
      ),
    );

    expect(retried).toMatchObject({
      id: "m3",
      createdAt: 3,
      status: "sending",
      fid: "f2",
      fileName: "new.txt",
      fileSize: 16,
      chunkSize: 8,
    });
    expect(retried?.error).toBeUndefined();
  });

  it("applies ACK and remote error only to local history state", () => {
    const current = projectOutgoingMessage(
      createSessionMessage(
        peer,
        "send-text",
        { data: "hello" },
        { id: "m4", createdAt: 4 },
      ),
    )!;

    const ack = createSessionMessage(
      { clientId: "remote", targetClientId: "local" },
      "ack",
      { mode: "receive" },
      { id: "m4", createdAt: 5 },
    );
    const received = applyTrackedResponse(current, ack);
    expect(received).toMatchObject({
      id: "m4",
      status: "received",
    });

    const error = createSessionMessage(
      { clientId: "remote", targetClientId: "local" },
      "error",
      { error: "remote failed" },
      { id: "m4", createdAt: 6 },
    );
    expect(
      applyTrackedResponse(current, error),
    ).toMatchObject({
      id: "m4",
      status: "error",
      error: "remote failed",
    });
  });
});
