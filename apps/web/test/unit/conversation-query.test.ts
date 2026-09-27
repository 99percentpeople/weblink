import { describe, expect, it } from "vitest";
import {
  filterConversations,
  groupConversations,
  summarizeConversations,
} from "@/libs/application/messaging/conversation-query";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
  type ConversationLabel,
} from "@/libs/domain/conversation";
import type {
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";

const self = "local";
const directId = directConversationId(self, "alice");
const roomId = roomConversationId("service", "team");
const otherId = roomConversationId(
  "different-service",
  "team",
);
const labels: ConversationLabel[] = [
  { id: "work", name: "Work" },
  { id: "project", name: "Project" },
];
const conversations: Conversation[] = [
  {
    id: directId,
    kind: "direct",
    peerId: "alice",
    title: "Old name",
    labelIds: ["work"],
    createdAt: 1,
  },
  {
    id: roomId,
    kind: "room",
    roomId: "team",
    namespace: "service",
    title: "Team meeting",
    labelIds: ["work", "project"],
    createdAt: 2,
  },
  {
    id: otherId,
    kind: "room",
    roomId: "team",
    namespace: "different-service",
    title: "Other room",
    labelIds: [],
    createdAt: 3,
  },
];
const message = (
  id: string,
  conversationId: string,
  client = "alice",
  createdAt = 10,
): TextMessage => ({
  id,
  conversationId,
  type: "text",
  client,
  target: self,
  data: id,
  createdAt,
  ...(conversationId === directId
    ? {}
    : {
        room: {
          roomId: "team",
          senderName: "Alice",
          senderAvatar: null,
        },
      }),
});
const messages: StoreMessage[] = [
  message("Private plans", directId),
  message("Roadmap meeting", roomId),
  message("own message", roomId, self, 11),
  message("Other project", otherId),
];
const summaries = () =>
  summarizeConversations(
    conversations,
    [{ clientId: "alice", name: "Alice", avatar: null }],
    messages,
    self,
    new Set(["alice"]),
    roomId,
  );

describe("conversation queries", () => {
  it("does not count an older local identity's outgoing private history as unread", () => {
    const oldId = directConversationId(
      "former-local",
      "alice",
    );
    const oldConversation: Conversation = {
      ...conversations[0],
      id: oldId,
    };
    const result = summarizeConversations(
      [oldConversation],
      [],
      [
        {
          ...message(
            "my-old-message",
            oldId,
            "former-local",
          ),
          target: "alice",
        },
        {
          ...message("their-old-message", oldId, "alice"),
          target: "former-local",
        },
      ],
      self,
      new Set(),
      null,
    );
    expect(result[0].unread).toBe(1);
  });
  it("uses local arrival order for activity and deleted read cursors despite remote clock skew", () => {
    const conversation: Conversation = {
      ...conversations[1],
      lastReadMessageId: "deleted",
      lastReadAt: 100000,
      lastReadSequence: 2,
    };
    const history: TextMessage[] = [
      {
        ...message("already-read", roomId, "alice", 900000),
        localSequence: 1,
      },
      {
        ...message(
          "recent-private",
          directId,
          "alice",
          999999,
        ),
        localSequence: 3,
      },
      {
        ...message("new-low-clock", roomId, "alice", 1),
        localSequence: 4,
      },
    ];
    const result = summarizeConversations(
      [conversations[0], conversation],
      [],
      history,
      self,
      new Set(),
      null,
    );
    expect(
      result.map((item) => item.conversation.id),
    ).toEqual([roomId, directId]);
    expect(result[0].unread).toBe(1);
    expect(result[0].preview).toBe("new-low-clock");
  });
  it("combines search with selected labels using AND, with OR between labels", () => {
    expect(
      filterConversations(
        summaries(),
        "",
        ["project", "work"],
        "all",
        labels,
      ),
    ).toHaveLength(2);
    expect(
      filterConversations(
        summaries(),
        "Alice",
        ["project"],
        "all",
        labels,
      ),
    ).toEqual([]);
    expect(
      filterConversations(
        summaries(),
        "ALICE",
        ["project", "work"],
        "all",
        labels,
      ).map((summary) => summary.conversation.id),
    ).toEqual([directId]);
    expect(
      filterConversations(
        summaries(),
        "  Ａｌｉｃｅ  ",
        [],
        "all",
        labels,
      ).map((summary) => summary.conversation.id),
    ).toEqual([directId]);
    expect(
      filterConversations(
        summaries(),
        "Project",
        ["project"],
        "room",
        labels,
      ).map((summary) => summary.conversation.id),
    ).toEqual([roomId]);
    expect(
      filterConversations(
        summaries(),
        "private plans",
        [],
        "all",
        labels,
      ).map((summary) => summary.conversation.id),
    ).toEqual([directId]);
  });

  it("repeats a multi-label conversation in groups while leaving unread totals based on distinct summaries", () => {
    const source = summaries();
    const groups = groupConversations(source, labels);
    expect(
      groups.map((group) => [
        group.id,
        group.items.map((item) => item.conversation.id),
      ]),
    ).toEqual([
      ["work", [roomId, directId]],
      ["project", [roomId]],
      ["unlabelled", [otherId]],
    ]);
    expect(groups[0].items[0]).toBe(groups[1].items[0]);
    expect(
      source.reduce(
        (total, summary) => total + summary.unread,
        0,
      ),
    ).toBe(3);
    expect(source).toHaveLength(3);
  });

  it("isolates a member's private and room messages and identical room names on different services", () => {
    const source = summaries();
    expect(
      source.find(
        (item) => item.conversation.id === directId,
      ),
    ).toMatchObject({
      title: "Alice",
      preview: "Private plans",
      unread: 1,
      online: true,
      active: false,
    });
    expect(
      source.find(
        (item) => item.conversation.id === roomId,
      ),
    ).toMatchObject({
      preview: "own message",
      unread: 1,
      active: true,
    });
    expect(
      source.find(
        (item) => item.conversation.id === otherId,
      ),
    ).toMatchObject({
      preview: "Other project",
      unread: 1,
      online: false,
      active: false,
    });
    expect(
      filterConversations(source, "", [], "direct", labels),
    ).toHaveLength(1);
    expect(
      filterConversations(source, "", [], "room", labels),
    ).toHaveLength(2);
  });

  it("falls back to the persisted read timestamp when the read cursor message was deleted", () => {
    const conversation: Conversation = {
      ...conversations[1],
      lastReadMessageId: "removed",
      lastReadAt: 20,
    };
    const history = [
      message("earlier", roomId, "alice", 10),
      message("boundary", roomId, "alice", 20),
      message("new", roomId, "alice", 21),
      message("self", roomId, self, 22),
    ];
    const result = summarizeConversations(
      [conversation],
      [],
      history,
      self,
      new Set(),
      null,
    );
    expect(result[0].unread).toBe(1);
    expect(
      filterConversations(result, "", [], "unread", labels),
    ).toHaveLength(1);
    const allRead = summarizeConversations(
      [{ ...conversation, lastReadMessageId: "self" }],
      [],
      history,
      self,
      new Set(),
      null,
    );
    expect(
      filterConversations(
        allRead,
        "",
        [],
        "unread",
        labels,
      ),
    ).toEqual([]);
  });

  it("uses the cursor when present even when the sender's wall clock goes backward", () => {
    const conversation: Conversation = {
      ...conversations[1],
      lastReadMessageId: "read",
      lastReadAt: 100,
    };
    const result = summarizeConversations(
      [conversation],
      [],
      [
        message("read", roomId, "alice", 100),
        message("arrived-later", roomId, "alice", 90),
      ],
      self,
      new Set(),
      null,
    );
    expect(result[0].unread).toBe(1);
  });

  it("handles missing profiles, old direct records and stale label assignments without dropping conversations", () => {
    const legacy = {
      ...message("legacy", directId),
      conversationId: undefined,
    };
    const orphaned: Conversation = {
      ...conversations[0],
      labelIds: ["deleted-label"],
    };
    const source = summarizeConversations(
      [orphaned],
      [],
      [legacy],
      self,
      new Set(),
      null,
    );
    expect(source[0]).toMatchObject({
      title: "Old name",
      avatar: undefined,
      preview: "legacy",
      online: false,
    });
    expect(
      groupConversations(source, labels),
    ).toMatchObject([
      {
        id: "unlabelled",
        items: [{ conversation: { id: directId } }],
      },
    ]);
  });
});
