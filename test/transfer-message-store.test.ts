// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { createMessageStores } from "@/libs/application/messaging/message-store";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { TransferMode } from "@/libs/core/transfer/file-transferer";
import { bindTransferMessage } from "@/libs/application/transfer/transfer-message-binding";
import {
  FakeTransfer,
  fakeCache,
  fileMessage,
  fileSession,
} from "./helpers/file-transfer";

afterEach(() => vi.unstubAllGlobals());
it("the production store resolves message identity after deletion and never resurrects a removed message", () => {
  // Keep persistence pending; this test exercises the real reactive store and event binding, not IndexedDB.
  vi.stubGlobal("indexedDB", { open: () => ({}) });
  setAppState(
    "message",
    "messages",
    reconcile([
      fileMessage("earlier"),
      fileMessage("target"),
      fileMessage("later"),
    ]),
  );
  const store = createMessageStores();
  const controller = new AbortController();
  const transferer = new FakeTransfer(
    fakeCache(),
    TransferMode.Send,
  );
  bindTransferMessage(
    {
      id: "run",
      session: fileSession(),
      fileId: "file",
      messageId: "target",
      transferer,
    },
    store,
    controller.signal,
  );
  try {
    store.deleteMessage("earlier");
    transferer.dispatchEvent("progress", {
      total: 2048,
      received: 512,
    });
    expect(appState.message.messages[0]).toMatchObject({
      id: "target",
      progress: { received: 512 },
    });
    expect(appState.message.messages[1]).not.toHaveProperty(
      "progress",
    );
    store.deleteMessage("target");
    transferer.dispatchEvent("progress", {
      total: 2048,
      received: 1024,
    });
    expect(appState.message.messages).toHaveLength(1);
    expect(appState.message.messages[0]).toMatchObject({
      id: "later",
    });
    expect(appState.message.messages[0]).not.toHaveProperty(
      "progress",
    );
  } finally {
    controller.abort();
  }
});
