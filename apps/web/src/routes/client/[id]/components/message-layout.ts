import type { StoreMessage } from "@/libs/domain/message";

/** Adjacent messages at least five minutes apart start a new time block. */
export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

type TimelineMessage = Pick<
  StoreMessage,
  "client" | "target" | "createdAt"
>;

export interface MessageLayout {
  timeSeparator: boolean;
  joinedPrevious: boolean;
  joinedNext: boolean;
}

function startsTimeBlock(
  previous: TimelineMessage | undefined,
  current: TimelineMessage,
): boolean {
  if (!previous) return true;
  const gap = current.createdAt - previous.createdAt;
  // A peer clock moving backwards must not merge unrelated time blocks.
  if (
    !Number.isFinite(gap) ||
    gap < 0 ||
    gap >= MESSAGE_TIME_GAP_MS
  )
    return true;

  const before = new Date(previous.createdAt);
  const after = new Date(current.createdAt);
  return (
    before.getFullYear() !== after.getFullYear() ||
    before.getMonth() !== after.getMonth() ||
    before.getDate() !== after.getDate()
  );
}

/** UI-only grouping; message identity, ordering and persistence stay unchanged. */
export function createMessageLayout(
  messages: readonly TimelineMessage[],
): MessageLayout[] {
  const layout: MessageLayout[] = [];
  for (const [index, message] of messages.entries()) {
    const previous = messages[index - 1];
    const timeSeparator = startsTimeBlock(
      previous,
      message,
    );
    const joinedPrevious =
      !timeSeparator &&
      previous?.client === message.client &&
      previous?.target === message.target;
    if (joinedPrevious) layout[index - 1].joinedNext = true;
    layout.push({
      timeSeparator,
      joinedPrevious,
      joinedNext: false,
    });
  }
  return layout;
}
