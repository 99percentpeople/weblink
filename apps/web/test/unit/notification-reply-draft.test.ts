// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { createRoot } from "solid-js";
import {
  appendConversationDraft,
  createConversationDraft,
} from "@/libs/hooks/conversation-draft";
beforeEach(() => sessionStorage.clear());
it("retains an unsent inline reply alongside an existing draft, including before mounting", () => {
  let dispose!: () => void;
  const draft = createRoot((cleanup) => {
    dispose = cleanup;
    return createConversationDraft("conversation");
  });
  draft.update("unfinished draft");
  appendConversationDraft(
    "conversation",
    "notification reply",
  );
  expect(draft.value()).toBe(
    "unfinished draft\nnotification reply",
  );
  draft.accepted("unfinished draft");
  expect(draft.value()).toContain("notification reply");
  dispose();
  appendConversationDraft("other", "reply before opening");
  createRoot((cleanup) => {
    const other = createConversationDraft("other");
    expect(other.value()).toBe("reply before opening");
    other.accepted("reply before opening");
    expect(other.value()).toBe("");
    cleanup();
  });
});
