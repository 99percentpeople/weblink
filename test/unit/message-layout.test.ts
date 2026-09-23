import { describe, expect, it } from "vitest";
import {
  createMessageLayout,
  MESSAGE_TIME_GAP_MS,
} from "@/routes/client/[id]/components/message-layout";

const start = new Date(2026, 0, 3, 10, 0).getTime();
const message = (
  createdAt: number,
  client = "peer",
  target = "self",
) => ({
  client,
  target,
  createdAt,
});

const single = {
  timeSeparator: true,
  joinedPrevious: false,
  joinedNext: false,
};

describe("chat message grouping and time boundaries", () => {
  it("handles empty history and timestamps including epoch zero", () => {
    expect(createMessageLayout([])).toEqual([]);
    expect(createMessageLayout([message(0)])).toEqual([
      single,
    ]);
  });

  it("joins only adjacent messages from the same sender and recipient", () => {
    const layout = createMessageLayout([
      message(start),
      message(start + 1000),
      message(start + 2000),
      message(start + 3000, "self", "peer"),
      message(start + 4000, "peer"),
      message(start + 5000, "peer", "other"),
    ]);
    expect(layout).toEqual([
      { ...single, joinedNext: true },
      {
        timeSeparator: false,
        joinedPrevious: true,
        joinedNext: true,
      },
      {
        timeSeparator: false,
        joinedPrevious: true,
        joinedNext: false,
      },
      { ...single, timeSeparator: false },
      { ...single, timeSeparator: false },
      { ...single, timeSeparator: false },
    ]);
  });

  it.each([MESSAGE_TIME_GAP_MS, MESSAGE_TIME_GAP_MS + 1])(
    "inserts a time separator and ends the previous group for a %d ms gap",
    (gap) => {
      expect(
        createMessageLayout([
          message(start),
          message(start + gap),
        ]),
      ).toEqual([single, single]);
    },
  );

  it("keeps messages just below the gap threshold together", () => {
    expect(
      createMessageLayout([
        message(start),
        message(start + MESSAGE_TIME_GAP_MS - 1),
      ]),
    ).toEqual([
      { ...single, joinedNext: true },
      {
        timeSeparator: false,
        joinedPrevious: true,
        joinedNext: false,
      },
    ]);
  });

  it("shows a long-gap separator even when the sender changes", () => {
    expect(
      createMessageLayout([
        message(start),
        message(
          start + MESSAGE_TIME_GAP_MS,
          "self",
          "peer",
        ),
      ]),
    ).toEqual([single, single]);
  });

  it.each([
    [
      new Date(2026, 0, 3, 23, 59),
      new Date(2026, 0, 4, 0, 1),
    ],
    [
      new Date(2026, 11, 31, 23, 59),
      new Date(2027, 0, 1, 0, 1),
    ],
  ])(
    "starts a new time block across a local calendar boundary",
    (before, after) => {
      expect(
        createMessageLayout([
          message(before.getTime()),
          message(after.getTime()),
        ]),
      ).toEqual([single, single]);
    },
  );

  it("does not merge reversed clocks but permits equal timestamps", () => {
    expect(
      createMessageLayout([
        message(start),
        message(start - 1),
        message(start - 1),
      ]),
    ).toEqual([
      single,
      { ...single, joinedNext: true },
      {
        timeSeparator: false,
        joinedPrevious: true,
        joinedNext: false,
      },
    ]);
  });

  it("uses adjacent gaps rather than the duration of an active conversation", () => {
    const layout = createMessageLayout(
      Array.from({ length: 10 }, (_, index) =>
        message(start + index * 60000),
      ),
    );
    expect(
      layout.filter((item) => item.timeSeparator),
    ).toHaveLength(1);
    expect(
      layout.slice(1).every((item) => item.joinedPrevious),
    ).toBe(true);
  });

  it("recomputes the visible edges after prepend, deletion and append without mutating prior layouts", () => {
    const messages = Object.freeze([
      message(start),
      message(start + 1000),
      message(start + 2000),
    ]);
    const initial = createMessageLayout(messages.slice(1));
    const expanded = createMessageLayout(messages);
    expect(initial[0].timeSeparator).toBe(true);
    expect(expanded[1].timeSeparator).toBe(false);
    const deleted = createMessageLayout([
      messages[0],
      messages[2],
    ]);
    expect(deleted[0].joinedNext).toBe(true);
    expect(deleted[1].joinedPrevious).toBe(true);
    const appended = createMessageLayout([
      ...messages,
      message(start + 3000),
    ]);
    expect(appended[2].joinedNext).toBe(true);
    expect(expanded[2].joinedNext).toBe(false);
  });
});
