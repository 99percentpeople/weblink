import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createConversationMessageWindow } from "@/components/conversations/conversation-message-window";
import type { StoreMessage } from "@/libs/domain/message";

const message = (index: number): StoreMessage => ({
  id: `message-${index}`,
  type: "text",
  client: "peer",
  target: "self",
  data: String(index),
  createdAt: index,
  status: "received",
});

describe("conversation message window", () => {
  it("uses one stable 40/20 history window for append, prepend and reveal", () => {
    createRoot((dispose) => {
      const [ready, setReady] = createSignal(false);
      const [messages, setMessages] = createSignal(
        Array.from({ length: 80 }, (_, index) =>
          message(index),
        ),
      );
      const window = createConversationMessageWindow({
        ready,
        messages,
      });

      expect(window.messages()).toEqual([]);
      setReady(true);
      expect(window.messages()).toHaveLength(40);
      expect(window.messages()[0].id).toBe("message-40");
      expect(window.hasEarlier()).toBe(true);

      window.loadEarlier();
      expect(window.messages()).toHaveLength(60);
      expect(window.messages()[0].id).toBe("message-20");

      setMessages((current) => [
        ...current,
        message(80),
        message(81),
      ]);
      expect(window.messages()).toHaveLength(62);
      expect(window.messages()[0].id).toBe("message-20");
      expect(window.appendRevision()).toBe(1);
      expect([...window.animatedIds()]).toEqual([
        "message-80",
        "message-81",
      ]);

      expect(window.missingFor("message-5")).toBe(15);
      window.loadEarlier(window.missingFor("message-5"));
      expect(window.messages()[0].id).toBe("message-5");
      expect(window.missingFor("message-5")).toBe(0);

      dispose();
    });
  });

  it("does not treat a removed last message as a new append", () => {
    createRoot((dispose) => {
      const [messages, setMessages] = createSignal(
        Array.from({ length: 50 }, (_, index) =>
          message(index),
        ),
      );
      const window = createConversationMessageWindow({
        ready: () => true,
        messages,
      });
      expect(window.messages()).toHaveLength(40);
      expect(window.appendRevision()).toBe(0);

      setMessages((current) => current.slice(0, -1));
      expect(window.messages()).toHaveLength(40);
      expect(window.appendRevision()).toBe(0);
      expect(window.messages().at(-1)?.id).toBe(
        "message-48",
      );

      dispose();
    });
  });
});
