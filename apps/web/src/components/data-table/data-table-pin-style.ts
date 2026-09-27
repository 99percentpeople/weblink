import { Column } from "@tanstack/solid-table";
import { JSX } from "solid-js";

export function getCommonPinningStyles<TData>(
  column: Column<TData>,
): JSX.CSSProperties {
  const isPinned = column.getIsPinned();
  const isLastLeftPinnedColumn =
    isPinned === "left" && column.getIsLastColumn("left");
  const isFirstRightPinnedColumn =
    isPinned === "right" &&
    column.getIsFirstColumn("right");

  return {
    "box-shadow": isLastLeftPinnedColumn
      ? "-5px 0 5px -5px hsl(var(--border)) inset"
      : isFirstRightPinnedColumn
        ? "5px 0 5px -5px hsl(var(--border)) inset"
        : undefined,
    left:
      isPinned === "left"
        ? `${column.getStart("left")}px`
        : undefined,
    right:
      isPinned === "right"
        ? `${column.getAfter("right")}px`
        : undefined,

    position: isPinned ? "sticky" : "relative",

    "z-index": isPinned ? 1 : 0,
  };
}
